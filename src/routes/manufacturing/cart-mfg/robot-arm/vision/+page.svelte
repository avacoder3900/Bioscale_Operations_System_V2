<script lang="ts">
	/**
	 * Robot Arm — Vision tab (ARM-05, AprilTags).
	 *
	 * Top to bottom in the order an operator needs it: is the arm home (and if
	 * not, send it back), where is everything right now, recalibrate, and the
	 * tag registry. See docs/prds/ARM-05-apriltag-vision.md.
	 */
	import { enhance } from '$app/forms';
	import VisionStage, { type StageTag } from '$lib/components/robot-arm/VisionStage.svelte';
	import VisionLiveTracker from '$lib/components/robot-arm/VisionLiveTracker.svelte';
	import VisionTagCalibrator from '$lib/components/robot-arm/VisionTagCalibrator.svelte';
	import VisionTagRegistry from '$lib/components/robot-arm/VisionTagRegistry.svelte';
	import { HOME_STEP_TOLERANCE } from '$lib/robot-arm/home-calibration';
	import type { CalibrationSummary, HomeCheckResult, TagSummary } from '$lib/server/robot-arm-vision';
	import type { CameraStatus } from '$lib/server/robot-arm-client';

	let { data, form } = $props();

	const STORAGE_KEY = 'bims.armVision.camera.v1';

	const cameras = $derived((data.cameras ?? []) as CameraStatus[]);
	const tags = $derived((data.tags ?? []) as TagSummary[]);
	const calibrations = $derived((data.calibrations ?? []) as CalibrationSummary[]);
	const history = $derived((data.history ?? []) as CalibrationSummary[]);

	// Cameras the Pi lists, plus any that only exist as a calibration (the Pi
	// may be down, or the camera renamed) so their calibration stays visible.
	const cameraNames = $derived([...new Set([...cameras.map((c) => c.name), ...calibrations.map((c) => c.cameraName)])]);

	let chosen = $state<string | null>(null);
	// After mount, not at module top: the server render has no storage, and
	// reading it during hydration would make the two disagree.
	$effect(() => {
		try {
			chosen = localStorage.getItem(STORAGE_KEY);
		} catch {
			/* storage unavailable — fall back to the default below */
		}
	});
	const camera = $derived(
		chosen && cameraNames.includes(chosen) ? chosen : (calibrations[0]?.cameraName ?? cameraNames[0] ?? '')
	);
	function pickCamera(name: string) {
		chosen = name;
		try {
			localStorage.setItem(STORAGE_KEY, name);
		} catch {
			/* per-viewer convenience only */
		}
	}

	const calibration = $derived(calibrations.find((c) => c.cameraName === camera) ?? null);

	const armReachable = $derived(!!data.arm?.reachable);
	const busy = $derived(data.holder != null || !!data.active);
	const blocked = $derived(!armReachable || busy);
	const blockReason = $derived(
		!armReachable ? 'The arm is unreachable — check the connection on the Control tab.' : busy ? 'The arm is running something — stop it first.' : ''
	);

	const homeResult = $derived(form && 'homeResult' in form ? (form.homeResult as HomeCheckResult) : null);
	const shownResult = $derived(homeResult && homeResult.cameraName === camera ? homeResult : null);
	const flash = $derived(form as { success?: string; warning?: string; error?: string; warnings?: string[] } | null);

	let homeBusy = $state<string | null>(null);
	const homeEnhance = (kind: string) => () => {
		homeBusy = kind;
		return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			homeBusy = null;
		};
	};

	const VERDICT: Record<string, { label: string; color: string }> = {
		home: { label: 'AT HOME', color: '#4ade80' },
		position_off: { label: 'ENCODERS OFF', color: '#f59e0b' },
		markers_off: { label: 'TAGS OFF', color: '#f59e0b' },
		position_off_and_markers_off: { label: 'NOT AT HOME', color: '#ef4444' },
		camera_moved: { label: 'CAMERA MOVED', color: '#ef4444' },
		unverified: { label: 'UNVERIFIED', color: 'var(--color-tron-text-secondary)' }
	};
	const verdict = (v: string | null | undefined) => VERDICT[v ?? ''] ?? { label: '—', color: 'var(--color-tron-text-secondary)' };

	const referenceTags = $derived<StageTag[]>(
		(calibration?.tags ?? []).map((t) => ({ key: String(t.tagId), label: `${t.name} #${t.tagId}`, corners: t.corners, center: t.center, status: 'calibrated' }))
	);
	const resultTags = $derived<StageTag[]>(
		calibration && shownResult?.vision
			? shownResult.vision.markers.map((m) => {
					const c = calibration.tags.find((t) => t.tagId === m.tagId);
					return {
						key: String(m.tagId),
						label: `${m.name} #${m.tagId}`,
						corners: m.corners,
						center: m.center,
						refCorners: c?.corners ?? null,
						refCenter: c?.center ?? null,
						status: m.status
					};
				})
			: []
	);
	const joints = $derived(
		calibration?.jointSteps ? Object.entries(calibration.jointSteps).sort(([a], [b]) => Number(a) - Number(b)) : []
	);

	function when(iso: string): string {
		return new Date(iso).toLocaleString();
	}
</script>

<div class="mx-auto max-w-7xl space-y-5">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div>
			<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan)">Robot Arm — Vision</h1>
			<p class="text-xs" style="color: var(--color-tron-text-secondary)">
				AprilTags on the arm and its surroundings, located by the camera in mm — the backstop for an arm that did not return home.
			</p>
		</div>
		<label class="text-xs" style="color: var(--color-tron-text-secondary)">
			Camera
			<select
				value={camera}
				onchange={(e) => pickCamera((e.currentTarget as HTMLSelectElement).value)}
				class="ml-1 rounded border bg-black/40 px-2 py-1 text-sm"
				style="border-color: var(--color-tron-border); color: var(--color-tron-text)"
			>
				{#each cameraNames as n}<option value={n}>{n}{calibrations.some((c) => c.cameraName === n) ? '' : ' (not calibrated)'}</option>{/each}
				{#if !cameraNames.length}<option value="">no camera</option>{/if}
			</select>
		</label>
	</div>

	{#if data.camerasError}<p class="text-xs" style="color: #f59e0b">The Pi did not list its cameras: {data.camerasError}</p>{/if}
	{#if data.tagsError}<p class="text-xs text-red-300">{data.tagsError}</p>{/if}
	{#if data.calibrationsError}<p class="text-xs text-red-300">{data.calibrationsError}</p>{/if}

	{#if flash?.error}
		<div class="rounded border border-red-500/40 bg-red-900/10 p-3 text-sm text-red-300">{flash.error}</div>
	{:else if flash?.warning}
		<div class="rounded border border-amber-500/40 bg-amber-900/10 p-3 text-sm text-amber-300">{flash.warning}</div>
	{:else if flash?.success}
		<div class="rounded border border-green-500/40 bg-green-900/10 p-3 text-sm text-green-300">{flash.success}</div>
	{/if}
	{#if flash?.warnings?.length}
		<ul class="list-disc space-y-0.5 rounded border border-amber-500/40 bg-amber-900/10 p-3 pl-6 text-xs text-amber-300">
			{#each flash.warnings as w}<li>{w}</li>{/each}
		</ul>
	{/if}

	<!-- HOME CHECK — the recovery path, so it leads. -->
	<section class="rounded border p-3 sm:p-4" style="border-color: var(--color-tron-border); background: var(--color-tron-surface);">
		<div class="flex flex-wrap items-start justify-between gap-3">
			<div>
				<h2 class="text-sm font-semibold tracking-wide" style="color: var(--color-tron-text)">HOME CHECK</h2>
				<p class="text-xs" style="color: var(--color-tron-text-secondary)">
					{#if calibration}
						Calibrated {when(calibration.capturedAt)}{calibration.capturedBy?.username ? ` by ${calibration.capturedBy.username}` : ''}
						· {calibration.tags.length} tag(s) ({calibration.tags.filter((t) => t.role === 'fixed').length} fixed)
						· {calibration.tolerances.positionMm} mm{calibration.tolerances.angleDeg > 0 ? ` / ${calibration.tolerances.angleDeg}°` : ''}
						{#if calibration.intrinsicsSource === 'nominal'}· nominal intrinsics{/if}
						· {calibration.jointSteps ? 'encoder home stored' : 'no encoder home'}
						{#if calibration.note}· {calibration.note}{/if}
					{:else}
						No calibration for this camera yet — calibrate below with the arm parked at home.
					{/if}
				</p>
			</div>
			{#if calibration?.lastCheck}
				{@const v = verdict(calibration.lastCheck.verdict)}
				<div class="text-right text-xs" style="color: var(--color-tron-text-secondary)">
					Last {calibration.lastCheck.kind} {when(calibration.lastCheck.at)}{calibration.lastCheck.by?.username ? ` by ${calibration.lastCheck.by.username}` : ''}
					<div class="font-semibold" style="color: {v.color}">{v.label}</div>
				</div>
			{/if}
		</div>

		{#if calibration}
			<div class="mt-3 grid gap-4 md:grid-cols-2">
				<figure>
					<VisionStage src={calibration.thumbnailDataUrl} width={calibration.frameWidth} height={calibration.frameHeight} tags={referenceTags} alt="Calibration frame" />
					<figcaption class="mt-1 text-center text-[11px]" style="color: var(--color-tron-text-secondary)">calibration (home)</figcaption>
				</figure>
				{#if shownResult}
					{@const v = verdict(shownResult.home.verdict)}
					<figure>
						<VisionStage src={shownResult.snapshotDataUrl} width={calibration.frameWidth} height={calibration.frameHeight} tags={resultTags} alt="Camera frame at the check" emptyText="No camera frame for this check" />
						<figcaption class="mt-1 text-center text-[11px] font-semibold" style="color: {v.color}">now · {v.label}</figcaption>
					</figure>
				{:else}
					<div class="flex items-center justify-center rounded border border-dashed p-6 text-center text-xs" style="border-color: var(--color-tron-border); color: var(--color-tron-text-secondary)">
						Run a check to compare the arm with this calibration.
					</div>
				{/if}
			</div>

			{#if joints.length}
				<div class="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs" style="color: var(--color-tron-text-secondary)">
					{#each joints as [sid, steps]}
						{@const res = shownResult?.residuals?.[sid]}
						<span>J{sid} <span style="color: var(--color-tron-text)">{steps}</span>
							{#if res != null}<span style="color: {Math.abs(res) <= HOME_STEP_TOLERANCE ? '#4ade80' : '#f59e0b'}">({res > 0 ? '+' : ''}{res})</span>{/if}
						</span>
					{/each}
				</div>
			{/if}
			{#if shownResult?.moved?.length}
				<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">Moved: {shownResult.moved.map((m) => `J${m.sid} ${m.delta > 0 ? '+' : ''}${m.delta}`).join(', ')}</p>
			{/if}
			{#if shownResult?.warnings?.length}
				<ul class="mt-1 space-y-0.5 text-xs" style="color: #f59e0b">{#each shownResult.warnings as w}<li>{w}</li>{/each}</ul>
			{/if}

			<div class="mt-3 flex flex-wrap items-center gap-2">
				<form method="POST" action="?/returnHome" use:enhance={homeEnhance('return')}>
					<input type="hidden" name="camera" value={camera} />
					<button
						type="submit"
						disabled={blocked || !calibration.jointSteps || !!homeBusy}
						onclick={(e) => { if (!confirm('The arm will MOVE to the calibrated home, one joint at a time. Is the path clear?')) e.preventDefault(); }}
						class="min-h-[44px] rounded px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40"
						style="background: rgba(245,158,11,0.15); color: #fbbf24; border: 1px solid #f59e0b;"
						title={calibration.jointSteps ? 'Jog every joint back to the calibrated encoder steps, then verify with the tags' : 'This calibration has no encoder home'}
					>
						{homeBusy === 'return' ? 'Returning…' : 'Return to home'}
					</button>
				</form>
				<form method="POST" action="?/checkHome" use:enhance={homeEnhance('check')}>
					<input type="hidden" name="camera" value={camera} />
					<button
						type="submit"
						disabled={!armReachable || !!homeBusy}
						class="min-h-[44px] rounded px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40"
						style="background: rgba(56,189,248,0.15); color: var(--color-tron-cyan); border: 1px solid var(--color-tron-cyan);"
					>
						{homeBusy === 'check' ? 'Checking…' : 'Check without moving'}
					</button>
				</form>
				<form method="POST" action="?/retireCalibration" use:enhance onsubmit={(e) => { if (!confirm('Retire this calibration? Home check and Return to home stop working for this camera until you recalibrate.')) e.preventDefault(); }}>
					<input type="hidden" name="id" value={calibration._id} />
					<button type="submit" class="min-h-[44px] px-2 text-xs underline" style="color: var(--color-tron-text-secondary)">retire</button>
				</form>
				{#if blocked}<span class="text-xs" style="color: #f59e0b">{blockReason}</span>{/if}
			</div>
		{/if}
	</section>

	<VisionLiveTracker {camera} {calibration} />

	<VisionTagCalibrator {camera} {tags} {calibration} {blocked} {blockReason} />

	<VisionTagRegistry {tags} />

	{#if history.length}
		<section class="rounded border p-3 sm:p-4" style="border-color: var(--color-tron-border); background: var(--color-tron-surface);">
			<h2 class="text-sm font-semibold tracking-wide" style="color: var(--color-tron-text)">CALIBRATION HISTORY</h2>
			<ul class="mt-2 space-y-1 text-xs" style="color: var(--color-tron-text-secondary)">
				{#each history as h (h._id)}
					<li>
						<span class="font-mono">{h.cameraName}</span> · {when(h.capturedAt)}{h.capturedBy?.username ? ` by ${h.capturedBy.username}` : ''}
						· {h.tags.length} tag(s)
						{#if h.supersededAt}· retired {when(h.supersededAt)}{/if}
						{#if h.note}· {h.note}{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</div>
