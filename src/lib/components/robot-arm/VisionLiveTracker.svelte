<script lang="ts">
	/**
	 * ARM-05 — live AprilTag view.
	 *
	 * Polls the BIMS detection proxy (the Pi finds the tags), and shows every
	 * calibrated tag now against its home position: outline on the picture,
	 * and how far off it is in mm and degrees after undoing any camera shift
	 * the fixed tags reveal. A MOVED tag's offending number (the one over
	 * tolerance) is red, so the operator sees at a glance whether it slid,
	 * spun, or (without a pose) only moved on the picture.
	 *
	 * The angle is split: "spin" (about the tag's own normal) is judged;
	 * "tilt" (of the normal) is advisory only, because a small square tag
	 * seen nearly head-on has two poses that fit its corners equally and the
	 * tilt can flip by twice the viewing angle between frames. A "?" after
	 * the tilt marks such a coin-toss frame.
	 *
	 * Runs only while switched on and the tab is visible: each poll is a
	 * request through BIMS to the Pi.
	 */
	import VisionStage, { type StageTag } from './VisionStage.svelte';
	import { assessTags } from '$lib/robot-arm/apriltags';
	import { fetchDetections, type LiveDetection } from '$lib/robot-arm/detect-client';
	import type { CalibrationSummary } from '$lib/server/robot-arm-vision';

	interface Props {
		camera: string;
		calibration: CalibrationSummary | null;
		/**
		 * True while Return to home runs: the live view is switched OFF and
		 * cannot be started, so its polling never competes with the arm's
		 * requests to the Pi.
		 */
		suspended?: boolean;
	}

	let { camera, calibration, suspended = false }: Props = $props();

	const RATE_OPTIONS = [0.5, 1, 2];
	/** Distinct captures the Pi averages each tag over per answer (2026-10-23). */
	const FRAME_OPTIONS = [1, 3, 5];
	/** Consecutive frames the Pi stacks into each image before detecting (2026-10-28): 5 = 1/6 s at 30 fps (what a step check uses, and each of a calibration's 5 detections). */
	const AVERAGE_OPTIONS = [1, 5, 10, 30];

	let running = $state(false);
	let frames = $state(1);
	let average = $state(1);
	$effect(() => {
		if (suspended) running = false;
	});
	let rate = $state(1);
	let det = $state<LiveDetection | null>(null);
	let error = $state<string | null>(null);
	let lastAt = $state<number | null>(null);
	let now = $state(Date.now());

	const assessment = $derived(calibration && det?.available ? assessTags(calibration.tags, det.tags, calibration.tolerances) : null);
	const stale = $derived(running && lastAt != null && now - lastAt > 5000);

	const stageTags = $derived<StageTag[]>(
		(calibration?.tags ?? []).map((c) => {
			const a = assessment?.markers.find((m) => m.tagId === c.tagId);
			return {
				key: String(c.tagId),
				label: `${c.name} #${c.tagId}`,
				corners: a?.corners ?? null,
				center: a?.center ?? null,
				refCorners: c.corners,
				refCenter: c.center,
				status: a?.status ?? 'calibrated'
			};
		})
	);

	$effect(() => {
		void camera;
		void calibration?._id;
		det = null;
	});

	$effect(() => {
		if (!running || !camera || !calibration) return;
		const cam = camera;
		let stopped = false;
		const ctrl = new AbortController();
		const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

		(async () => {
			while (!stopped) {
				const t0 = performance.now();
				if (document.visibilityState === 'visible') {
					try {
						const d = await fetchDetections(cam, ctrl.signal, frames, average);
						if (stopped) break;
						det = d;
						lastAt = Date.now();
						error = d.available ? null : (d.reason ?? 'The Pi could not detect tags.');
					} catch (e) {
						if (stopped) break;
						error = e instanceof Error ? e.message : 'Detection failed';
					}
				}
				await sleep(Math.max(100, 1000 / rate - (performance.now() - t0)));
			}
		})();

		const clock = setInterval(() => (now = Date.now()), 1000);
		return () => {
			stopped = true;
			ctrl.abort();
			clearInterval(clock);
		};
	});

	const fmt = (v: number | null | undefined, d = 1) => (v == null ? '—' : v.toFixed(d));
	const fmtSigned = (v: number | null | undefined, d = 1) => (v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(d));
	const OVER_COLOR = '#f87171';
	/** Red when this measurement is the one that made the tag MOVED. */
	const cellColor = (a: { over: string[] } | undefined, which: 'mm' | 'deg' | 'px') => (a?.over.includes(which) ? OVER_COLOR : 'var(--color-tron-text)');
	/** Picture-distance fallback is the reason for at least one tag (no pose on one side). */
	const anyPx = $derived((assessment?.markers ?? []).some((m) => m.over.includes('px')));
	const tolMm = $derived(calibration?.tolerances.positionMm ?? 0);
	const tolDeg = $derived(calibration?.tolerances.angleDeg ?? 0);

	const STATUS_LABEL: Record<string, string> = { ok: 'OK', moved: 'MOVED', missing: 'NOT FOUND', calibrated: '—' };
	const STATUS_COLOR: Record<string, string> = { ok: '#4ade80', moved: '#f59e0b', missing: '#ef4444', calibrated: 'var(--color-tron-text-secondary)' };
	const VERDICT: Record<string, { label: string; color: string }> = {
		ok: { label: 'ALL TAGS AT HOME', color: '#4ade80' },
		off: { label: 'TAGS OFF', color: '#f59e0b' },
		camera_moved: { label: 'CAMERA MOVED — RECALIBRATE', color: '#ef4444' },
		no_markers: { label: 'NO TAGS', color: 'var(--color-tron-text-secondary)' }
	};
</script>

<section class="rounded border p-3 sm:p-4" style="border-color: var(--color-tron-border); background: var(--color-tron-surface);">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div>
			<h2 class="text-sm font-semibold tracking-wide" style="color: var(--color-tron-text)">LIVE TAGS</h2>
			<p class="text-xs" style="color: var(--color-tron-text-secondary)">
				Every calibrated tag now (solid) against its home position (dashed). The white edge is the tag's printed top.
			</p>
		</div>
		<div class="flex items-center gap-2">
			<label class="text-xs" style="color: var(--color-tron-text-secondary)" title="Consecutive frames the Pi stacks pixel by pixel into one image before the detector runs. Cuts sensor noise by about the square root of the count for 33 ms per frame at 30 fps and no extra detect. 5 = 1/6 s (what a step check uses; a calibration takes 5 detections of 5-frame stacks). The arm must hold still while the stack is captured.">
				average
				<select bind:value={average} class="ml-1 rounded border bg-black/40 px-1 py-0.5 text-xs" style="border-color: var(--color-tron-border); color: var(--color-tron-text)">
					{#each AVERAGE_OPTIONS as f}<option value={f}>{f}</option>{/each}
				</select>
			</label>
			<label class="text-xs" style="color: var(--color-tron-text-secondary)" title="Separate detections the Pi averages each tag's corners over before answering. 1 = live; 3 or 5 = steadier numbers for a parked arm (each detection ~0.6 s). The jitter column shows what was averaged away.">
				detections
				<select bind:value={frames} class="ml-1 rounded border bg-black/40 px-1 py-0.5 text-xs" style="border-color: var(--color-tron-border); color: var(--color-tron-text)">
					{#each FRAME_OPTIONS as f}<option value={f}>{f}</option>{/each}
				</select>
			</label>
			<label class="text-xs" style="color: var(--color-tron-text-secondary)">
				per s
				<select bind:value={rate} class="ml-1 rounded border bg-black/40 px-1 py-0.5 text-xs" style="border-color: var(--color-tron-border); color: var(--color-tron-text)">
					{#each RATE_OPTIONS as f}<option value={f}>{f}</option>{/each}
				</select>
			</label>
			<button
				type="button"
				disabled={!calibration || suspended}
				onclick={() => (running = !running)}
				class="min-h-[40px] rounded px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40"
				style="background: {running ? 'rgba(239,68,68,0.15)' : 'rgba(56,189,248,0.15)'}; color: {running ? '#fca5a5' : 'var(--color-tron-cyan)'}; border: 1px solid {running ? '#ef4444' : 'var(--color-tron-cyan)'};"
				title={suspended ? 'Off while the arm returns home' : ''}
			>
				{running ? 'Stop' : 'Start live view'}
			</button>
		</div>
	</div>
	{#if suspended}
		<p class="mt-2 text-xs" style="color: #f59e0b">Live tags are off while the arm returns home — start them again once it finishes.</p>
	{/if}

	{#if !calibration}
		<p class="mt-3 text-xs" style="color: var(--color-tron-text-secondary)">
			Camera <span class="font-mono">{camera || '—'}</span> has no calibration yet — calibrate it below, then watch it live.
		</p>
	{:else}
		{#if assessment}
			{@const v = VERDICT[assessment.verdict]}
			<div class="mt-3 flex flex-wrap items-center gap-3 text-xs">
				<span class="rounded px-2 py-1 font-semibold" style="color: {v.color}; border: 1px solid {v.color};">{v.label}</span>
				<span style="color: var(--color-tron-text-secondary)">
					{assessment.okCount}/{assessment.markers.length} at home
					{#if assessment.movedCount}· {assessment.movedCount} off{/if}
					{#if assessment.missingCount}· {assessment.missingCount} not found{/if}
					{#if assessment.extraTagIds.length}· uncalibrated in view: {assessment.extraTagIds.join(', ')}{/if}
				</span>
			</div>
			{#if assessment.cameraShift}
				<p class="mt-1 text-xs" style="color: {assessment.cameraShift.compensated ? '#f59e0b' : 'var(--color-tron-text-secondary)'}">
					Camera {assessment.cameraShift.compensated ? 'has shifted' : 'steady'}: {fmt(assessment.cameraShift.mm)} mm / {fmt(assessment.cameraShift.deg)}°
					on {assessment.cameraShift.fixedUsed}/{assessment.cameraShift.fixedSeen} fixed tag(s){assessment.cameraShift.compensated ? ' — undone before judging the arm; recalibrate when convenient' : ''}.
				</p>
			{:else}
				<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">No fixed tag in view — a camera bump cannot be told apart from the arm moving.</p>
			{/if}
		{/if}
		{#if error}<p class="mt-2 text-xs text-red-300">{error}</p>{/if}
		{#if stale}<p class="mt-2 text-xs" style="color: #f59e0b">No new detection for {Math.round((now - (lastAt ?? now)) / 1000)} s — the picture below is old.</p>{/if}

		<div class="mt-3 grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
			<VisionStage
				src={det?.frame ?? null}
				width={det?.width || calibration.frameWidth}
				height={det?.height || calibration.frameHeight}
				tags={stageTags}
				emptyText={running ? 'Waiting for the first detection…' : 'Start the live view to see the camera'}
				alt="Live camera frame with detected tags"
			/>
			<div class="overflow-x-auto">
				<table class="w-full text-xs">
					<thead>
						<tr class="text-left" style="color: var(--color-tron-text-secondary)">
							<th class="py-1 pr-2 font-medium">Tag</th>
							<th class="py-1 pr-2 font-medium">Status</th>
							<th class="py-1 pr-2 text-right font-medium" title="Distance from home after undoing any camera shift. Red = over {tolMm} mm.">off mm</th>
							<th class="py-1 pr-2 text-right font-medium" title="D415 depth now minus depth at calibration (signed, + = further from the camera). The raw sensor change; off mm uses this depth as the tag's distance whenever both sides have a reading.">Δdepth mm</th>
							<th class="py-1 pr-2 text-right font-medium" title={tolDeg > 0 ? `Spin about the tag's own normal. Red = over ${tolDeg}°.` : 'Spin about the tag\'s own normal (not checked).'}>spin °</th>
							<th class="py-1 pr-2 text-right font-medium" title="Tilt of the tag's normal from home. Advisory only: a square tag seen nearly head-on has two poses that fit its corners equally, so tilt can flip by twice the viewing angle. ? = that coin toss this frame.">tilt °</th>
							{#if anyPx}<th class="py-1 pr-2 text-right font-medium" title="Picture distance, % of frame width; used when a tag has no pose. Red = over {(calibration.tolerances.pixel * 100).toFixed(1)} %.">off px</th>{/if}
							<th class="py-1 text-right font-medium" title="Distance from the camera used for the judgment. D = the D415 depth (the pose slid along its sight line to it); (brackets) = a depth reading that could not be used this frame, so the image distance was.">dist mm</th>
							{#if (det?.framesUsed ?? 1) > 1}<th class="py-1 pl-2 text-right font-medium" title="Corner noise the Pi averaged away: mean standard deviation of the tag's 8 corner coordinates across the {det?.framesUsed} frames, in pixels. The 2026-10-23 baseline on a parked scene was 0.10-0.35 px per tag.">jitter px</th>{/if}
						</tr>
					</thead>
					<tbody>
						{#each calibration.tags as c (c.tagId)}
							{@const a = assessment?.markers.find((m) => m.tagId === c.tagId)}
							{@const st = a?.status ?? 'calibrated'}
							<tr class="border-t" style="border-color: var(--color-tron-border)">
								<td class="py-1 pr-2" style="color: var(--color-tron-text)">
									<span class="font-mono" style="color: var(--color-tron-text-secondary)">#{c.tagId}</span> {c.name}
									<span class="ml-1 text-[10px] uppercase" style="color: var(--color-tron-text-secondary)">{c.role}</span>
								</td>
								<td class="py-1 pr-2 font-semibold" style="color: {STATUS_COLOR[st]}">{STATUS_LABEL[st]}</td>
								<td class="py-1 pr-2 text-right font-mono {a?.over.includes('mm') ? 'font-semibold' : ''}" style="color: {cellColor(a, 'mm')}" title={a?.over.includes('mm') ? `Over the ${tolMm} mm tolerance: this is why the tag reads MOVED` : ''}>{fmt(a?.offMm)}</td>
								<td class="py-1 pr-2 text-right font-mono" style="color: var(--color-tron-text-secondary)" title={a?.offDepthMm != null ? `D415 depth ${Math.round(a.depthMm!)} mm now vs ${Math.round(a.depthMm! - a.offDepthMm)} mm at calibration` : a?.status === 'missing' ? '' : 'No depth reading on one side (closer than the D415 minimum range, or no return)'}>{fmtSigned(a?.offDepthMm)}</td>
								<td class="py-1 pr-2 text-right font-mono {a?.over.includes('deg') ? 'font-semibold' : ''}" style="color: {cellColor(a, 'deg')}" title={a?.over.includes('deg') ? `Over the ${tolDeg}° spin tolerance: this is why the tag reads MOVED` : ''}>{fmt(a?.offDeg)}</td>
								<td class="py-1 pr-2 text-right font-mono" style="color: var(--color-tron-text-secondary)" title={a?.ambiguous ? `Two poses fit this tag's corners about equally this frame${a.flipped ? '; the one agreeing with the calibration was taken' : ''}. Tilt is not judged.` : 'Tilt is not judged.'}>{fmt(a?.offTiltDeg)}{a?.ambiguous ? '?' : ''}</td>
								{#if anyPx}<td class="py-1 pr-2 text-right font-mono {a?.over.includes('px') ? 'font-semibold' : ''}" style="color: {cellColor(a, 'px')}" title={a?.over.includes('px') ? 'No pose on this tag, so it is judged on picture distance, and that is over tolerance' : ''}>{a?.offPx != null ? (a.offPx * 100).toFixed(1) + ' %' : '—'}</td>{/if}
								<td class="py-1 text-right font-mono" style="color: var(--color-tron-text)" title={a?.zSource === 'depth' ? `D415 depth drives this tag's position; the image pose alone put it at ${a.imageZMm != null ? Math.round(a.imageZMm) : '?'} mm` : a?.zSource === 'image' ? (a.depthMm != null ? `Image distance; the D415 depth (${Math.round(a.depthMm)} mm) was not usable on both sides this frame` : 'Image distance; no D415 depth for this tag') : ''}>
									{a?.zMm != null ? Math.round(a.zMm) : '—'}{#if a?.zSource === 'depth'}<span style="color: var(--color-tron-text-secondary)"> D</span>{:else if a?.zSource === 'image' && a?.depthMm != null}<span style="color: var(--color-tron-text-secondary)"> ({Math.round(a.depthMm)})</span>{/if}
								</td>
								{#if (det?.framesUsed ?? 1) > 1}
									{@const d = det?.tags.find((t) => t.id === c.tagId)}
									<td class="py-1 pl-2 text-right font-mono" style="color: var(--color-tron-text-secondary)" title={d?.framesSeen != null ? `Seen in ${d.framesSeen} of ${det?.framesUsed} frames` : ''}>{d?.jitterPx != null ? d.jitterPx.toFixed(2) : '—'}</td>
								{/if}
							</tr>
						{/each}
					</tbody>
				</table>
				<p class="mt-2 text-[11px]" style="color: var(--color-tron-text-secondary)">
					Tolerance {calibration.tolerances.positionMm} mm{calibration.tolerances.angleDeg > 0 ? `, ${calibration.tolerances.angleDeg}°` : ' (angle not checked)'}.
					A <span style="color: {OVER_COLOR}">red</span> number is the one over tolerance that makes its tag MOVED.
					Tilt is advisory: a square seen nearly head-on has two poses that fit its corners equally, so tilt can flip by twice the viewing angle (a "?" marks that coin toss; the pose agreeing with the calibration is used).
					Distance marked D is the D415's depth: when both the calibration and this frame have a reading for a tag, its pose is slid along its sight line to that depth, so off mm no longer jitters with the tag's size on the picture. Without depth on both sides the tag falls back to the image distance; (brackets) = the unused depth reading.
					Δdepth is the depth reading now minus at calibration (+ = further away).
					{#if det?.frameSource}Detected on {det.frameSource === 'raw' ? 'the sensor\'s own pixels' : 'a decoded JPEG (older Pi software)'}{(det.framesAveraged ?? 1) > 1 ? `, ${det.framesAveraged} frames stacked per image${det.captureMs != null ? ` in ${det.captureMs} ms` : ''}${det.motionLuma != null ? `, motion ${det.motionLuma.toFixed(1)}` : ''}` : ''}{(det.framesUsed ?? 1) > 1 ? `, corners averaged over ${det.framesUsed} detections` : ''}.{/if}
					{#if average > 1 && det && det.framesAveraged == null}The Pi did not stack frames (its software predates frame stacking).{/if}
					{#if det?.framesAveraged != null && det.framesAveraged < average}Only {det.framesAveraged} of {average} frames were captured within the Pi's time budget (a slow shutter?).{/if}
					{#if calibration.intrinsicsSource === 'nominal'}Nominal intrinsics — mm are approximate.{/if}
				</p>
			</div>
		</div>
	{/if}
</section>
