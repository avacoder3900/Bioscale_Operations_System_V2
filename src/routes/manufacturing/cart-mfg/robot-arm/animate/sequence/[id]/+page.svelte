<script lang="ts">
	/**
	 * ARM-06 — sequence editor: move sets in order with the join between
	 * each pair (automatic length unless set), the whole path drawn live,
	 * Play, Stop, Save to Pi.
	 */
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { onDestroy, onMount } from 'svelte';
	import AnimationCurves from '$lib/components/robot-arm/AnimationCurves.svelte';
	import VerifiedRunPanel from '$lib/components/robot-arm/VerifiedRunPanel.svelte';
	import { VerifiedRun } from '$lib/robot-arm/verified-run.svelte';
	import { loadChosenCamera, pickCamera, saveChosenCamera } from '$lib/robot-arm/arm-camera';
	import { verifyWanted } from '$lib/robot-arm/verified-poses';
	import type { PoseCalibrationSummary, VerifiedRunSummary } from '$lib/server/robot-arm-verified';
	import type { CameraStatus } from '$lib/server/robot-arm-client';
	import { autoDurationS, buildPath, flattenSequence, friendlyName, keyframePositions, pathStats, tooFast, EASINGS, MAX_TRANSITION_S, MIN_TRANSITION_S, type Easing, type RenderedPath, type ResolvedKeyframe, type SequenceItem } from '$lib/robot-arm/animation';
	import { DEFAULT_JOINT_NAMES } from '$lib/robot-arm/recording-cleanup';
	import { Playback } from '$lib/robot-arm/playback.svelte';
	import type { MoveSetSummary, PoseSummary, SequenceItemRecord, SequenceSummary } from '$lib/server/robot-arm-animation';

	let { data, form } = $props();

	const sequence = $derived(data.sequence as SequenceSummary);
	const moveSets = $derived((data.moveSets ?? []) as MoveSetSummary[]);
	const poses = $derived((data.poses ?? []) as PoseSummary[]);
	const poseById = $derived(new Map(poses.map((p) => [p._id, p])));
	const moveSetById = $derived(new Map(moveSets.map((m) => [m._id, m])));
	const activeMoveSets = $derived(moveSets.filter((m) => !m.archived && m.keyframes.length));

	const flash = $derived(form as { success?: string; error?: string } | null);
	const armReachable = $derived(!!data.arm?.reachable);
	const blocked = $derived(!armReachable || data.holder != null || !!data.active);

	let name = $state('');
	let notes = $state('');
	let items = $state<SequenceItemRecord[]>([]);
	let saved = $state('');
	let addId = $state('');
	$effect(() => {
		name = sequence.name;
		notes = sequence.notes ?? '';
		items = sequence.items.map((i) => ({ ...i }));
		saved = JSON.stringify(sequence.items) + sequence.name + (sequence.notes ?? '');
	});
	const dirty = $derived(JSON.stringify(items) + name + notes !== saved);

	function resolveSet(ms: MoveSetSummary): ResolvedKeyframe[] | null {
		const out: ResolvedKeyframe[] = [];
		for (const k of ms.keyframes) {
			const p = poseById.get(k.poseId);
			if (!p) return null;
			out.push({ ...k, name: p.name, positions: keyframePositions(p.positions, k.offsets) });
		}
		return out;
	}
	const resolvedItems = $derived.by((): (SequenceItem & { missing?: boolean; autoJoinS: number })[] => {
		let prevEnd: number[] | null = null;
		return items.map((it) => {
			const ms = moveSetById.get(it.moveSetId);
			const kfs = (ms && resolveSet(ms)) ?? [];
			const autoJoinS = prevEnd && kfs.length ? autoDurationS(prevEnd, kfs[0].positions) : 0;
			if (kfs.length) prevEnd = kfs[kfs.length - 1].positions;
			return { name: ms?.name ?? '(missing)', keyframes: kfs, join: { durationS: it.joinDurationS, easing: it.joinEasing as Easing }, missing: !ms || !kfs.length, autoJoinS };
		});
	});
	const flat = $derived(flattenSequence(resolvedItems.filter((i) => !i.missing)));
	const render = $derived.by((): { path: RenderedPath | null; error: string | null } => {
		if (!flat.length) return { path: null, error: null };
		try {
			return { path: buildPath(flat), error: null };
		} catch (e) {
			return { path: null, error: e instanceof Error ? e.message : String(e) };
		}
	});
	const stats = $derived(render.path ? pathStats(render.path) : null);
	const problems = $derived(tooFast(flat));

	const playback = new Playback();
	onDestroy(() => playback.destroy());

	// ARM-09: the verified run (step by step, each verified pose checked with the camera).
	const poseCals = $derived((data.poseCalibrations ?? []) as PoseCalibrationSummary[]);
	const cameraNames = $derived([...new Set([...((data.cameras ?? []) as CameraStatus[]).map((c) => c.name), ...poseCals.map((c) => c.cameraName)])]);
	let chosenCamera = $state<string | null>(null);
	const camera = $derived(pickCamera(cameraNames, chosenCamera, poseCals.map((c) => c.cameraName)));
	const hasRef = (poseId: string) => poseCals.some((c) => c.poseId === poseId && c.cameraName === camera && !c.stale);
	const anyVerified = $derived(flat.some((k) => verifyWanted(k.verify, hasRef(k.poseId))));
	const vr = new VerifiedRun();
	vr.onend = () => void invalidateAll();
	onDestroy(() => vr.destroy());
	onMount(() => {
		chosenCamera = loadChosenCamera();
		const r = data.verifiedRun as VerifiedRunSummary | null;
		if (r?.status === 'running') void vr.resume(r._id);
	});
	function playVerified() {
		if (!camera) return;
		if (confirm(`Verified run: the arm will MOVE through "${friendlyName(sequence.name)}" step by step, checking each verified pose with camera ${camera}. A failed check stops it. Is the path clear?`)) void vr.start('sequence', sequence._id, camera);
	}
	const blockedAll = $derived(blocked || vr.active || vr.busy);

	function add() {
		if (!addId) return;
		items = [...items, { moveSetId: addId, joinDurationS: null, joinEasing: 'ease' }];
	}
	function move(i: number, d: number) {
		const j = i + d;
		if (j < 0 || j >= items.length) return;
		const next = [...items];
		[next[i], next[j]] = [next[j], next[i]];
		items = next;
	}
	function remove(i: number) {
		items = items.filter((_, k) => k !== i);
	}
	function setJoin(i: number, raw: string) {
		const v = raw.trim();
		if (!v) items[i].joinDurationS = null;
		else items[i].joinDurationS = Math.min(MAX_TRANSITION_S, Math.max(MIN_TRANSITION_S, Number(v) || MIN_TRANSITION_S));
	}

	const input = 'rounded border bg-black/40 px-2 py-1 text-sm';
	const inputStyle = 'border-color: var(--color-tron-border); color: var(--color-tron-text)';
	const btn = 'min-h-[40px] rounded px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40';
	const cyan = 'background: rgba(56,189,248,0.15); color: var(--color-tron-cyan); border: 1px solid var(--color-tron-cyan);';
	const amber = 'background: rgba(245,158,11,0.15); color: #fbbf24; border: 1px solid #f59e0b;';
	const green = 'background: rgba(74,222,128,0.12); color: #4ade80; border: 1px solid #4ade80;';
	const red = 'background: rgba(239,68,68,0.15); color: #fca5a5; border: 1px solid #ef4444;';
</script>

<div class="mx-auto max-w-7xl space-y-4">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div>
			<a href="/manufacturing/cart-mfg/robot-arm/animate" class="text-xs underline" style="color: var(--color-tron-text-secondary)">← Animate</a>
			<h1 class="text-xl font-bold" style="color: var(--color-tron-cyan)">{friendlyName(sequence.name)}</h1>
		</div>
		<div class="text-xs" style="color: var(--color-tron-text-secondary)">
			{#if stats}{stats.durationS.toFixed(1)} s · {stats.frames} frames · fastest servo {Math.max(...stats.maxStepsPerS)} steps/s{/if}
		</div>
	</div>

	{#if flash?.error}<div class="rounded border border-red-500/40 bg-red-900/10 p-3 text-sm text-red-300">{flash.error}</div>
	{:else if flash?.success}<div class="rounded border border-green-500/40 bg-green-900/10 p-3 text-sm text-green-300">{flash.success}</div>{/if}
	{#if render.error}<div class="rounded border border-red-500/40 bg-red-900/10 p-3 text-sm text-red-300">{render.error}</div>{/if}

	<AnimationCurves path={render.path} jointNames={DEFAULT_JOINT_NAMES} playheadS={playback.running ? Math.max(0, playback.elapsedS - playback.leadInS) : null} />

	{#if playback.running || playback.outcome || playback.error}
		<p class="text-sm" style="color: {playback.error ? '#fca5a5' : playback.running ? '#4ade80' : 'var(--color-tron-text-secondary)'}">
			{#if playback.running}PLAYING · {playback.elapsedS.toFixed(0)} / {playback.durationS.toFixed(1)} s{playback.leadInS ? ` (lead-in ${playback.leadInS} s first)` : ''}
			{:else if playback.error}{playback.error}
			{:else}Playback {playback.outcome}.{/if}
		</p>
		{#if playback.settled}<p class="text-xs" style="color: var(--color-tron-text-secondary)">{playback.settled}</p>{/if}
		{#if playback.warnings.length}<ul class="list-disc pl-5 text-xs" style="color: #f59e0b">{#each playback.warnings as w}<li>{w}</li>{/each}</ul>{/if}
	{/if}
	<VerifiedRunPanel {vr} />

	<form method="POST" action="?/save" use:enhance class="space-y-3 rounded border p-3 sm:p-4" style="border-color: var(--color-tron-border); background: var(--color-tron-surface);">
		<input type="hidden" name="items" value={JSON.stringify(items)} />
		<div class="flex flex-wrap items-end gap-3">
			<label class="block text-xs" style="color: var(--color-tron-text-secondary)">Name<input name="name" bind:value={name} required maxlength="80" class="{input} mt-1 block w-56" style={inputStyle} /></label>
			<label class="block min-w-[14rem] flex-1 text-xs" style="color: var(--color-tron-text-secondary)">Notes<input name="notes" bind:value={notes} maxlength="500" class="{input} mt-1 block w-full" style={inputStyle} /></label>
		</div>

		<table class="w-full text-xs">
			<thead>
				<tr class="text-left" style="color: var(--color-tron-text-secondary)">
					<th class="py-1 pr-2 font-medium">#</th>
					<th class="py-1 pr-2 font-medium">Move set</th>
					<th class="py-1 pr-2 font-medium">Join from previous (s)</th>
					<th class="py-1 pr-2 font-medium">Join easing</th>
					<th class="py-1 font-medium"></th>
				</tr>
			</thead>
			<tbody>
				{#each items as it, i (i)}
					{@const r = resolvedItems[i]}
					<tr class="border-t" style="border-color: var(--color-tron-border)">
						<td class="py-1 pr-2 font-mono" style="color: var(--color-tron-text-secondary)">{i + 1}</td>
						<td class="py-1 pr-2">
							<select bind:value={it.moveSetId} class={input} style={inputStyle}>
								{#each activeMoveSets as m (m._id)}<option value={m._id}>{friendlyName(m.name)} ({m.keyframes.length} poses)</option>{/each}
							</select>
							{#if r?.missing}<span class="ml-1 text-red-300">missing or empty move set</span>{/if}
						</td>
						<td class="py-1 pr-2">
							{#if i === 0}
								<span style="color: var(--color-tron-text-secondary)">start</span>
							{:else}
								<input type="number" step="0.1" min={MIN_TRANSITION_S} max={MAX_TRANSITION_S} value={it.joinDurationS ?? ''} placeholder="auto {r?.autoJoinS ?? ''}" oninput={(e) => setJoin(i, e.currentTarget.value)} class="{input} w-24" style={inputStyle} />
							{/if}
						</td>
						<td class="py-1 pr-2">
							{#if i > 0}
								<select bind:value={it.joinEasing} class={input} style={inputStyle}>
									{#each EASINGS.filter((e) => e.id !== 'flow') as e (e.id)}<option value={e.id}>{e.label}</option>{/each}
								</select>
							{/if}
						</td>
						<td class="py-1 text-right whitespace-nowrap">
							<button type="button" onclick={() => move(i, -1)} class="px-1" style="color: var(--color-tron-cyan)" title="Up">▲</button>
							<button type="button" onclick={() => move(i, 1)} class="px-1" style="color: var(--color-tron-cyan)" title="Down">▼</button>
							<button type="button" onclick={() => remove(i)} class="px-1 text-red-300" title="Remove">✕</button>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
		{#if !items.length}<p class="text-xs" style="color: var(--color-tron-text-secondary)">No move sets yet — add one below. The same move set can appear more than once.</p>{/if}
		{#if problems.length}<ul class="list-disc pl-5 text-xs text-red-300">{#each problems as pr}<li>{pr.message}</li>{/each}</ul>{/if}

		<div class="flex flex-wrap items-end gap-2">
			<label class="block text-xs" style="color: var(--color-tron-text-secondary)">Add move set
				<select bind:value={addId} class="{input} mt-1 block w-56" style={inputStyle}>
					<option value="">choose…</option>
					{#each activeMoveSets as m (m._id)}<option value={m._id}>{friendlyName(m.name)}</option>{/each}
				</select>
			</label>
			<button type="button" onclick={add} disabled={!addId} class="min-h-[34px] rounded px-3 text-sm font-semibold disabled:opacity-40" style={cyan}>Add</button>
			<span class="grow"></span>
			<button type="submit" class={btn} style={green} disabled={!dirty}>{dirty ? 'Save changes' : 'Saved'}</button>
		</div>
		<p class="text-[11px]" style="color: var(--color-tron-text-secondary)">Leave the join blank for an automatic length based on how far the arm has to travel.</p>
	</form>

	<div class="flex flex-wrap items-center gap-2 rounded border p-3 sm:p-4" style="border-color: var(--color-tron-border); background: var(--color-tron-surface);">
		{#if playback.running}
			<button type="button" class={btn} style={red} onclick={() => playback.stop()} disabled={playback.busy}>Stop</button>
		{:else}
			<button type="button" class={btn} style={amber} disabled={blockedAll || dirty || !flat.length || problems.length > 0 || playback.busy}
				title={dirty ? 'Save first' : 'Tween from where the arm is to the first pose, then play the whole sequence'}
				onclick={() => { if (confirm(`The arm will MOVE through "${sequence.name}" from where it is. Is the path clear?`)) playback.play('play', {}, friendlyName(sequence.name)); }}>Play on the arm</button>
			<button type="button" class={btn} style={green} disabled={blockedAll || dirty || !flat.length || problems.length > 0 || !camera || !anyVerified}
				title={dirty ? 'Save first' : !camera ? 'No camera' : !anyVerified ? 'No pose in this sequence has a camera reference' : `Step by step; each verified pose checked with ${camera}. A failed check stops the run.`}
				onclick={playVerified}>◎ Play verified</button>
			<label class="flex items-center gap-1 text-xs" style="color: var(--color-tron-text-secondary)">camera
				<select value={camera} onchange={(e) => { chosenCamera = e.currentTarget.value; saveChosenCamera(e.currentTarget.value); }} class="{input} py-0.5 text-xs" style={inputStyle} aria-label="Camera">
					{#each cameraNames as n (n)}<option value={n}>{n}</option>{/each}
					{#if !cameraNames.length}<option value="">no camera</option>{/if}
				</select>
			</label>
		{/if}
		<form method="POST" action="?/saveToPi" use:enhance class="flex items-end gap-2">
			<label class="block text-xs" style="color: var(--color-tron-text-secondary)">Save on the Pi as recording<input name="recordingName" required maxlength="100" value={friendlyName(sequence.name)} class="{input} mt-1 block w-56" style={inputStyle} /></label>
			<button type="submit" class="min-h-[34px] rounded px-3 text-sm font-semibold disabled:opacity-40" style={cyan} disabled={dirty || !flat.length}>Save to Pi</button>
		</form>
		{#if sequence.savedAs.length}<span class="text-xs" style="color: var(--color-tron-text-secondary)">saved on the Pi</span>{/if}
		<span class="grow"></span>
		<form method="POST" action="?/archive" use:enhance onsubmit={(e) => { if (!confirm('Archive this sequence?')) e.preventDefault(); }}>
			<button type="submit" class="text-xs underline" style="color: var(--color-tron-text-secondary)">archive</button>
		</form>
	</div>
</div>
