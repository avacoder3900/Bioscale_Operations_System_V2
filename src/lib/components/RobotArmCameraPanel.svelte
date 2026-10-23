<script lang="ts">
	/**
	 * ARM-02 — live view of a camera mounted on the robot arm.
	 *
	 * Mounted in the arm +layout.svelte, so the SvelteKit layout instance (and
	 * therefore this component and its polling loop) survives navigation
	 * between the Control / Jog / Calibrate / Runs tabs. Switching tabs does
	 * not restart the feed.
	 *
	 * Two transports, negotiated once per mount:
	 *
	 *   proxy  — snapshot-polling through a BIMS route. Works for any viewer
	 *            that can reach BIMS, including a phone on cellular with no
	 *            tailnet. This is the floor, and it is never removed.
	 *   direct — frames PULLED straight from the Pi, one in flight at a time:
	 *            fetch snapshot.jpg, show it, ask for the next. Same method as
	 *            the CV stations' live view (post-mortem-inspect, 2026-10-14).
	 *            Requires the viewer to reach one of the Pi's origins.
	 *
	 * Why pull and not the MJPEG stream (2026-10-20, measured at 720p): the Pi
	 * pushed ~11 Mbit/s, the Cloudflare tunnel carried ~2.7, and the unsent
	 * frames queued in sockets and proxies. A browser cannot skip ahead in a
	 * multipart stream, so the view fell seconds behind. Pulling drops frames
	 * instead of queuing them, so lag is bounded at about one round trip.
	 * Live frames ask the Pi for a lighter re-encode (?q=&w=); Save and
	 * AprilTag detection still get full quality.
	 *
	 * Origins are raced: the Pi's Tailscale name (peer-to-peer for a viewer
	 * on the tailnet, ~0.1 s/frame) and its Cloudflare tunnel (~0.6 s). The
	 * first to answer wins, so tailnet viewers get the fast route and
	 * everyone else still gets a picture.
	 *
	 * Direct is attempted, not assumed: we probe first and fall back to proxy
	 * on any failure, including later ones. A feed that quietly degrades to
	 * stills is a much better outcome than a feed that stops.
	 *
	 * In both modes frames are preloaded into a detached Image before being
	 * swapped in, so a slow or failed frame leaves the previous one on screen
	 * instead of flashing an empty box.
	 */
	import { untrack } from 'svelte';
	import type { CameraStatus } from '$lib/server/robot-arm-client';
	import RotatedFrame from '$lib/components/robot-arm/RotatedFrame.svelte';
	import { cameraRotation } from '$lib/robot-arm/camera-rotation.svelte';
	import TorqueControl from './robot-arm/TorqueControl.svelte';
	import PiThermalChip from './robot-arm/PiThermalChip.svelte';
	import type { ArmThermal } from '$lib/server/robot-arm-client';

	interface Props {
		cameras: CameraStatus[];
		camerasError: string | null;
		armReachable: boolean;
		/** The Pi's temperature / throttle state at page load; the chip polls from there. */
		thermal?: ArmThermal | null;
	}

	let { cameras, camerasError, armReachable, thermal = null }: Props = $props();

	// Deliberately not `as const`: these are compared against and bound to
	// values that arrive as plain number/string from localStorage and <select>,
	// and a literal-union type here only produces cast noise at every use site.
	// Proxy stays at <= 10 fps: every proxied frame is a Vercel invocation.
	// Direct mode's choice is a cap on the pull loop; the link sets the real
	// rate (one frame in flight), and frames never touch BIMS.
	const FPS_OPTIONS: number[] = [1, 5, 10];
	const DIRECT_FPS_OPTIONS: number[] = [5, 10, 15, 30];
	const SIZES = { S: 320, M: 480, L: 640 };
	type SizeKey = keyof typeof SIZES;
	const SIZE_KEYS = Object.keys(SIZES) as SizeKey[];
	// Pixels requested from the Pi, separate from the size drawn on screen.
	// 'fit' = just enough for the drawn size (times pixel ratio): light frames
	// for a live glance. 'full' = the camera's whole frame (1920x1080 at the
	// stored quality 80, ~140 KB vs ~27 KB) at the same drawn size, so zooming
	// in or going fullscreen shows real pixels (Alejandro, 2026-10-23: "I
	// definitely want it to be full resolution when zooming in").
	const RESOLUTIONS = { fit: 'fit', full: 'full' } as const;
	type ResolutionKey = keyof typeof RESOLUTIONS;
	const STORAGE_KEY = 'bims.armCamera.v1';

	// A frame older than this is called out. The Pi has its own staleness
	// notion (cameras.py _STALE_AFTER_S) but that is a load-time snapshot;
	// once we are polling, what matters is whether *we* are still getting
	// frames. A frozen image that reads as live is the dangerous failure here.
	const STALE_AFTER_MS = 3000;

	// Direct-mode live frames: a lighter JPEG than the stored one, sized to
	// what is on screen (the CV stations use q75 for the same reason).
	const LIVE_Q = 70;
	// Consecutive failed direct frames before giving up on the route.
	const DIRECT_MAX_FAILURES = 6;
	const DIRECT_FRAME_TIMEOUT_MS = 6000;

	// Resolved by the reconcile effect below, never seeded from `cameras` here:
	// a one-shot seed captures an empty list on first paint and never recovers.
	let selected = $state('');
	let fps = $state<number>(5);
	let directFps = $state<number>(30);
	let size = $state<SizeKey>('M');
	let resolution = $state<ResolutionKey>('fit');
	let collapsed = $state(false);
	let paused = $state(false);

	let displaySrc = $state<string | null>(null);
	let frameCount = $state(0);
	let lastFrameAt = $state<number | null>(null);
	let failures = $state(0);
	let now = $state(Date.now());
	let tabVisible = $state(true);
	let panelEl = $state<HTMLElement | null>(null);

	// --- transport ---------------------------------------------------------
	// Starts at 'proxy' so the feed works before negotiation finishes, and so
	// every failure path has somewhere safe to land.
	let transport = $state<'proxy' | 'direct'>('proxy');
	let cred = $state<{ origin: string; token: string; expiresAt: number } | null>(null);
	// Which raced origin won, for the health strip.
	let route = $state<'tailnet' | 'tunnel' | 'public' | null>(null);
	// Recent frame times, for a measured (not requested) frame rate.
	let frameTimes: number[] = [];
	let measuredFps = $state<number | null>(null);
	let isFullscreen = $state(false);
	// Plain variable, not $state, on purpose: this is control flow for an
	// effect that also reads it, and a reactive flag there re-triggers the very
	// effect that sets it.
	let negotiated = false;

	let selectedStatus = $derived(cameras.find((c) => c.name === selected) ?? null);
	let running = $derived(paused || collapsed ? false : tabVisible && !!selected);
	// Only meaningful while we are actually asking for frames. A deliberately
	// paused feed is not stale, and labelling it "stale" would train the
	// operator to ignore the one warning that matters.
	// Both transports now see every frame land, so one client-side clock covers both.
	let stale = $derived(running && lastFrameAt !== null && now - lastFrameAt > STALE_AFTER_MS);
	let reconnecting = $derived(failures > 0);

	// Server-reported geometry, e.g. [480, 640, 3] -> "640x480".
	let reportedSize = $derived(
		selectedStatus?.actual_size && selectedStatus.actual_size.length >= 2
			? `${selectedStatus.actual_size[1]}x${selectedStatus.actual_size[0]}`
			: selectedStatus
				? `${selectedStatus.requested.width}x${selectedStatus.requested.height}`
				: null
	);

	// Frame geometry for the rotated viewport. The <img>'s own decoded size is
	// the truth (it follows a hardware.yaml change at once); the Pi's report
	// covers the gap before the first frame, and an MJPEG stream whose load
	// event never fires.
	let naturalSize = $state<[number, number] | null>(null);
	let frameDims = $derived.by((): [number, number] => {
		if (naturalSize) return naturalSize;
		const a = selectedStatus?.actual_size;
		if (a && a.length >= 2) return [a[1], a[0]];
		if (selectedStatus) return [selectedStatus.requested.width, selectedStatus.requested.height];
		return [4, 3];
	});
	let quarterTurn = $derived(cameraRotation.deg === 90 || cameraRotation.deg === 270);
	// The size menu sets the picture's long edge, so a camera on its side
	// does not come out ~1.8x taller than the same size upright.
	let viewportMaxWidth = $derived(
		quarterTurn ? Math.round((SIZES[size] * frameDims[1]) / frameDims[0]) : SIZES[size]
	);

	$effect(() => cameraRotation.restore());
	// Another camera has its own geometry; wait for its first frame.
	$effect(() => {
		void selected;
		naturalSize = null;
	});

	function preload(url: string, timeoutMs?: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const img = new Image();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const done = (fn: () => void) => {
				if (timer) clearTimeout(timer);
				fn();
			};
			img.onload = () => done(resolve);
			img.onerror = () => done(() => reject(new Error('frame load failed')));
			if (timeoutMs) {
				// An origin that black-holes packets never fires either event, so
				// without this a probe against an unreachable Pi hangs forever and
				// the fallback never happens. Clearing src aborts the request.
				timer = setTimeout(() => {
					img.src = '';
					reject(new Error('timed out'));
				}, timeoutMs);
			}
			img.src = url;
		});
	}

	// --- persistence ------------------------------------------------------
	// Restore once. This effect tracks `cameras`, which changes identity on
	// every layout invalidation; without the guard a background data refresh
	// would silently yank the operator's current camera back to the saved one.
	let restored = false;
	let savedSelected: string | null = null;
	$effect(() => {
		if (restored) return;
		restored = true;
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			if (!raw) return;
			const saved = JSON.parse(raw);
			if (typeof saved.fps === 'number' && FPS_OPTIONS.includes(saved.fps)) fps = saved.fps;
			if (typeof saved.directFps === 'number' && DIRECT_FPS_OPTIONS.includes(saved.directFps)) {
				directFps = saved.directFps;
			}
			if (saved.size in SIZES) size = saved.size;
			if (saved.resolution in RESOLUTIONS) resolution = saved.resolution;
			if (typeof saved.collapsed === 'boolean') collapsed = saved.collapsed;
			// Remembered, not applied: the camera list may still be empty at this
			// point. The reconcile effect applies it once we know what exists.
			if (typeof saved.selected === 'string') savedSelected = saved.selected;
		} catch {
			// A corrupt preference must never stop the feed rendering.
		}
	});

	// Keep the selection pointing at a camera that actually exists. Stays
	// reactive on `cameras` on purpose: the list can arrive empty on first
	// paint (Pi unreachable, or populated by a later invalidate), and it can
	// lose a camera the operator was watching. Both cases must self-heal
	// rather than leave a blank panel next to a populated dropdown.
	$effect(() => {
		if (cameras.length === 0) return;
		const current = untrack(() => selected);
		if (cameras.some((c) => c.name === current)) return;
		const preferred =
			savedSelected && cameras.some((c) => c.name === savedSelected) ? savedSelected : null;
		selected = preferred ?? cameras[0].name;
	});

	$effect(() => {
		const snapshot = JSON.stringify({ fps, directFps, size, resolution, collapsed, selected });
		try {
			localStorage.setItem(STORAGE_KEY, snapshot);
		} catch {
			// Private mode / quota. Preferences are a nicety, not a requirement.
		}
	});

	// --- pause when the tab is backgrounded --------------------------------
	$effect(() => {
		const onVis = () => (tabVisible = document.visibilityState === 'visible');
		document.addEventListener('visibilitychange', onVis);
		onVis();
		return () => document.removeEventListener('visibilitychange', onVis);
	});

	// --- clock, only while something is on screen --------------------------
	$effect(() => {
		if (collapsed) return;
		const id = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(id);
	});

	// --- transport negotiation ----------------------------------------------
	// Runs once per mount, the first time a camera is actually being watched.
	// Deliberately not retried: a viewer who joins the tailnet mid-session keeps
	// the working proxy feed until reload, which is a far better failure than
	// re-probing an unreachable host every few seconds forever.
	$effect(() => {
		const name = selected;
		if (!name || !running || negotiated) return;
		negotiated = true;

		let cancelled = false;
		(async () => {
			// Measured on a real load: the first attempt lost to a cold connection
			// and fell back, and only a later remount reached direct — so the
			// operator got the good feed by accident, not by design. The origin
			// itself answers this probe in ~25ms once warm, so the budget was
			// never about the server; it was about TLS setup and DNS on the very
			// first request. Hence a wider timeout plus a couple of retries.
			//
			// Retrying is safe precisely because it is not load-bearing: proxy is
			// already streaming throughout, so a slow probe costs nothing but a
			// few seconds of stills. Still bounded — an unreachable host must not
			// be re-probed forever.
			const PROBE_TIMEOUT_MS = 8000;
			const ATTEMPTS = 3;

			for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
				if (cancelled) return;
				try {
					const res = await fetch('/api/robot-arm/cameras/stream-url');
					if (!res.ok || cancelled) return;
					const body = await res.json();
					// available:false is a settled answer (no public origin
					// configured, or the Pi cannot mint) — retrying cannot change
					// it, so stop rather than burn attempts.
					if (cancelled || !body?.available || !body.token) return;
					const origins: string[] = Array.isArray(body.origins)
						? body.origins.map(String)
						: body.origin
							? [String(body.origin)]
							: [];
					if (!origins.length) return;
					const token = String(body.token);

					// Race every origin with one small live frame; the first to
					// load wins. On the tailnet the Pi's ts.net name answers in
					// ~0.1 s and beats the tunnel; off it, the tunnel answers and
					// the ts.net probe just loses (or fails) in the background.
					const origin = await Promise.any(
						origins.map((o) =>
							preload(liveFrameUrl(o, name, token), PROBE_TIMEOUT_MS).then(() => o)
						)
					);
					if (cancelled) return;

					cred = {
						origin,
						token,
						expiresAt: Date.now() + Number(body.expiresInS ?? 900) * 1000
					};
					route = routeOf(origin);
					transport = 'direct';
					// Client-side frame stats describe the polling loop and mean
					// nothing for a streamed connection. Clear them rather than
					// leaving a frozen count that looks like a stalled feed.
					frameCount = 0;
					lastFrameAt = null;
					failures = 0;
					frameTimes = [];
					measuredFps = null;
					return;
				} catch {
					// Unreachable, blocked, slow, or an expired token. Never log the
					// failure: the URL carries the credential. Mint a fresh token on
					// the next pass rather than reusing one that may have been the
					// problem.
					if (cancelled || attempt === ATTEMPTS) return;
					await new Promise((r) => setTimeout(r, 1500 * attempt));
				}
			}
		})();

		return () => {
			cancelled = true;
		};
	});

	// --- direct mode: pull one frame at a time --------------------------------
	function routeOf(origin: string): 'tailnet' | 'tunnel' | 'public' {
		if (/\.ts\.net$/.test(origin)) return 'tailnet';
		if (/\.trycloudflare\.com$/.test(origin)) return 'tunnel';
		return 'public';
	}

	// The frame's own width is SIZES[size] on screen, rotated or not (see
	// viewportMaxWidth), times the display's pixel density. Fullscreen and
	// resolution 'full' get the whole frame. A Pi build without q/w ignores them.
	function liveWidth(): number | null {
		if (isFullscreen || resolution === 'full') return null;
		const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
		return Math.max(320, Math.min(1920, Math.round(SIZES[size] * dpr)));
	}

	function liveFrameUrl(origin: string, name: string, token: string): string {
		const w = liveWidth();
		// No q/w at all for the full frame: the Pi then serves the JPEG it
		// already holds for that frame (quality 80, shared by every viewer and
		// by Save), so 'full' costs the Pi nothing extra to encode.
		const sizing = w ? `&q=${LIVE_Q}&w=${w}` : '';
		return (
			`${origin}/cameras/${encodeURIComponent(name)}/snapshot.jpg` +
			`?token=${encodeURIComponent(token)}${sizing}&t=${Date.now()}`
		);
	}

	// Full-quality still for Save (no q/w), whichever transport is live.
	let saveHref = $derived(
		transport === 'direct' && cred && selected
			? `${cred.origin}/cameras/${encodeURIComponent(selected)}/snapshot.jpg?token=${encodeURIComponent(cred.token)}`
			: displaySrc
	);

	function noteFrame() {
		const t = Date.now();
		frameCount += 1;
		lastFrameAt = t;
		frameTimes.push(t);
		if (frameTimes.length > 20) frameTimes.shift();
		measuredFps =
			frameTimes.length >= 2
				? Math.round(((frameTimes.length - 1) * 10000) / (t - frameTimes[0])) / 10
				: null;
	}

	// Re-mint before the camera token runs out (the Pi's default is 15 min),
	// keeping the origin that won the race as long as it is still offered.
	async function refreshToken(): Promise<boolean> {
		try {
			const res = await fetch('/api/robot-arm/cameras/stream-url');
			if (!res.ok) return false;
			const body = await res.json();
			const c = untrack(() => cred);
			if (!body?.available || !body.token || !c) return false;
			const offered: string[] = Array.isArray(body.origins)
				? body.origins.map(String)
				: [String(body.origin)];
			if (!offered.includes(c.origin)) return false;
			cred = {
				origin: c.origin,
				token: String(body.token),
				expiresAt: Date.now() + Number(body.expiresInS ?? 900) * 1000
			};
			return true;
		} catch {
			return false;
		}
	}

	$effect(() => {
		const name = selected;
		const active = running;
		const minInterval = 1000 / directFps;
		if (transport !== 'direct' || !name || !active) return;

		let cancelled = false;
		let timer: ReturnType<typeof setTimeout>;
		// Local on purpose, as in the proxy loop: reading reactive state in
		// here would re-run this effect for every frame it shows.
		let localFailures = 0;

		async function tick() {
			if (cancelled) return;
			const before = untrack(() => cred);
			if (!before) return;
			if (before.expiresAt - Date.now() < 60_000) await refreshToken();
			const c = untrack(() => cred);
			if (cancelled || !c) return;
			const t0 = Date.now();
			const url = liveFrameUrl(c.origin, name, c.token);
			try {
				await preload(url, DIRECT_FRAME_TIMEOUT_MS);
				if (cancelled) return;
				displaySrc = url;
				noteFrame();
				localFailures = 0;
				failures = 0;
			} catch {
				if (cancelled) return;
				localFailures += 1;
				failures = localFailures;
				// The usual quiet cause is an aged-out token: re-mint once early.
				if (localFailures === 2) await refreshToken();
				if (localFailures >= DIRECT_MAX_FAILURES) {
					fallBackToProxy();
					return;
				}
			}
			// One frame in flight; the next request starts when this one lands,
			// no sooner than the fps cap allows. Back off on failure.
			const delay =
				localFailures > 0
					? Math.min(500 * localFailures, 3000)
					: Math.max(0, minInterval - (Date.now() - t0));
			timer = setTimeout(tick, delay);
		}

		tick();
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	});

	function fallBackToProxy() {
		if (transport !== 'direct') return;
		transport = 'proxy';
		cred = null;
		route = null;
		measuredFps = null;
		frameTimes = [];
	}

	// Frames are preloaded before display, so an <img> error here means the
	// route itself broke; go back to the transport that always works.
	function handleStreamError() {
		fallBackToProxy();
	}

	$effect(() => {
		const onFs = () => (isFullscreen = !!document.fullscreenElement);
		document.addEventListener('fullscreenchange', onFs);
		return () => document.removeEventListener('fullscreenchange', onFs);
	});

	// --- the polling loop ---------------------------------------------------
	$effect(() => {
		const name = selected;
		const interval = 1000 / fps;
		const active = running;
		if (!name || !active || transport !== 'proxy') return;

		let cancelled = false;
		let timer: ReturnType<typeof setTimeout>;
		// Loop control is intentionally local, not $state: reading reactive
		// state inside the loop would make the effect re-subscribe to values it
		// writes, and re-entrant polling loops are how you DoS your own Pi.
		let localFailures = 0;

		async function tick() {
			if (cancelled) return;
			const url = `/api/robot-arm/cameras/${encodeURIComponent(name)}/snapshot?t=${Date.now()}`;
			try {
				await preload(url);
				if (cancelled) return;
				displaySrc = url;
				noteFrame();
				localFailures = 0;
				failures = 0;
			} catch {
				if (cancelled) return;
				localFailures += 1;
				failures = localFailures;
			}
			// Back off on failure rather than hammering an unreachable Pi.
			const delay =
				localFailures > 0 ? Math.min(1000 * localFailures, 5000) : interval;
			timer = setTimeout(tick, delay);
		}

		tick();
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	});

	function toggleFullscreen() {
		if (!panelEl) return;
		if (document.fullscreenElement) document.exitFullscreen();
		else panelEl.requestFullscreen?.();
	}
</script>

<section
	bind:this={panelEl}
	class="rounded-lg border"
	style="border-color: var(--color-tron-border); background: var(--color-tron-surface)"
>
	<!-- Header: always visible, so a collapsed panel still reports health.
	     Three lines: ARM CAMERA + status; Pi heat and Wi-Fi; servo temperatures. -->
	<div class="space-y-1.5 px-3 py-2">
	<div class="flex items-center justify-between gap-2">
		<div class="flex items-center gap-2 min-w-0">
			<svg
				class="h-4 w-4 shrink-0"
				fill="none"
				viewBox="0 0 24 24"
				stroke="currentColor"
				style="color: var(--color-tron-cyan)"
			>
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width="2"
					d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
				/>
			</svg>
			<span
				class="truncate text-xs font-bold uppercase tracking-wider"
				style="color: var(--color-tron-text-secondary)"
			>
				Arm Camera
			</span>
			{#if reconnecting}
				<span class="h-2 w-2 shrink-0 rounded-full bg-red-500" title="Reconnecting"></span>
			{:else if stale}
				<span class="h-2 w-2 shrink-0 rounded-full bg-amber-500" title="Stale"></span>
			{:else if !collapsed && running && displaySrc}
				<span class="h-2 w-2 shrink-0 rounded-full bg-green-500" title="Live"></span>
			{:else if !collapsed}
				<span
					class="h-2 w-2 shrink-0 rounded-full"
					style="background: var(--color-tron-text-secondary)"
					title="Paused"
				></span>
			{/if}
		</div>
		<button
			type="button"
			onclick={() => (collapsed = !collapsed)}
			class="rounded px-2 py-1 text-xs transition-colors hover:bg-black/20"
			style="color: var(--color-tron-text-secondary)"
			aria-expanded={!collapsed}
		>
			{collapsed ? 'Show' : 'Hide'}
		</button>
	</div>
	<!-- Pi heat / Wi-Fi, then servo temperatures, each on its own line: visible on every arm tab, collapsed or not. -->
	<PiThermalChip initial={thermal} {armReachable} />
	</div>

	<!-- Torque on/off follows the operator to every tab; visible even when the picture is collapsed. -->
	<TorqueControl {armReachable} />

	{#if !collapsed}
		<div class="px-3 pb-3">
			{#if !armReachable}
				<div
					class="rounded border border-red-500/40 bg-red-500/10 p-3 text-xs"
					style="color: var(--color-tron-text)"
				>
					Arm unreachable — no camera. Check <code>ROBOT_ARM_BASE_URL</code>.
				</div>
			{:else if camerasError}
				<div
					class="rounded border border-red-500/40 bg-red-500/10 p-3 text-xs"
					style="color: var(--color-tron-text)"
				>
					Could not list cameras: {camerasError}
				</div>
			{:else if cameras.length === 0}
				<div
					class="rounded border p-3 text-xs"
					style="border-color: var(--color-tron-border); color: var(--color-tron-text-secondary)"
				>
					No cameras configured on the Pi. Check the <code>cameras:</code> block in
					<code>hardware.yaml</code>.
				</div>
			{:else}
				<!-- Viewport -->
				<div
					class="relative overflow-hidden rounded border bg-black"
					style="border-color: var(--color-tron-border); max-width: {viewportMaxWidth}px"
				>
					{#if displaySrc}
						<RotatedFrame width={frameDims[0]} height={frameDims[1]} rotation={cameraRotation.deg}>
							<!--
								No crossorigin attribute: an <img> may load cross-origin
								without CORS, and asking for it here would require the Pi
								to send headers it does not, breaking direct mode outright.
								We only display these pixels, never read them back.
							-->
							<img
								src={displaySrc}
								alt="Live view from arm camera {selected}"
								class="block h-full w-full object-fill transition-opacity"
								class:opacity-40={stale || reconnecting}
								referrerpolicy="no-referrer"
								onload={(e) => {
									const img = e.currentTarget as HTMLImageElement;
									if (img.naturalWidth && img.naturalHeight) {
										naturalSize = [img.naturalWidth, img.naturalHeight];
									}
								}}
								onerror={handleStreamError}
							/>
						</RotatedFrame>
					{:else}
						<div
							class="flex aspect-[4/3] w-full items-center justify-center text-xs"
							style="color: var(--color-tron-text-secondary)"
						>
							{#if paused}
								Paused
							{:else if !tabVisible}
								Paused — tab in background
							{:else}
								Connecting…
							{/if}
						</div>
					{/if}

					{#if reconnecting}
						<div
							class="absolute inset-x-0 bottom-0 bg-red-600/80 px-2 py-1 text-center text-[11px] text-white"
						>
							Reconnecting… {failures} failed frame{failures === 1 ? '' : 's'}
						</div>
					{:else if stale}
						<div
							class="absolute inset-x-0 bottom-0 bg-amber-600/80 px-2 py-1 text-center text-[11px] text-white"
						>
							No new frame for {Math.round((now - (lastFrameAt ?? now)) / 1000)}s
						</div>
					{:else if displaySrc && !running}
						<!-- A frozen frame with no label is indistinguishable from a
						     live one. Always say why it stopped. -->
						<div
							class="absolute inset-x-0 bottom-0 bg-black/70 px-2 py-1 text-center text-[11px] text-white"
						>
							{paused ? 'Paused' : 'Paused — tab in background'}
						</div>
					{/if}
				</div>

				<!-- Pi-reported error, verbatim -->
				{#if selectedStatus?.error}
					<div class="mt-2 rounded border border-red-500/40 bg-red-500/10 p-2 text-[11px] text-red-300">
						{selectedStatus.error}
					</div>
				{/if}

				{#if selectedStatus && !selectedStatus.running && frameCount === 0}
					<p class="mt-2 text-[11px]" style="color: var(--color-tron-text-secondary)">
						{#if selectedStatus.state === 'absent'}
							No colour camera found on the Pi (nothing matches the configured device).
						{:else if selectedStatus.state === 'error' && selectedStatus.error}
							Camera worker stopped: {selectedStatus.error}
						{:else}
							Camera worker was idle at page load{selectedStatus.device ? ` (${selectedStatus.device})` : ''}. Requesting frames starts it — give it a moment.
						{/if}
					</p>
				{/if}

				<!-- Controls -->
				<div class="mt-2 flex flex-wrap items-center gap-2 text-xs">
					{#if cameras.length > 1}
						<select
							bind:value={selected}
							class="rounded border px-2 py-1"
							style="border-color: var(--color-tron-border); background: var(--color-tron-bg); color: var(--color-tron-text)"
							aria-label="Camera"
						>
							{#each cameras as cam (cam.name)}
								<option value={cam.name}>{cam.name}</option>
							{/each}
						</select>
					{:else}
						<span style="color: var(--color-tron-text-secondary)">{selected}</span>
					{/if}

					<!--
						Two rates, one per transport: proxy polls through BIMS (max 10),
						direct asks the Pi to cap its stream (up to 30). Changing the
						direct rate reopens the stream with the new cap.
					-->
					{#if transport === 'direct'}
						<select
							bind:value={directFps}
							title="Most frames per second to pull straight from the Pi (the connection may allow fewer)"
							class="rounded border px-2 py-1"
							style="border-color: var(--color-tron-border); background: var(--color-tron-bg); color: var(--color-tron-text)"
							aria-label="Frame rate"
						>
							{#each DIRECT_FPS_OPTIONS as option (option)}
								<option value={option}>{option} fps</option>
							{/each}
						</select>
					{:else}
						<select
							bind:value={fps}
							title="How often BIMS fetches a new frame (direct streaming allows up to 30 fps)"
							class="rounded border px-2 py-1"
							style="border-color: var(--color-tron-border); background: var(--color-tron-bg); color: var(--color-tron-text)"
							aria-label="Frame rate"
						>
							{#each FPS_OPTIONS as option (option)}
								<option value={option}>{option} fps</option>
							{/each}
						</select>
					{/if}

					<select
						bind:value={size}
						title="How large the picture is drawn"
						class="rounded border px-2 py-1"
						style="border-color: var(--color-tron-border); background: var(--color-tron-bg); color: var(--color-tron-text)"
						aria-label="Size"
					>
						{#each SIZE_KEYS as key (key)}
							<option value={key}>{key}</option>
						{/each}
					</select>

					<select
						bind:value={resolution}
						title="Pixels fetched from the camera. fit = enough for the drawn size (light frames). full = the whole 1920x1080 frame at the same drawn size, about 5x the bandwidth, so zooming in or fullscreen shows real pixels. No extra work for the Pi either way."
						class="rounded border px-2 py-1"
						style="border-color: var(--color-tron-border); background: var(--color-tron-bg); color: {resolution === 'full' ? 'var(--color-tron-cyan)' : 'var(--color-tron-text)'}"
						aria-label="Resolution"
					>
						<option value="fit">fit</option>
						<option value="full">full res</option>
					</select>

					<!-- View-only: detection and coordinates keep the camera's own orientation. -->
					<span class="inline-flex items-center gap-1">
						<button
							type="button"
							onclick={cameraRotation.left}
							title="Rotate the view 90° left"
							aria-label="Rotate the view 90 degrees left"
							class="rounded border px-2 py-1 transition-colors hover:bg-black/20"
							style="border-color: var(--color-tron-border); color: var(--color-tron-cyan)"
						>
							⟲
						</button>
						<button
							type="button"
							onclick={cameraRotation.right}
							title="Rotate the view 90° right"
							aria-label="Rotate the view 90 degrees right"
							class="rounded border px-2 py-1 transition-colors hover:bg-black/20"
							style="border-color: var(--color-tron-border); color: var(--color-tron-cyan)"
						>
							⟳
						</button>
						{#if cameraRotation.deg !== 0}
							<button
								type="button"
								onclick={cameraRotation.reset}
								title="Back to the camera's own orientation"
								class="rounded px-1 py-1 transition-colors hover:bg-black/20"
								style="color: var(--color-tron-text-secondary)"
							>
								{cameraRotation.deg}°
							</button>
						{/if}
					</span>

					<button
						type="button"
						onclick={() => (paused = !paused)}
						class="rounded border px-2 py-1 transition-colors hover:bg-black/20"
						style="border-color: var(--color-tron-border); color: var(--color-tron-cyan)"
					>
						{paused ? 'Resume' : 'Pause'}
					</button>

					{#if saveHref}
						<a
							href={saveHref}
							download="arm-{selected}-{new Date().toISOString().replace(/[:.]/g, '-')}.jpg"
							class="rounded border px-2 py-1 transition-colors hover:bg-black/20"
							style="border-color: var(--color-tron-border); color: var(--color-tron-cyan)"
						>
							Save
						</a>
					{/if}

					<button
						type="button"
						onclick={toggleFullscreen}
						class="rounded border px-2 py-1 transition-colors hover:bg-black/20"
						style="border-color: var(--color-tron-border); color: var(--color-tron-cyan)"
					>
						Full
					</button>
				</div>

				<!-- Health strip: real numbers, no reassuring fiction -->
				<div class="mt-2 text-[11px]" style="color: var(--color-tron-text-secondary)">
					{#if reportedSize}{reportedSize} · {/if}
					{#if transport === 'direct'}
						direct from the Pi ({route === 'tailnet' ? 'Tailscale' : route === 'tunnel' ? 'Cloudflare tunnel' : 'public'})
						· {measuredFps ?? '…'} fps of max {directFps}
					{:else}
						{frameCount} frame{frameCount === 1 ? '' : 's'} via BIMS{#if measuredFps}
							· {measuredFps} fps{/if}
					{/if}
					{#if selectedStatus}
						· requested {selectedStatus.requested.fps} fps q{selectedStatus.requested.quality}
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</section>
