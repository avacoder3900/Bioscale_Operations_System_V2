<script lang="ts">
	/**
	 * Robot Arm — Animate tab (ARM-06).
	 *
	 * Top to bottom: what is playing, capture a pose (with the control arm,
	 * or by hand), jog (adjust a pose on the real arm, live), the pose
	 * library, move sets, sequences. See docs/prds/ARM-06-animate.md.
	 * `?jog=<poseId>` opens the jog panel on that pose (linked from the
	 * move-set editor).
	 */
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { onDestroy, onMount } from 'svelte';
	import { buildPath, flattenSequence, DEFAULT_RATE_HZ, type ResolvedKeyframe } from '$lib/robot-arm/animation';
	import { Playback } from '$lib/robot-arm/playback.svelte';
	import PoseJog from '$lib/components/robot-arm/PoseJog.svelte';
	import type { ArmNow, MoveSetSummary, PoseSummary, SequenceSummary } from '$lib/server/robot-arm-animation';

	let { data, form } = $props();

	const poses = $derived((data.poses ?? []) as PoseSummary[]);
	const moveSets = $derived((data.moveSets ?? []) as MoveSetSummary[]);
	const sequences = $derived((data.sequences ?? []) as SequenceSummary[]);
	const activePoses = $derived(poses.filter((p) => !p.archived));
	const poseById = $derived(new Map(poses.map((p) => [p._id, p])));
	const moveSetById = $derived(new Map(moveSets.map((m) => [m._id, m])));

	const flash = $derived(form as { success?: string; warning?: string | null; error?: string; scope?: string; posing?: boolean; armNow?: ArmNow } | null);
	const armNow = $derived((flash?.armNow ?? data.armNow) as ArmNow | null);
	// Torque off = we are mid-capture (whether this page started it or not).
	const posing = $derived(flash?.posing ?? armNow?.torqueOn === false);

	const armReachable = $derived(!!data.arm?.reachable);
	// A teleop session = the follower is following the control arm, whoever started it.
	const leaderPosing = $derived((data.active as { kind?: string } | null)?.kind === 'teleop');
	const busyElsewhere = $derived(!leaderPosing && (data.holder != null || !!data.active));
	const blocked = $derived(!armReachable || busyElsewhere || leaderPosing);
	const blockReason = $derived(
		!armReachable
			? 'The arm is unreachable — check the connection on the Control tab.'
			: leaderPosing
				? 'The follower is following the control arm — press Done first.'
				: busyElsewhere
					? 'The arm is running something — stop it first.'
					: ''
	);

	const playback = new Playback();
	onDestroy(() => playback.destroy());

	let editingPose = $state<string | null>(null);
	let showArchived = $state(false);
	// Jog panel: 'free' = no target pose; a pose id = adjust that pose; null = closed.
	let jogTarget = $state<string | null>(null);
	const jogPose = $derived(jogTarget && jogTarget !== 'free' ? (poseById.get(jogTarget) ?? null) : null);
	onMount(() => {
		const q = page.url.searchParams.get('jog');
		if (q) jogTarget = q === 'free' || poseById.has(q) ? q : null;
	});
	// A pose archived or missing while its panel is open closes the panel.
	$effect(() => {
		if (jogTarget && jogTarget !== 'free' && !poseById.has(jogTarget)) jogTarget = null;
	});

	function resolve(ms: MoveSetSummary): ResolvedKeyframe[] | null {
		const out: ResolvedKeyframe[] = [];
		for (const k of ms.keyframes) {
			const p = poseById.get(k.poseId);
			if (!p) return null;
			out.push({ ...k, name: p.name, positions: p.positions });
		}
		return out;
	}
	function moveSetDuration(ms: MoveSetSummary): string {
		const kfs = resolve(ms);
		if (!kfs || !kfs.length) return '—';
		try {
			return `${buildPath(kfs, { rateHz: ms.rateHz || DEFAULT_RATE_HZ }).durationS.toFixed(1)} s`;
		} catch {
			return '?';
		}
	}
	function sequenceDuration(s: SequenceSummary): string {
		const items = [];
		for (const it of s.items) {
			const ms = moveSetById.get(it.moveSetId);
			const kfs = ms && resolve(ms);
			if (!kfs) return '?';
			items.push({ name: ms.name, keyframes: kfs, join: { durationS: it.joinDurationS, easing: it.joinEasing } });
		}
		const flat = flattenSequence(items);
		if (!flat.length) return '—';
		try {
			return `${buildPath(flat).durationS.toFixed(1)} s`;
		} catch {
			return '?';
		}
	}

	const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '');
	const input = 'mt-1 w-full rounded border bg-black/40 px-2 py-1 text-sm';
	const inputStyle = 'border-color: var(--color-tron-border); color: var(--color-tron-text)';
	const btn = 'min-h-[40px] rounded px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40';
	const cyan = 'background: rgba(56,189,248,0.15); color: var(--color-tron-cyan); border: 1px solid var(--color-tron-cyan);';
	const amber = 'background: rgba(245,158,11,0.15); color: #fbbf24; border: 1px solid #f59e0b;';
	const green = 'background: rgba(74,222,128,0.12); color: #4ade80; border: 1px solid #4ade80;';
	const red = 'background: rgba(239,68,68,0.15); color: #fca5a5; border: 1px solid #ef4444;';
</script>

<div class="mx-auto max-w-7xl space-y-5">
	<div>
		<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan)">Robot Arm — Animate</h1>
		<p class="text-xs" style="color: var(--color-tron-text-secondary)">
			Pose the arm with the control arm (or by hand) and save poses; chain them into move sets with a hold and an easing per pose; chain move sets into sequences. BIMS tweens the smoothest path between poses and the Pi plays it.
		</p>
	</div>

	{#if data.libraryError}<p class="text-xs text-red-300">{data.libraryError}</p>{/if}
	{#if flash?.error}
		<div class="rounded border border-red-500/40 bg-red-900/10 p-3 text-sm text-red-300">{flash.error}</div>
	{:else if flash?.warning}
		<div class="rounded border border-amber-500/40 bg-amber-900/10 p-3 text-sm text-amber-300">{flash.warning}</div>
	{:else if flash?.success}
		<div class="rounded border border-green-500/40 bg-green-900/10 p-3 text-sm text-green-300">{flash.success}</div>
	{/if}

	<!-- PLAYBACK -->
	{#if playback.running || playback.outcome || playback.error}
		<section class="rounded border p-3 sm:p-4" style="border-color: {playback.running ? '#4ade80' : 'var(--color-tron-border)'}; background: var(--color-tron-surface);">
			<div class="flex flex-wrap items-center justify-between gap-3 text-sm">
				<div style="color: var(--color-tron-text)">
					{#if playback.running}
						<span class="font-semibold" style="color: #4ade80">PLAYING</span> {playback.title} · {playback.elapsedS.toFixed(0)} / {playback.durationS.toFixed(1)} s{playback.leadInS ? ` (lead-in ${playback.leadInS} s)` : ''}
					{:else if playback.error}
						<span class="text-red-300">{playback.error}</span>
					{:else}
						{playback.title}: {playback.outcome}.
					{/if}
				</div>
				{#if playback.running}
					<button type="button" class={btn} style={red} onclick={() => playback.stop()} disabled={playback.busy}>Stop</button>
				{/if}
			</div>
			{#if playback.settled}<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">{playback.settled}</p>{/if}
			{#if playback.warnings.length}
				<ul class="mt-1 list-disc pl-5 text-xs" style="color: #f59e0b">{#each playback.warnings as w}<li>{w}</li>{/each}</ul>
			{/if}
		</section>
	{/if}

	<!-- CAPTURE -->
	<section class="rounded border p-3 sm:p-4" style="border-color: {leaderPosing ? '#4ade80' : posing ? '#f59e0b' : 'var(--color-tron-border)'}; background: var(--color-tron-surface);">
		<div class="flex flex-wrap items-start justify-between gap-3">
			<div>
				<h2 class="text-sm font-semibold tracking-wide" style="color: var(--color-tron-text)">CAPTURE A POSE</h2>
				<p class="max-w-2xl text-xs" style="color: var(--color-tron-text-secondary)">
					<b>Pose with the control arm</b> makes the follower track the control (leader) arm with torque on, so it never sags and the saved
					position is where you put it. Move the control arm, name the pose, <b>Save pose</b>; repeat; <b>Done</b> when finished (the follower
					keeps holding). Posing <b>by hand</b> turns torque off instead: the arm sags and poses can land off; it is kept for when the control arm is not connected.
				</p>
			</div>
			<div class="text-right text-xs" style="color: var(--color-tron-text-secondary)">
				{#if armNow}
					Torque <span class="font-semibold" style="color: {armNow.torqueOn === false ? '#f59e0b' : armNow.torqueOn ? '#4ade80' : 'var(--color-tron-text-secondary)'}">{armNow.torqueOn === false ? 'OFF' : armNow.torqueOn ? 'ON' : '?'}</span>
					<div class="font-mono">{armNow.positions.map((p, i) => `J${i + 1} ${p}`).join(' · ')}</div>
				{:else}
					Arm not read{data.armNowError ? `: ${data.armNowError}` : ''}
				{/if}
			</div>
		</div>

		{#if leaderPosing}
			<div class="mt-3 rounded border border-emerald-500/60 bg-emerald-900/15 p-3 text-sm text-emerald-200">
				<b>Following the control arm.</b> The follower is powered and tracking it. Move the control arm into the pose, keep it still, then save. Saving pauses
				the follower for a moment (it holds), reads it, then follows again.
			</div>
		{:else if posing}
			<div class="mt-3 rounded border border-amber-500/60 bg-amber-900/15 p-3 text-sm text-amber-200">
				<b>Torque is OFF.</b> Support the arm. Move it into the pose, keep holding it, then save.
			</div>
		{/if}

		<div class="mt-3 flex flex-wrap items-end gap-3">
			{#if leaderPosing}
				<form method="POST" action="?/saveLeaderPose" use:enhance class="flex flex-wrap items-end gap-2">
					<input type="hidden" name="resume" value="1" />
					<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
						Pose name
						<input name="name" required maxlength="80" placeholder="e.g. Over tray" class="{input} w-48" style={inputStyle} />
					</label>
					<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
						Notes (optional)
						<input name="notes" maxlength="500" class="{input} w-56" style={inputStyle} />
					</label>
					<button type="submit" class={btn} style={green} disabled={!armReachable}>Save pose</button>
				</form>
				<form method="POST" action="?/stopLeaderPosing" use:enhance>
					<button type="submit" class={btn} style={cyan} disabled={!armReachable} title="Stop following; the follower holds where it is">Done</button>
				</form>
			{:else}
				{#if !posing}
					<form method="POST" action="?/poseWithLeader" use:enhance onsubmit={(e) => { if (!confirm('The follower will move to wherever the control arm is now, then follow it. Is the control arm roughly matching the follower and is the path clear?')) e.preventDefault(); }}>
						<button type="submit" class={btn} style={green} disabled={blocked}>Pose with the control arm</button>
					</form>
					<form method="POST" action="?/poseByHand" use:enhance onsubmit={(e) => { if (!confirm('The arm will go LIMP (torque off). Are you supporting it?')) e.preventDefault(); }}>
						<button type="submit" class={btn} style={amber} disabled={blocked}>Pose by hand (torque off)</button>
					</form>
				{/if}
				<form method="POST" action="?/savePose" use:enhance class="flex flex-wrap items-end gap-2">
					<input type="hidden" name="hold" value={posing ? '1' : '0'} />
					<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
						Pose name
						<input name="name" required maxlength="80" placeholder="e.g. Over tray" class="{input} w-48" style={inputStyle} />
					</label>
					<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
						Notes (optional)
						<input name="notes" maxlength="500" class="{input} w-56" style={inputStyle} />
					</label>
					<button type="submit" class={btn} style={green} disabled={!armReachable}>{posing ? 'Save pose (then torque on)' : 'Save pose from where the arm is'}</button>
				</form>
				<form method="POST" action="?/holdArm" use:enhance>
					<button type="submit" class={btn} style={cyan} disabled={!armReachable} title="Torque on where the arm is, no jump">Hold (torque on)</button>
				</form>
				{#if !posing && jogTarget !== 'free'}
					<button type="button" class={btn} style={cyan} disabled={blocked} title="Nudge each joint a few steps at a time and save the result as a pose" onclick={() => (jogTarget = 'free')}>Jog the arm</button>
				{/if}
			{/if}
			{#if blocked && !leaderPosing}<span class="text-xs" style="color: #f59e0b">{blockReason}</span>{/if}
		</div>
	</section>

	<!-- JOG -->
	{#if jogTarget}
		{#key jogTarget}
			<PoseJog pose={jogPose} initial={armNow} {armReachable} blocked={blocked || posing} blockReason={posing ? 'Torque is off — press Hold (torque on) first.' : blockReason} onclose={() => (jogTarget = null)} />
		{/key}
	{/if}

	<!-- POSES -->
	<section class="rounded border p-3 sm:p-4" style="border-color: var(--color-tron-border); background: var(--color-tron-surface);">
		<h2 class="text-sm font-semibold tracking-wide" style="color: var(--color-tron-text)">POSES</h2>
		{#if !activePoses.length}
			<p class="mt-2 text-xs" style="color: var(--color-tron-text-secondary)">No poses yet — capture one above.</p>
		{/if}
		<ul class="mt-2 space-y-1">
			{#each activePoses as p (p._id)}
				<li class="rounded border px-2 py-1.5" style="border-color: var(--color-tron-border)">
					{#if editingPose === p._id}
						<form method="POST" action="?/updatePose" use:enhance={() => async ({ update }) => { await update(); editingPose = null; }} class="flex flex-wrap items-end gap-2">
							<input type="hidden" name="id" value={p._id} />
							<input name="name" required maxlength="80" value={p.name} class="{input} w-48" style={inputStyle} aria-label="Name" />
							<input name="notes" maxlength="500" value={p.notes ?? ''} class="{input} w-56" style={inputStyle} aria-label="Notes" />
							<label class="flex items-center gap-1 text-xs" style="color: var(--color-tron-text-secondary)"><input type="checkbox" name="fromArm" value="1" /> re-capture from the arm now</label>
							<button type="submit" class="min-h-[30px] rounded px-3 text-xs font-semibold" style="color: #4ade80; border: 1px solid #4ade80;">Save</button>
							<button type="button" onclick={() => (editingPose = null)} class="px-2 text-xs" style="color: var(--color-tron-text-secondary)">cancel</button>
						</form>
					{:else}
						<div class="flex flex-wrap items-center gap-2 text-sm">
							<span style="color: var(--color-tron-text)">{p.name}</span>
							<span class="font-mono text-[11px]" style="color: var(--color-tron-text-secondary)">{p.positions.join(' ')}</span>
							{#if p.notes}<span class="text-xs" style="color: var(--color-tron-text-secondary)">{p.notes}</span>{/if}
							<span class="grow"></span>
							<form method="POST" action="?/goToPose" use:enhance onsubmit={(e) => { if (!confirm(`The arm will MOVE to "${p.name}". Is the path clear?`)) e.preventDefault(); }}>
								<input type="hidden" name="id" value={p._id} />
								<button type="submit" class="text-xs underline" style="color: #fbbf24" disabled={blocked || posing}>go to</button>
							</form>
							<button type="button" onclick={() => (jogTarget = jogTarget === p._id ? null : p._id)} class="text-xs underline" style="color: {jogTarget === p._id ? '#fbbf24' : 'var(--color-tron-cyan)'}" title="Adjust this pose by jogging the arm, live">{jogTarget === p._id ? 'jogging' : 'jog'}</button>
							<button type="button" onclick={() => (editingPose = p._id)} class="text-xs underline" style="color: var(--color-tron-cyan)">edit</button>
							<form method="POST" action="?/archivePose" use:enhance>
								<input type="hidden" name="id" value={p._id} />
								<button type="submit" class="text-xs underline" style="color: var(--color-tron-text-secondary)">archive</button>
							</form>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
		{#if poses.some((p) => p.archived)}
			<button type="button" onclick={() => (showArchived = !showArchived)} class="mt-2 text-xs underline" style="color: var(--color-tron-text-secondary)">{showArchived ? 'Hide' : 'Show'} archived poses</button>
			{#if showArchived}
				<ul class="mt-1 space-y-1 text-xs" style="color: var(--color-tron-text-secondary)">
					{#each poses.filter((p) => p.archived) as p (p._id)}
						<li class="flex items-center gap-2">{p.name}
							<form method="POST" action="?/archivePose" use:enhance><input type="hidden" name="id" value={p._id} /><input type="hidden" name="restore" value="1" /><button type="submit" class="underline" style="color: var(--color-tron-cyan)">restore</button></form>
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</section>

	<!-- MOVE SETS -->
	<section class="rounded border p-3 sm:p-4" style="border-color: var(--color-tron-border); background: var(--color-tron-surface);">
		<div class="flex flex-wrap items-end justify-between gap-3">
			<div>
				<h2 class="text-sm font-semibold tracking-wide" style="color: var(--color-tron-text)">MOVE SETS</h2>
				<p class="text-xs" style="color: var(--color-tron-text-secondary)">An ordered run of poses with a hold and an easing each.</p>
			</div>
			<form method="POST" action="?/createMoveSet" use:enhance class="flex items-end gap-2">
				<label class="block text-xs" style="color: var(--color-tron-text-secondary)">New move set<input name="name" required maxlength="80" placeholder="e.g. Wave" class="{input} w-48" style={inputStyle} /></label>
				<button type="submit" class="min-h-[34px] rounded px-3 text-sm font-semibold" style={cyan}>Create</button>
			</form>
		</div>
		<ul class="mt-2 space-y-1">
			{#each moveSets.filter((m) => !m.archived) as m (m._id)}
				<li class="flex flex-wrap items-center gap-2 rounded border px-2 py-1.5 text-sm" style="border-color: var(--color-tron-border)">
					<a href="/manufacturing/cart-mfg/robot-arm/animate/moveset/{m._id}" class="underline" style="color: var(--color-tron-cyan)">{m.name}</a>
					<span class="text-xs" style="color: var(--color-tron-text-secondary)">{m.keyframes.length} pose(s) · {moveSetDuration(m)}{m.lastPlay ? ` · played ${when(m.lastPlay.at)}` : ''}</span>
					<span class="grow"></span>
					<button type="button" class="text-xs underline" style="color: #fbbf24" disabled={blocked || posing || playback.running || !m.keyframes.length}
						onclick={() => { if (confirm(`The arm will MOVE through "${m.name}" from where it is. Is the path clear?`)) playback.play('playMoveSet', { id: m._id }, m.name); }}>play</button>
					<form method="POST" action="?/archiveMoveSet" use:enhance><input type="hidden" name="id" value={m._id} /><button type="submit" class="text-xs underline" style="color: var(--color-tron-text-secondary)">archive</button></form>
				</li>
			{/each}
		</ul>
		{#if !moveSets.some((m) => !m.archived)}<p class="mt-2 text-xs" style="color: var(--color-tron-text-secondary)">No move sets yet.</p>{/if}
	</section>

	<!-- SEQUENCES -->
	<section class="rounded border p-3 sm:p-4" style="border-color: var(--color-tron-border); background: var(--color-tron-surface);">
		<div class="flex flex-wrap items-end justify-between gap-3">
			<div>
				<h2 class="text-sm font-semibold tracking-wide" style="color: var(--color-tron-text)">SEQUENCES</h2>
				<p class="text-xs" style="color: var(--color-tron-text-secondary)">Move sets one after another; BIMS tweens between them.</p>
			</div>
			<form method="POST" action="?/createSequence" use:enhance class="flex items-end gap-2">
				<label class="block text-xs" style="color: var(--color-tron-text-secondary)">New sequence<input name="name" required maxlength="80" placeholder="e.g. Demo loop" class="{input} w-48" style={inputStyle} /></label>
				<button type="submit" class="min-h-[34px] rounded px-3 text-sm font-semibold" style={cyan}>Create</button>
			</form>
		</div>
		<ul class="mt-2 space-y-1">
			{#each sequences.filter((s) => !s.archived) as s (s._id)}
				<li class="flex flex-wrap items-center gap-2 rounded border px-2 py-1.5 text-sm" style="border-color: var(--color-tron-border)">
					<a href="/manufacturing/cart-mfg/robot-arm/animate/sequence/{s._id}" class="underline" style="color: var(--color-tron-cyan)">{s.name}</a>
					<span class="text-xs" style="color: var(--color-tron-text-secondary)">{s.items.length} move set(s) · {sequenceDuration(s)}{s.savedAs.length ? ` · on the Pi as ${s.savedAs[s.savedAs.length - 1].name}` : ''}</span>
					<span class="grow"></span>
					<button type="button" class="text-xs underline" style="color: #fbbf24" disabled={blocked || posing || playback.running || !s.items.length}
						onclick={() => { if (confirm(`The arm will MOVE through "${s.name}" from where it is. Is the path clear?`)) playback.play('playSequence', { id: s._id }, s.name); }}>play</button>
					<form method="POST" action="?/archiveSequence" use:enhance><input type="hidden" name="id" value={s._id} /><button type="submit" class="text-xs underline" style="color: var(--color-tron-text-secondary)">archive</button></form>
				</li>
			{/each}
		</ul>
		{#if !sequences.some((s) => !s.archived)}<p class="mt-2 text-xs" style="color: var(--color-tron-text-secondary)">No sequences yet.</p>{/if}
	</section>
</div>
