<script lang="ts">
	/**
	 * ARM-02 — live view of a camera mounted on the robot arm.
	 *
	 * Mounted in the arm +layout.svelte, so the SvelteKit layout instance (and
	 * therefore this component and its polling loop) survives navigation
	 * between the Control / Jog / Calibrate / Runs tabs. Switching tabs does
	 * not restart the feed.
	 *
	 * Transport is snapshot-polling against a BIMS proxy route, not the Pi's
	 * MJPEG stream — see the route for why. Frames are preloaded into a
	 * detached Image before being swapped in, so a slow or failed frame leaves
	 * the previous one on screen instead of flashing an empty box.
	 */
	import { untrack } from 'svelte';
	import type { CameraStatus } from '$lib/server/robot-arm-client';

	interface Props {
		cameras: CameraStatus[];
		camerasError: string | null;
		armReachable: boolean;
	}

	let { cameras, camerasError, armReachable }: Props = $props();

	// Deliberately not `as const`: these are compared against and bound to
	// values that arrive as plain number/string from localStorage and <select>,
	// and a literal-union type here only produces cast noise at every use site.
	const FPS_OPTIONS: number[] = [1, 5, 10];
	const SIZES = { S: 320, M: 480, L: 640 };
	type SizeKey = keyof typeof SIZES;
	const SIZE_KEYS = Object.keys(SIZES) as SizeKey[];
	const STORAGE_KEY = 'bims.armCamera.v1';

	// A frame older than this is called out. The Pi has its own staleness
	// notion (cameras.py _STALE_AFTER_S) but that is a load-time snapshot;
	// once we are polling, what matters is whether *we* are still getting
	// frames. A frozen image that reads as live is the dangerous failure here.
	const STALE_AFTER_MS = 3000;

	// Resolved by the reconcile effect below, never seeded from `cameras` here:
	// a one-shot seed captures an empty list on first paint and never recovers.
	let selected = $state('');
	let fps = $state<number>(5);
	let size = $state<SizeKey>('M');
	let collapsed = $state(false);
	let paused = $state(false);

	let displaySrc = $state<string | null>(null);
	let frameCount = $state(0);
	let lastFrameAt = $state<number | null>(null);
	let failures = $state(0);
	let now = $state(Date.now());
	let tabVisible = $state(true);
	let panelEl = $state<HTMLElement | null>(null);

	let selectedStatus = $derived(cameras.find((c) => c.name === selected) ?? null);
	let running = $derived(paused || collapsed ? false : tabVisible && !!selected);
	// Only meaningful while we are actually asking for frames. A deliberately
	// paused feed is not stale, and labelling it "stale" would train the
	// operator to ignore the one warning that matters.
	let stale = $derived(
		running && lastFrameAt !== null && now - lastFrameAt > STALE_AFTER_MS
	);
	let reconnecting = $derived(failures > 0);

	// Server-reported geometry, e.g. [480, 640, 3] -> "640x480".
	let reportedSize = $derived(
		selectedStatus?.actual_size && selectedStatus.actual_size.length >= 2
			? `${selectedStatus.actual_size[1]}x${selectedStatus.actual_size[0]}`
			: selectedStatus
				? `${selectedStatus.requested.width}x${selectedStatus.requested.height}`
				: null
	);

	function preload(url: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => resolve();
			img.onerror = () => reject(new Error('frame load failed'));
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
			if (saved.size in SIZES) size = saved.size;
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
		const snapshot = JSON.stringify({ fps, size, collapsed, selected });
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

	// --- the polling loop ---------------------------------------------------
	$effect(() => {
		const name = selected;
		const interval = 1000 / fps;
		const active = running;
		if (!name || !active) return;

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
				frameCount += 1;
				lastFrameAt = Date.now();
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
	<!-- Header: always visible, so a collapsed panel still reports health -->
	<div class="flex items-center justify-between gap-2 px-3 py-2">
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
					style="border-color: var(--color-tron-border); max-width: {SIZES[size]}px"
				>
					{#if displaySrc}
						<img
							src={displaySrc}
							alt="Live view from arm camera {selected}"
							class="block w-full transition-opacity"
							class:opacity-40={stale || reconnecting}
						/>
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
						Camera worker was idle at page load. Requesting frames starts it — give it a moment.
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

					<select
						bind:value={fps}
						class="rounded border px-2 py-1"
						style="border-color: var(--color-tron-border); background: var(--color-tron-bg); color: var(--color-tron-text)"
						aria-label="Frame rate"
					>
						{#each FPS_OPTIONS as option (option)}
							<option value={option}>{option} fps</option>
						{/each}
					</select>

					<select
						bind:value={size}
						class="rounded border px-2 py-1"
						style="border-color: var(--color-tron-border); background: var(--color-tron-bg); color: var(--color-tron-text)"
						aria-label="Size"
					>
						{#each SIZE_KEYS as key (key)}
							<option value={key}>{key}</option>
						{/each}
					</select>

					<button
						type="button"
						onclick={() => (paused = !paused)}
						class="rounded border px-2 py-1 transition-colors hover:bg-black/20"
						style="border-color: var(--color-tron-border); color: var(--color-tron-cyan)"
					>
						{paused ? 'Resume' : 'Pause'}
					</button>

					{#if displaySrc}
						<a
							href={displaySrc}
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
					{#if reportedSize}{reportedSize} · {/if}{frameCount} frame{frameCount === 1
						? ''
						: 's'}
					{#if selectedStatus}
						· requested {selectedStatus.requested.fps} fps q{selectedStatus.requested.quality}
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</section>
