<script lang="ts">
	/**
	 * ARM-04 — live marker tracking.
	 *
	 * Polls the snapshot proxy, finds every calibrated sticker in each frame by
	 * its colour (starting from where it was last seen), and shows where each
	 * one is now against where it was at calibration. When the calibration was
	 * taken with depth, the camera's lidar is sampled at the tracked spots on a
	 * slower cadence, which catches a point that moved straight toward or away
	 * from the lens — invisible on the picture alone.
	 *
	 * Runs only while the operator has it switched on and the tab is visible:
	 * each frame is a request through BIMS to the Pi.
	 */
	import { untrack } from 'svelte';
	import VisionStage, { type StageMarker } from './VisionStage.svelte';
	import { assessMarkers, rgbToHex, trackAll, type Observation } from '$lib/robot-arm/markers';
	import { fetchDepth, grabFrame } from '$lib/robot-arm/frame-grab';
	import type { CalibrationSummary } from '$lib/server/robot-arm-vision';

	interface Props {
		camera: string;
		calibration: CalibrationSummary | null;
	}

	let { camera, calibration }: Props = $props();

	const FPS_OPTIONS = [1, 2, 4];
	const DEPTH_EVERY_MS = 1200;

	let running = $state(false);
	let fps = $state(2);
	let frameUrl = $state<string | null>(null);
	let frameW = $state(0);
	let frameH = $state(0);
	let observations = $state<Observation[]>([]);
	let depthById = $state<Record<string, number | null>>({});
	let depthNote = $state<string | null>(null);
	let error = $state<string | null>(null);
	let lastAt = $state<number | null>(null);
	let now = $state(Date.now());

	const placements = $derived(calibration?.placements ?? []);
	const assessment = $derived(
		calibration && observations.length
			? assessMarkers(
					placements,
					observations.map((o) => ({ ...o, depthMm: o.x == null ? null : (depthById[o.markerId] ?? null) })),
					calibration.tolerances
				)
			: null
	);
	const stale = $derived(running && lastAt != null && now - lastAt > 4000);

	const stageMarkers = $derived<StageMarker[]>(
		placements.map((p) => {
			const a = assessment?.markers.find((m) => m.markerId === p.markerId);
			return {
				id: p.markerId,
				label: p.name,
				color: rgbToHex(p.color),
				x: a ? a.x : null,
				y: a ? a.y : null,
				refX: p.x,
				refY: p.y,
				status: a?.status ?? 'placed'
			};
		})
	);

	// Changing camera or calibration starts over: the priors belong to the old one.
	$effect(() => {
		void camera;
		void calibration?._id;
		untrack(() => {
			observations = [];
			depthById = {};
			depthNote = null;
		});
	});

	$effect(() => {
		if (!running || !camera || !calibration) return;
		const cam = camera;
		const pl = calibration.placements;
		const withDepth = calibration.depthAvailable;
		let stopped = false;
		const ctrl = new AbortController();
		const priors: Record<string, { x: number; y: number } | null> = {};
		const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

		(async () => {
			while (!stopped) {
				const t0 = performance.now();
				if (document.visibilityState === 'visible') {
					try {
						const f = await grabFrame(cam, ctrl.signal);
						if (stopped) {
							URL.revokeObjectURL(f.url);
							break;
						}
						const obs = trackAll(f.image, pl, { priors });
						for (const o of obs) priors[o.markerId] = o.x != null && o.y != null ? { x: o.x, y: o.y } : null;
						const old = frameUrl;
						frameUrl = f.url;
						if (old) URL.revokeObjectURL(old);
						frameW = f.width;
						frameH = f.height;
						observations = obs;
						lastAt = Date.now();
						error = null;
					} catch (e) {
						if (stopped) break;
						error = e instanceof Error ? e.message : 'Frame failed';
					}
				}
				await sleep(Math.max(50, 1000 / fps - (performance.now() - t0)));
			}
		})();

		if (withDepth) {
			(async () => {
				while (!stopped) {
					await sleep(DEPTH_EVERY_MS);
					if (stopped || document.visibilityState !== 'visible') continue;
					const found = untrack(() => observations).filter((o) => o.x != null && o.y != null);
					if (!found.length) continue;
					const d = await fetchDepth(cam, found.map((o) => [o.x!, o.y!]));
					if (stopped) break;
					const next: Record<string, number | null> = {};
					found.forEach((o, i) => (next[o.markerId] = d.depth[i]));
					depthById = next;
					depthNote = d.available ? null : (d.reason ?? 'The camera reports no depth.');
				}
			})();
		}

		const clock = setInterval(() => (now = Date.now()), 1000);
		return () => {
			stopped = true;
			ctrl.abort();
			clearInterval(clock);
		};
	});

	$effect(() => () => {
		if (frameUrl) URL.revokeObjectURL(frameUrl);
	});

	function px(f: number | null, size: number): string {
		return f == null ? '—' : `${Math.round(f * size)}`;
	}

	const STATUS_LABEL: Record<string, string> = { ok: 'OK', moved: 'MOVED', depth_off: 'DEPTH OFF', missing: 'NOT FOUND', placed: '—' };
	const STATUS_COLOR: Record<string, string> = { ok: '#4ade80', moved: '#f59e0b', depth_off: '#f97316', missing: '#ef4444', placed: 'var(--color-tron-text-secondary)' };
	const VERDICT: Record<string, { label: string; color: string }> = {
		ok: { label: 'ALL MARKERS IN PLACE', color: '#4ade80' },
		off: { label: 'MARKERS OFF', color: '#f59e0b' },
		camera_moved: { label: 'CAMERA MOVED — RECALIBRATE', color: '#ef4444' },
		no_markers: { label: 'NO MARKERS', color: 'var(--color-tron-text-secondary)' }
	};
</script>

<section class="rounded border p-3 sm:p-4" style="border-color: var(--color-tron-border); background: var(--color-tron-surface);">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div>
			<h2 class="text-sm font-semibold tracking-wide" style="color: var(--color-tron-text)">LIVE TRACKING</h2>
			<p class="text-xs" style="color: var(--color-tron-text-secondary)">
				Where every marker is right now, against its calibrated spot (dashed ring).
			</p>
		</div>
		<div class="flex items-center gap-2">
			<label class="text-xs" style="color: var(--color-tron-text-secondary)">
				fps
				<select bind:value={fps} class="ml-1 rounded border bg-black/40 px-1 py-0.5 text-xs" style="border-color: var(--color-tron-border); color: var(--color-tron-text)">
					{#each FPS_OPTIONS as f}<option value={f}>{f}</option>{/each}
				</select>
			</label>
			<button
				type="button"
				disabled={!calibration}
				onclick={() => (running = !running)}
				class="min-h-[40px] rounded px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40"
				style="background: {running ? 'rgba(239,68,68,0.15)' : 'rgba(56,189,248,0.15)'}; color: {running ? '#fca5a5' : 'var(--color-tron-cyan)'}; border: 1px solid {running ? '#ef4444' : 'var(--color-tron-cyan)'};"
			>
				{running ? 'Stop tracking' : 'Start tracking'}
			</button>
		</div>
	</div>

	{#if !calibration}
		<p class="mt-3 text-xs" style="color: var(--color-tron-text-secondary)">
			Camera <span class="font-mono">{camera || '—'}</span> has no calibration yet — calibrate it below, then track.
		</p>
	{:else}
		{#if assessment}
			{@const v = VERDICT[assessment.verdict]}
			<div class="mt-3 flex flex-wrap items-center gap-3 text-xs">
				<span class="rounded px-2 py-1 font-semibold" style="color: {v.color}; border: 1px solid {v.color};">{v.label}</span>
				<span style="color: var(--color-tron-text-secondary)">
					{assessment.okCount}/{assessment.markers.length} in place
					{#if assessment.movedCount}· {assessment.movedCount} moved{/if}
					{#if assessment.missingCount}· {assessment.missingCount} not found{/if}
					{#if assessment.depthOffCount}· {assessment.depthOffCount} depth off{/if}
					· {assessment.depthUsed ? 'picture + depth' : 'picture only'}
				</span>
			</div>
		{/if}
		{#if error}<p class="mt-2 text-xs text-red-300">{error}</p>{/if}
		{#if stale}<p class="mt-2 text-xs" style="color: #f59e0b">No new frame for {Math.round((now - (lastAt ?? now)) / 1000)} s — the picture below is old.</p>{/if}
		{#if depthNote}<p class="mt-2 text-xs" style="color: #f59e0b">Depth: {depthNote}</p>{/if}

		<div class="mt-3 grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
			<VisionStage
				src={frameUrl}
				width={frameW || calibration.frameWidth}
				height={frameH || calibration.frameHeight}
				markers={stageMarkers}
				emptyText={running ? 'Waiting for the first frame…' : 'Start tracking to see the live picture'}
				alt="Live camera frame with tracked markers"
			/>
			<div class="overflow-x-auto">
				<table class="w-full text-xs">
					<thead>
						<tr class="text-left" style="color: var(--color-tron-text-secondary)">
							<th class="py-1 pr-2 font-medium">Marker</th>
							<th class="py-1 pr-2 font-medium">Status</th>
							<th class="py-1 pr-2 text-right font-medium">x, y px</th>
							<th class="py-1 pr-2 text-right font-medium">off px</th>
							<th class="py-1 text-right font-medium">depth mm</th>
						</tr>
					</thead>
					<tbody>
						{#each placements as p (p.markerId)}
							{@const a = assessment?.markers.find((m) => m.markerId === p.markerId)}
							{@const W = frameW || calibration.frameWidth}
							{@const H = frameH || calibration.frameHeight}
							<tr class="border-t" style="border-color: var(--color-tron-border)">
								<td class="py-1 pr-2" style="color: var(--color-tron-text)">
									<span class="mr-1 inline-block h-2.5 w-2.5 rounded-full align-middle" style="background: {rgbToHex(p.color)}"></span>{p.name}
									{#if p.group}<span class="ml-1" style="color: var(--color-tron-text-secondary)">{p.group}</span>{/if}
								</td>
								<td class="py-1 pr-2 font-semibold" style="color: {STATUS_COLOR[a?.status ?? 'placed']}">{STATUS_LABEL[a?.status ?? 'placed']}</td>
								<td class="py-1 pr-2 text-right font-mono" style="color: var(--color-tron-text)">{a ? `${px(a.x, W)}, ${px(a.y, H)}` : '—'}</td>
								<td class="py-1 pr-2 text-right font-mono" style="color: var(--color-tron-text)">{a?.distance != null ? Math.round(a.distance * W) : '—'}</td>
								<td class="py-1 text-right font-mono" style="color: var(--color-tron-text)">
									{a?.depthMm != null ? Math.round(a.depthMm) : '—'}
									{#if a?.depthDeltaMm != null}<span style="color: {Math.abs(a.depthDeltaMm) > calibration.tolerances.depthMm ? '#f97316' : 'var(--color-tron-text-secondary)'}">({a.depthDeltaMm > 0 ? '+' : ''}{Math.round(a.depthDeltaMm)})</span>{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
				<p class="mt-2 text-[11px]" style="color: var(--color-tron-text-secondary)">
					Tolerance: {Math.round(calibration.tolerances.position * (frameW || calibration.frameWidth))} px{calibration.depthAvailable ? `, ${calibration.tolerances.depthMm} mm depth` : ''}.
					Calibrated {new Date(calibration.capturedAt).toLocaleString()}.
				</p>
			</div>
		</div>
	{/if}
</section>
