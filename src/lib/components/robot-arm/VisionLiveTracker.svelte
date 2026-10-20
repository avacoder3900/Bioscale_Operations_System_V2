<script lang="ts">
	/**
	 * ARM-05 — live AprilTag view.
	 *
	 * Polls the BIMS detection proxy (the Pi finds the tags), and shows every
	 * calibrated tag now against its home position: outline on the picture,
	 * and how far off it is in mm and degrees after undoing any camera shift
	 * the fixed tags reveal.
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
	}

	let { camera, calibration }: Props = $props();

	const RATE_OPTIONS = [0.5, 1, 2];

	let running = $state(false);
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
						const d = await fetchDetections(cam, ctrl.signal);
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
			<label class="text-xs" style="color: var(--color-tron-text-secondary)">
				per s
				<select bind:value={rate} class="ml-1 rounded border bg-black/40 px-1 py-0.5 text-xs" style="border-color: var(--color-tron-border); color: var(--color-tron-text)">
					{#each RATE_OPTIONS as f}<option value={f}>{f}</option>{/each}
				</select>
			</label>
			<button
				type="button"
				disabled={!calibration}
				onclick={() => (running = !running)}
				class="min-h-[40px] rounded px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40"
				style="background: {running ? 'rgba(239,68,68,0.15)' : 'rgba(56,189,248,0.15)'}; color: {running ? '#fca5a5' : 'var(--color-tron-cyan)'}; border: 1px solid {running ? '#ef4444' : 'var(--color-tron-cyan)'};"
			>
				{running ? 'Stop' : 'Start live view'}
			</button>
		</div>
	</div>

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
							<th class="py-1 pr-2 text-right font-medium">off mm</th>
							<th class="py-1 pr-2 text-right font-medium">off °</th>
							<th class="py-1 text-right font-medium">dist mm</th>
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
								<td class="py-1 pr-2 text-right font-mono" style="color: var(--color-tron-text)">{fmt(a?.offMm)}</td>
								<td class="py-1 pr-2 text-right font-mono" style="color: var(--color-tron-text)">{fmt(a?.offDeg)}</td>
								<td class="py-1 text-right font-mono" style="color: var(--color-tron-text)" title={a?.depthMm != null ? `D415 depth ${Math.round(a.depthMm)} mm` : ''}>
									{a?.zMm != null ? Math.round(a.zMm) : '—'}{#if a?.depthMm != null}<span style="color: var(--color-tron-text-secondary)"> ({Math.round(a.depthMm)})</span>{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
				<p class="mt-2 text-[11px]" style="color: var(--color-tron-text-secondary)">
					Tolerance {calibration.tolerances.positionMm} mm{calibration.tolerances.angleDeg > 0 ? `, ${calibration.tolerances.angleDeg}°` : ' (angle not checked)'}.
					Distance is from the tag pose; (brackets) = the D415's depth reading, as a cross-check.
					{#if calibration.intrinsicsSource === 'nominal'}Nominal intrinsics — mm are approximate.{/if}
				</p>
			</div>
		</div>
	{/if}
</section>
