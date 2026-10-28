<script lang="ts">
	/**
	 * ARM-09 — a pose's camera reference, under the pose editor.
	 *
	 * The reference is what a verified run checks a step against: the tags
	 * the camera saw and the encoders read with the arm sitting ON the pose,
	 * landed by a play. So the flow is: Go to pose (the page plays it) → look
	 * at the arm, fix it with the sliders if needed and save → Go to pose
	 * again → Detect tags (optional) → Capture reference. Then "Check now"
	 * re-detects without moving and shows the residuals, and the tolerances
	 * are set above that jitter.
	 *
	 * Same steps as the Vision tab's home calibration: Detect tags previews
	 * with the frame stack Capture uses (CALIBRATION_AVERAGE frames averaged
	 * pixel by pixel, CALIBRATION_FRAMES detections), so what it shows
	 * is what Capture will see; Capture and Check average frames like Save
	 * calibration and the home check do. Tags are registered on the Vision tab.
	 */
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { deserialize } from '$app/forms';
	import VisionStage, { type StageTag } from './VisionStage.svelte';
	import { CALIBRATION_FRAMES, CALIBRATION_AVERAGE } from '$lib/robot-arm/apriltags';
	import { fetchDetections, type LiveDetection } from '$lib/robot-arm/detect-client';
	import { friendlyName } from '$lib/robot-arm/animation';
	import { nearPose, worstOffset, AT_POSE_STEPS, MAX_ANGLE_DEG, MAX_POSITION_MM, MAX_TOLERANCE_STEPS } from '$lib/robot-arm/verified-poses';
	import type { PoseSummary } from '$lib/server/robot-arm-animation';
	import type { PoseCalibrationSummary, PoseCheckResult } from '$lib/server/robot-arm-verified';

	interface ArmRead {
		positions: number[];
		temps: (number | null)[];
		torqueOn: boolean | null;
	}

	interface Props {
		pose: PoseSummary;
		camera: string;
		cameras: string[];
		oncamera: (name: string) => void;
		/** This pose's active reference for `camera` (no picture), from the page's list. */
		calibration: PoseCalibrationSummary | null;
		arm: ArmRead | null;
		armReachable: boolean;
		blocked: boolean;
		blockReason: string;
		ongoto: (pose: PoseSummary) => void;
	}

	let { pose, camera, cameras, oncamera, calibration, arm, armReachable, blocked, blockReason, ongoto }: Props = $props();

	let full = $state<PoseCalibrationSummary | null>(null);
	let check = $state<PoseCheckResult | null>(null);
	let checking = $state(false);
	let capturing = $state(false);
	let note = $state<{ text: string; kind: 'ok' | 'warn' | 'error' } | null>(null);
	let det = $state<LiveDetection | null>(null);
	let detecting = $state(false);
	let detectError = $state<string | null>(null);
	let open = $state(true);
	// Tolerance fields, editable; follow the reference until the operator types.
	let posMm = $state('');
	let angDeg = $state('');
	let steps = $state('');

	const atPose = $derived(!!arm && nearPose(arm.positions, pose.positions));
	const offBy = $derived(arm ? Math.round(worstOffset(arm.positions, pose.positions)) : null);
	const canAct = $derived(armReachable && !blocked);

	// A detection belongs to one camera and one pose.
	$effect(() => {
		void camera;
		void pose._id;
		det = null;
		detectError = null;
	});

	async function detect() {
		if (!camera) return;
		detecting = true;
		detectError = null;
		try {
			det = await fetchDetections(camera, undefined, CALIBRATION_FRAMES, CALIBRATION_AVERAGE);
			if (!det.available) detectError = det.reason ?? 'The Pi could not detect tags.';
		} catch (e) {
			detectError = e instanceof Error ? e.message : 'Detection failed';
		} finally {
			detecting = false;
		}
	}

	// What Capture would make of this frame: it needs a registered arm tag; a fixed one is recommended.
	const detArm = $derived((det?.tags ?? []).filter((t) => t.registered?.role === 'arm'));
	const detFixed = $derived((det?.tags ?? []).filter((t) => t.registered?.role === 'fixed'));
	const detNew = $derived((det?.tags ?? []).filter((t) => !t.registered));
	const detTags = $derived<StageTag[]>(
		(det?.tags ?? []).map((d) => ({
			key: String(d.id),
			label: d.registered ? `${d.registered.name} #${d.id}` : `#${d.id} (not registered)`,
			corners: d.corners,
			center: d.center,
			status: d.registered ? 'registered' : 'unregistered'
		}))
	);

	// Fetch the picture for the active reference (the list comes without it).
	$effect(() => {
		const id = calibration?._id ?? null;
		full = null;
		check = null;
		if (!id) return;
		let cancelled = false;
		(async () => {
			try {
				const fd = new FormData();
				fd.set('id', id);
				const res = await fetch('?/poseCalibration', { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
				const r = deserialize(await res.text());
				if (!cancelled && r.type === 'success' && r.data?.poseCalibration) full = r.data.poseCalibration as PoseCalibrationSummary;
			} catch {
				/* the card still works without the picture */
			}
		})();
		return () => {
			cancelled = true;
		};
	});
	$effect(() => {
		const t = calibration?.tolerances;
		posMm = t ? String(t.positionMm) : '';
		angDeg = t ? String(t.angleDeg) : '';
		steps = t ? String(t.steps) : '';
	});

	const refTags = $derived<StageTag[]>(
		(full?.tags ?? calibration?.tags ?? []).map((t) => ({ key: String(t.tagId), label: `${t.name} #${t.tagId}`, corners: t.corners, center: t.center, status: 'calibrated' }))
	);
	const checkTags = $derived<StageTag[]>(
		(check?.markers ?? []).map((m) => {
			const ref = (full?.tags ?? calibration?.tags ?? []).find((t) => t.tagId === m.tagId);
			return { key: String(m.tagId), label: `${m.name}${m.offMm != null ? ` ${m.offMm.toFixed(1)} mm` : ''}`, corners: null, center: null, refCorners: ref?.corners ?? null, refCenter: ref?.center ?? null, status: m.status === 'ok' ? 'ok' : m.status === 'missing' ? 'missing' : 'moved' };
		})
	);

	async function runCheck() {
		if (!calibration) return;
		checking = true;
		note = null;
		try {
			const fd = new FormData();
			fd.set('poseId', pose._id);
			fd.set('camera', camera);
			const res = await fetch('?/checkPose', { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
			const r = deserialize(await res.text());
			if (r.type === 'success' && r.data?.poseCheck) check = r.data.poseCheck as PoseCheckResult;
			else note = { text: r.type === 'failure' ? String((r.data as { error?: string })?.error ?? 'Check failed.') : 'Check failed.', kind: 'error' };
		} catch (e) {
			note = { text: `Check failed: ${e instanceof Error ? e.message : String(e)}`, kind: 'error' };
		} finally {
			checking = false;
		}
	}

	const VERDICT: Record<string, { label: string; color: string }> = {
		ok: { label: 'ON THE POSE', color: '#4ade80' },
		position_off: { label: 'ENCODERS OFF', color: '#f59e0b' },
		tags_off: { label: 'TAGS OFF', color: '#f59e0b' },
		position_off_and_tags_off: { label: 'OFF', color: '#ef4444' },
		camera_moved: { label: 'CAMERA MOVED', color: '#ef4444' },
		unverified: { label: 'NOT VERIFIED', color: '#fbbf24' }
	};

	const when = (iso: string) => new Date(iso).toLocaleString();
	const input = 'rounded border bg-black/40 px-2 py-1 text-sm font-mono';
	const inputStyle = 'border-color: var(--color-tron-border); color: var(--color-tron-text)';
	const btn = 'min-h-[36px] rounded px-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40';
	const cyan = 'background: rgba(56,189,248,0.15); color: var(--color-tron-cyan); border: 1px solid var(--color-tron-cyan);';
	const green = 'background: rgba(74,222,128,0.12); color: #4ade80; border: 1px solid #4ade80;';
	const amber = 'background: rgba(245,158,11,0.15); color: #fbbf24; border: 1px solid #f59e0b;';
	const muted = 'color: var(--color-tron-text-secondary)';
</script>

<section class="rounded border p-3 sm:p-4" style="border-color: var(--color-tron-border); background: var(--color-tron-surface);">
	<div class="flex flex-wrap items-center gap-3">
		<button type="button" class="text-sm font-semibold tracking-wide" style="color: var(--color-tron-text)" onclick={() => (open = !open)}>
			{open ? '▾' : '▸'} Camera reference
		</button>
		{#if calibration}
			<span class="rounded px-2 py-0.5 text-[11px] font-semibold" style="background: rgba(74,222,128,0.15); color: #4ade80">VERIFIED POSE</span>
			{#if calibration.stale}<span class="rounded px-2 py-0.5 text-[11px] font-semibold" style="background: rgba(245,158,11,0.15); color: #fbbf24" title="The pose's goals changed after this reference was taken — a verified run refuses it until it is retaken.">STALE — retake</span>{/if}
		{:else}
			<span class="text-[11px]" style={muted}>none for this camera — the pose is played without a camera check</span>
		{/if}
		<span class="grow"></span>
		<label class="flex items-center gap-1 text-xs" style={muted}>
			camera
			<select value={camera} onchange={(e) => oncamera(e.currentTarget.value)} class="{input} py-0.5 text-xs" style={inputStyle} aria-label="Camera">
				{#each cameras as n (n)}<option value={n}>{n}</option>{/each}
				{#if !cameras.length}<option value="">no camera</option>{/if}
			</select>
		</label>
	</div>

	{#if open}
		<p class="mt-2 text-xs" style={muted}>
			A verified run checks this step against the picture and the encoder reading taken with the arm <em>on</em> the pose, landed by a play.
			Go to pose, look at it, then capture. Set the tolerances after the picture: Check now shows the real residuals with the arm still.
		</p>

		{#if note}<p class="mt-2 text-xs" style="color: {note.kind === 'error' ? '#fca5a5' : note.kind === 'warn' ? '#fbbf24' : '#4ade80'}">{note.text}</p>{/if}

		<div class="mt-3 flex flex-wrap items-center gap-2">
			<button type="button" class={btn} style={cyan} disabled={!camera || detecting} onclick={detect} title="No motion: detect the tags in view now, on the same {CALIBRATION_AVERAGE}-frame average Capture uses (about {Math.round(CALIBRATION_AVERAGE / 30 * 10) / 10} s at 30 fps; hold the arm still)">
				{detecting ? 'Detecting…' : det ? 'Detect again' : 'Detect tags'}
			</button>
			{#if !atPose}
				<button type="button" class={btn} style={amber} disabled={!canAct} title={blocked ? blockReason : 'The arm plays to the pose (absolute goals), then holds it'} onclick={() => ongoto(pose)}>Go to pose</button>
				<span class="text-xs" style={muted}>{arm ? `the arm is ${offBy} steps from this pose (needs ≤ ${AT_POSE_STEPS})` : 'the arm has not been read'}</span>
			{:else}
				<form
					method="POST"
					action="?/calibratePose"
					use:enhance={() => {
						capturing = true;
						note = null;
						return async ({ result, update }) => {
							capturing = false;
							if (result.type === 'success') {
								const d = result.data as { success?: string; warning?: string | null };
								note = { text: `${d.success ?? 'Captured.'}${d.warning ? ' ' + d.warning : ''}`, kind: d.warning ? 'warn' : 'ok' };
								await invalidateAll();
							} else if (result.type === 'failure') note = { text: String((result.data as { error?: string })?.error ?? 'Capture failed.'), kind: 'error' };
							else await update();
						};
					}}
					class="flex items-center gap-2"
				>
					<input type="hidden" name="poseId" value={pose._id} />
					<input type="hidden" name="camera" value={camera} />
					<button type="submit" class={btn} style={green} disabled={!canAct || !camera || capturing} title={blocked ? blockReason : 'One detection + the encoders, with the arm where it is'}>
						{capturing ? 'Capturing…' : calibration ? 'Retake reference' : 'Capture reference'}
					</button>
				</form>
				<span class="text-xs" style="color: #4ade80">the arm is on this pose ({offBy} steps off at most)</span>
			{/if}
			{#if calibration}
				<button type="button" class={btn} style={cyan} disabled={!canAct || checking} onclick={runCheck} title="No motion: detect and compare with the reference">{checking ? 'Checking…' : 'Check now'}</button>
			{/if}
		</div>

		{#if detectError}<p class="mt-2 text-xs text-red-300">{detectError}</p>{/if}

		{#if det?.available}
			<div class="mt-3 grid gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
				<VisionStage src={det.frame} width={det.width} height={det.height} tags={detTags} alt="Detected tags" />
				<div class="space-y-1 text-xs">
					<p style={muted}>
						{det.tags.length} tag(s) in view over {det.framesUsed} frame(s) · {det.width}×{det.height}{atPose ? ' · arm on this pose' : ' · arm not on this pose'}
					</p>
					{#if detArm.length}
						<p style="color: #4ade80">Capture will accept this view: {detArm.length} arm tag(s){detFixed.length ? `, ${detFixed.length} fixed` : ''}.</p>
					{:else}
						<p style="color: #fca5a5">No registered arm tag in view — Capture would refuse. Bring an arm tag into view (or check its role on the Vision tab).</p>
					{/if}
					{#if detArm.length && !detFixed.length}<p style="color: #fbbf24">No fixed tag in view: a bumped camera will read as the arm being off.</p>{/if}
					<ul class="space-y-0.5 font-mono">
						{#each det.tags as d (d.id)}
							<li style="color: {d.registered?.role === 'arm' ? '#4ade80' : d.registered ? 'var(--color-tron-text)' : '#fbbf24'}">
								#{d.id} {d.registered ? `${d.registered.name} (${d.registered.role})` : 'not registered'}{d.framesSeen != null ? ` · ${d.framesSeen}/${det.framesUsed} frames` : ''}{d.pose ? ` · ${(d.pose.t[2] / 10).toFixed(1)} cm` : ''}
							</li>
						{/each}
					</ul>
					{#if detNew.length}<p style={muted}>Register new tags on the Vision tab; unregistered tags are not part of a reference.</p>{/if}
				</div>
			</div>
		{/if}

		{#if calibration}
			<div class="mt-3 grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
				<div>
					<VisionStage src={full?.thumbnailDataUrl ?? null} width={calibration.frameWidth} height={calibration.frameHeight} tags={refTags} alt="Reference picture" emptyText="Loading the reference picture…" />
					<p class="mt-1 text-[11px]" style={muted}>
						Taken {when(calibration.capturedAt)}{calibration.capturedBy?.username ? ` by ${calibration.capturedBy.username}` : ''} · {calibration.armTags} arm tag(s), {calibration.fixedTags} fixed
						· encoders {Object.entries(calibration.jointSteps).map(([k, v]) => `${k}:${v}`).join(' ')}
					</p>
					{#if !calibration.fixedTags}<p class="text-[11px]" style="color: #fbbf24">No fixed tag in this view: a bumped camera will read as the arm being off.</p>{/if}
				</div>
				<div class="space-y-3 text-xs">
					<!-- tolerances: set AFTER the photo, per pose; a move-set step can override them -->
					<form
						method="POST"
						action="?/setPoseTolerances"
						use:enhance={() => {
							note = null;
							return async ({ result }) => {
								if (result.type === 'success') {
									note = { text: String((result.data as { success?: string })?.success ?? 'Saved.'), kind: 'ok' };
									await invalidateAll();
								} else if (result.type === 'failure') note = { text: String((result.data as { error?: string })?.error ?? 'Not saved.'), kind: 'error' };
							};
						}}
						class="flex flex-wrap items-end gap-2"
					>
						<input type="hidden" name="calibrationId" value={calibration._id} />
						<label style={muted}>Position (mm)<input name="positionMm" type="number" step="0.1" min="0.1" max={MAX_POSITION_MM} bind:value={posMm} class="{input} mt-1 block w-24" style={inputStyle} /></label>
						<label style={muted}>Spin (°, 0 = off)<input name="angleDeg" type="number" step="0.1" min="0" max={MAX_ANGLE_DEG} bind:value={angDeg} class="{input} mt-1 block w-24" style={inputStyle} /></label>
						<label style={muted}>Encoders (steps)<input name="steps" type="number" step="1" min="1" max={MAX_TOLERANCE_STEPS} bind:value={steps} class="{input} mt-1 block w-24" style={inputStyle} /></label>
						<button type="submit" class={btn} style={cyan}>Save tolerances</button>
						<span class="w-full text-[11px]" style={muted}>These are the pose's defaults; each move-set step can override them.</span>
					</form>

					{#if check}
						{@const v = VERDICT[check.verdict] ?? { label: check.verdict, color: '#fbbf24' }}
						<div class="rounded border p-2" style="border-color: {v.color}">
							<div class="flex items-center gap-2"><span class="font-semibold" style="color: {v.color}">{v.label}</span><span style={muted}>just now</span></div>
							<p class="mt-1" style="color: var(--color-tron-text)">{check.message}</p>
							{#if check.residuals}
								<p class="mt-1 font-mono" style={muted}>
									encoders: {Object.entries(check.residuals).map(([k, r]) => `J${k} ${r > 0 ? '+' : ''}${r}`).join('  ')} (limit ±{check.tolerances.steps})
								</p>
							{/if}
							{#if check.markers.length}
								<ul class="mt-1 space-y-0.5">
									{#each check.markers as m (m.tagId)}
										<li class="font-mono" style="color: {m.status === 'ok' ? '#4ade80' : m.status === 'missing' ? '#fca5a5' : '#fbbf24'}">
											{m.name} #{m.tagId} ({m.role}): {m.status}{m.offMm != null ? ` · ${m.offMm.toFixed(1)} mm (limit ${check.tolerances.positionMm})` : ''}{m.offDeg != null ? ` · ${m.offDeg.toFixed(1)}° spin${check.tolerances.angleDeg ? ` (limit ${check.tolerances.angleDeg})` : ''}` : ''}
										</li>
									{/each}
								</ul>
							{/if}
							{#if check.warnings.length}<p class="mt-1" style="color: #fbbf24">{check.warnings.join(' ')}</p>{/if}
							{#if check.snapshotDataUrl}
								<div class="mt-2 max-w-xs"><VisionStage src={check.snapshotDataUrl} width={calibration.frameWidth} height={calibration.frameHeight} tags={checkTags} alt="Camera at the check" /></div>
							{/if}
						</div>
					{:else if calibration.lastCheck}
						{@const lc = calibration.lastCheck}
						{@const v = VERDICT[lc.verdict] ?? { label: lc.verdict, color: '#fbbf24' }}
						<p style={muted}>
							Last check ({lc.kind === 'run' ? 'verified run' : 'check'}, {when(lc.at)}): <span style="color: {v.color}">{v.label}</span>{lc.residualMax != null ? ` · encoders within ${lc.residualMax} step(s)` : ''}
						</p>
					{/if}

					<details>
						<summary class="cursor-pointer" style={muted}>more</summary>
						<form method="POST" action="?/retirePoseCalibration" use:enhance class="mt-1">
							<input type="hidden" name="calibrationId" value={calibration._id} />
							<button type="submit" class="underline" style={muted} onclick={(e) => { if (!confirm('Retire this reference? The pose will not be verified until a new one is captured.')) e.preventDefault(); }}>retire this reference</button>
						</form>
					</details>
				</div>
			</div>
		{/if}
	{/if}
</section>
