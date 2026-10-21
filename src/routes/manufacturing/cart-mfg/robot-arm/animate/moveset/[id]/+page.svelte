<script lang="ts">
	/**
	 * ARM-06 — move-set editor: keyframes (pose, arrival duration, easing,
	 * hold) with the rendered path drawn live from the pure engine, Play,
	 * Stop and Save to Pi.
	 */
	import { enhance } from '$app/forms';
	import { onDestroy } from 'svelte';
	import AnimationCurves from '$lib/components/robot-arm/AnimationCurves.svelte';
	import { buildPath, minDurationS, pathStats, tooFast, DEFAULT_RATE_HZ, EASINGS, MAX_HOLD_S, MAX_STEPS_PER_S, MAX_TRANSITION_S, MIN_TRANSITION_S, type Keyframe, type RenderedPath, type ResolvedKeyframe } from '$lib/robot-arm/animation';
	import { DEFAULT_JOINT_NAMES } from '$lib/robot-arm/recording-cleanup';
	import { Playback } from '$lib/robot-arm/playback.svelte';
	import type { MoveSetSummary, PoseSummary } from '$lib/server/robot-arm-animation';

	let { data, form } = $props();

	const moveSet = $derived(data.moveSet as MoveSetSummary);
	const poses = $derived((data.poses ?? []) as PoseSummary[]);
	const poseById = $derived(new Map(poses.map((p) => [p._id, p])));
	const activePoses = $derived(poses.filter((p) => !p.archived));

	const flash = $derived(form as { success?: string; error?: string } | null);
	const armReachable = $derived(!!data.arm?.reachable);
	const blocked = $derived(!armReachable || data.holder != null || !!data.active);

	// Local copy of the keyframes; Save posts it as JSON.
	let name = $state('');
	let notes = $state('');
	let kfs = $state<Keyframe[]>([]);
	let saved = $state('');
	let selected = $state<number | null>(null);
	let addPoseId = $state('');
	$effect(() => {
		name = moveSet.name;
		notes = moveSet.notes ?? '';
		kfs = moveSet.keyframes.map((k) => ({ ...k }));
		saved = JSON.stringify(moveSet.keyframes) + moveSet.name + (moveSet.notes ?? '');
	});
	const dirty = $derived(JSON.stringify(kfs) + name + notes !== saved);

	const resolved = $derived.by((): ResolvedKeyframe[] => {
		const out: ResolvedKeyframe[] = [];
		for (const k of kfs) {
			const p = poseById.get(k.poseId);
			if (p) out.push({ ...k, name: p.name, positions: p.positions });
		}
		return out;
	});
	const render = $derived.by((): { path: RenderedPath | null; error: string | null } => {
		if (!resolved.length) return { path: null, error: null };
		try {
			return { path: buildPath(resolved, { rateHz: moveSet.rateHz || DEFAULT_RATE_HZ }), error: null };
		} catch (e) {
			return { path: null, error: e instanceof Error ? e.message : String(e) };
		}
	});
	const stats = $derived(render.path ? pathStats(render.path) : null);
	const problems = $derived(tooFast(resolved));
	const minFor = (i: number) => (i > 0 && resolved[i - 1] && resolved[i] ? minDurationS(resolved[i - 1].positions, resolved[i].positions, MAX_STEPS_PER_S, resolved[i].easing) : 0);

	const playback = new Playback();
	onDestroy(() => playback.destroy());

	function add() {
		if (!addPoseId) return;
		kfs = [...kfs, { poseId: addPoseId, holdS: 0.5, durationS: 1.5, easing: 'ease' }];
		selected = kfs.length - 1;
	}
	function move(i: number, d: number) {
		const j = i + d;
		if (j < 0 || j >= kfs.length) return;
		const next = [...kfs];
		[next[i], next[j]] = [next[j], next[i]];
		kfs = next;
		selected = j;
	}
	function remove(i: number) {
		kfs = kfs.filter((_, k) => k !== i);
		selected = null;
	}
	const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));

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
			<h1 class="text-xl font-bold" style="color: var(--color-tron-cyan)">Move set: {moveSet.name}</h1>
		</div>
		<div class="text-xs" style="color: var(--color-tron-text-secondary)">
			{#if stats}{stats.durationS.toFixed(1)} s · {stats.frames} frames @ {moveSet.rateHz} Hz · fastest servo {Math.max(...stats.maxStepsPerS)} steps/s{/if}
		</div>
	</div>

	{#if flash?.error}<div class="rounded border border-red-500/40 bg-red-900/10 p-3 text-sm text-red-300">{flash.error}</div>
	{:else if flash?.success}<div class="rounded border border-green-500/40 bg-green-900/10 p-3 text-sm text-green-300">{flash.success}</div>{/if}
	{#if render.error}<div class="rounded border border-red-500/40 bg-red-900/10 p-3 text-sm text-red-300">{render.error}</div>{/if}

	<AnimationCurves path={render.path} jointNames={DEFAULT_JOINT_NAMES} playheadS={playback.running ? Math.max(0, playback.elapsedS - playback.leadInS) : null} selectedIndex={selected} onselect={(i) => (selected = i)} />

	{#if playback.running || playback.outcome || playback.error}
		<p class="text-sm" style="color: {playback.error ? '#fca5a5' : playback.running ? '#4ade80' : 'var(--color-tron-text-secondary)'}">
			{#if playback.running}PLAYING · {playback.elapsedS.toFixed(0)} / {playback.durationS.toFixed(1)} s{playback.leadInS ? ` (lead-in ${playback.leadInS} s first)` : ''}
			{:else if playback.error}{playback.error}
			{:else}Playback {playback.outcome}.{/if}
		</p>
		{#if playback.warnings.length}<ul class="list-disc pl-5 text-xs" style="color: #f59e0b">{#each playback.warnings as w}<li>{w}</li>{/each}</ul>{/if}
	{/if}

	<form method="POST" action="?/save" use:enhance class="space-y-3 rounded border p-3 sm:p-4" style="border-color: var(--color-tron-border); background: var(--color-tron-surface);">
		<input type="hidden" name="keyframes" value={JSON.stringify(kfs)} />
		<div class="flex flex-wrap items-end gap-3">
			<label class="block text-xs" style="color: var(--color-tron-text-secondary)">Name<input name="name" bind:value={name} required maxlength="80" class="{input} mt-1 block w-56" style={inputStyle} /></label>
			<label class="block min-w-[14rem] flex-1 text-xs" style="color: var(--color-tron-text-secondary)">Notes<input name="notes" bind:value={notes} maxlength="500" class="{input} mt-1 block w-full" style={inputStyle} /></label>
		</div>

		<table class="w-full text-xs">
			<thead>
				<tr class="text-left" style="color: var(--color-tron-text-secondary)">
					<th class="py-1 pr-2 font-medium">#</th>
					<th class="py-1 pr-2 font-medium">Pose</th>
					<th class="py-1 pr-2 font-medium">Arrive in (s)</th>
					<th class="py-1 pr-2 font-medium">Easing</th>
					<th class="py-1 pr-2 font-medium">Hold (s)</th>
					<th class="py-1 font-medium"></th>
				</tr>
			</thead>
			<tbody>
				{#each kfs as k, i (i)}
					{@const p = poseById.get(k.poseId)}
					{@const min = minFor(i)}
					<tr class="border-t" style="border-color: var(--color-tron-border); background: {selected === i ? 'rgba(56,189,248,0.08)' : 'transparent'}" onclick={() => (selected = i)}>
						<td class="py-1 pr-2 font-mono" style="color: var(--color-tron-text-secondary)">{i + 1}</td>
						<td class="py-1 pr-2">
							<select bind:value={k.poseId} class={input} style={inputStyle}>
								{#if p?.archived}<option value={p._id}>{p.name} (archived)</option>{/if}
								{#each activePoses as ap (ap._id)}<option value={ap._id}>{ap.name}</option>{/each}
							</select>
							{#if !p}<span class="ml-1 text-red-300">missing pose</span>{/if}
						</td>
						<td class="py-1 pr-2">
							{#if i === 0}
								<span style="color: var(--color-tron-text-secondary)">start</span>
							{:else}
								<input type="number" step="0.1" min={MIN_TRANSITION_S} max={MAX_TRANSITION_S} value={k.durationS} oninput={(e) => (k.durationS = clamp(Number(e.currentTarget.value), MIN_TRANSITION_S, MAX_TRANSITION_S))} class="{input} w-20" style="{inputStyle}; {k.durationS < min ? 'border-color: #ef4444' : ''}" />
								{#if min}<span class="ml-1" style="color: {k.durationS < min ? '#fca5a5' : 'var(--color-tron-text-secondary)'}">min {min}</span>{/if}
							{/if}
						</td>
						<td class="py-1 pr-2">
							{#if i === 0}
								<span style="color: var(--color-tron-text-secondary)">—</span>
							{:else}
								<select bind:value={k.easing} class={input} style={inputStyle} title={EASINGS.find((e) => e.id === k.easing)?.hint}>
									{#each EASINGS as e (e.id)}<option value={e.id}>{e.label}</option>{/each}
								</select>
							{/if}
						</td>
						<td class="py-1 pr-2"><input type="number" step="0.1" min="0" max={MAX_HOLD_S} value={k.holdS} oninput={(e) => (k.holdS = clamp(Number(e.currentTarget.value), 0, MAX_HOLD_S))} class="{input} w-20" style={inputStyle} /></td>
						<td class="py-1 text-right whitespace-nowrap">
							<button type="button" onclick={() => move(i, -1)} class="px-1" style="color: var(--color-tron-cyan)" title="Up">▲</button>
							<button type="button" onclick={() => move(i, 1)} class="px-1" style="color: var(--color-tron-cyan)" title="Down">▼</button>
							<button type="button" onclick={() => remove(i)} class="px-1 text-red-300" title="Remove">✕</button>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
		{#if !kfs.length}<p class="text-xs" style="color: var(--color-tron-text-secondary)">No poses yet — add one below. The first pose is where the move set starts; Play tweens the arm there first.</p>{/if}
		{#if problems.length}<ul class="list-disc pl-5 text-xs text-red-300">{#each problems as pr}<li>{pr.message}</li>{/each}</ul>{/if}

		<div class="flex flex-wrap items-end gap-2">
			<label class="block text-xs" style="color: var(--color-tron-text-secondary)">Add pose
				<select bind:value={addPoseId} class="{input} mt-1 block w-56" style={inputStyle}>
					<option value="">choose…</option>
					{#each activePoses as ap (ap._id)}<option value={ap._id}>{ap.name}</option>{/each}
				</select>
			</label>
			<button type="button" onclick={add} disabled={!addPoseId} class="min-h-[34px] rounded px-3 text-sm font-semibold disabled:opacity-40" style={cyan}>Add</button>
			<span class="grow"></span>
			<button type="submit" class={btn} style={green} disabled={!dirty}>{dirty ? 'Save changes' : 'Saved'}</button>
		</div>
		<p class="text-[11px]" style="color: var(--color-tron-text-secondary)">
			Easy ease settles into each pose; Flow through keeps moving through a pose that is not held (both its arrival and the next pose's must be Flow). Hold waits at the pose. Shaded bands on the chart are holds.
		</p>
	</form>

	<div class="flex flex-wrap items-center gap-2 rounded border p-3 sm:p-4" style="border-color: var(--color-tron-border); background: var(--color-tron-surface);">
		{#if playback.running}
			<button type="button" class={btn} style={red} onclick={() => playback.stop()} disabled={playback.busy}>Stop</button>
		{:else}
			<button type="button" class={btn} style={amber} disabled={blocked || dirty || !kfs.length || problems.length > 0 || playback.busy}
				title={dirty ? 'Save first' : 'Tween from where the arm is to the first pose, then play'}
				onclick={() => { if (confirm(`The arm will MOVE through "${moveSet.name}" from where it is. Is the path clear?`)) playback.play('play', {}, moveSet.name); }}>Play on the arm</button>
		{/if}
		<form method="POST" action="?/saveToPi" use:enhance class="flex items-end gap-2">
			<label class="block text-xs" style="color: var(--color-tron-text-secondary)">Save on the Pi as recording<input name="recordingName" required maxlength="100" value={moveSet.name} class="{input} mt-1 block w-56" style={inputStyle} /></label>
			<button type="submit" class="min-h-[34px] rounded px-3 text-sm font-semibold disabled:opacity-40" style={cyan} disabled={dirty || !kfs.length}>Save to Pi</button>
		</form>
		<span class="grow"></span>
		<form method="POST" action="?/archive" use:enhance onsubmit={(e) => { if (!confirm('Archive this move set?')) e.preventDefault(); }}>
			<button type="submit" class="text-xs underline" style="color: var(--color-tron-text-secondary)">archive</button>
		</form>
	</div>
</div>
