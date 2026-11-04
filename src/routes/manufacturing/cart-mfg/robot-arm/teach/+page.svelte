<script lang="ts">
	/**
	 * Robot Arm — Animate tab (ARM-06, redone 2026-10-22 — PRD §13).
	 *
	 * Left: the pose editor — one slider per servo; with Live on, the arm
	 * follows the sliders. Above it, the control arm for quick rough posing.
	 * Right: the pose library (click a pose to edit it). Below: move sets
	 * and sequences. `?edit=<poseId>` opens that pose in the editor.
	 * "select" in the library ticks many poses to archive at once; the
	 * archived list restores many, or deletes unused ones for good.
	 * Under the pose editor, the trapdoor solenoids: test fire A or B (fire
	 * steps themselves are added in the move-set editor).
	 */
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { onDestroy, onMount, tick } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import {
		flattenSequence,
		friendlyName,
		heatCheck,
		heatLevel,
		poseGroup,
		daysLeftLabel,
		previewPath,
		resolveForPreview,
		stepCountLabel,
		DEFAULT_RATE_HZ,
		SERVO_TEMP_STOP_C,
		type ResolvedKeyframe,
		type SolenoidStatus
	} from '$lib/robot-arm/animation';
	import SolenoidPanel from '$lib/components/robot-arm/SolenoidPanel.svelte';
	import ConveyorPanel from '$lib/components/robot-arm/ConveyorPanel.svelte';
	import TeleopRecordPanel from '$lib/components/robot-arm/TeleopRecordPanel.svelte';
	import { Playback } from '$lib/robot-arm/playback.svelte';
	import PoseEditor from '$lib/components/robot-arm/PoseEditor.svelte';
	import PoseCameraCard from '$lib/components/robot-arm/PoseCameraCard.svelte';
	import VerifiedRunPanel from '$lib/components/robot-arm/VerifiedRunPanel.svelte';
	import { VerifiedRun } from '$lib/robot-arm/verified-run.svelte';
	import { loadChosenCamera, pickCamera, saveChosenCamera } from '$lib/robot-arm/arm-camera';
	import type { MoveSetSummary, PoseSummary, SequenceSummary } from '$lib/server/robot-arm-animation';
	import type { PoseCalibrationSummary, VerifiedRunSummary } from '$lib/server/robot-arm-verified';
	import type { CameraStatus } from '$lib/server/robot-arm-client';

	let { data, form } = $props();

	type ArmRead = { positions: number[]; temps: (number | null)[]; torqueOn: boolean | null };
	const poses = $derived((data.poses ?? []) as PoseSummary[]);
	const moveSets = $derived((data.moveSets ?? []) as MoveSetSummary[]);
	const sequences = $derived((data.sequences ?? []) as SequenceSummary[]);
	const activePoses = $derived(poses.filter((p) => !p.archived));
	const poseById = $derived(new Map(poses.map((p) => [p._id, p])));
	const moveSetById = $derived(new Map(moveSets.map((m) => [m._id, m])));
	const sequenceById = $derived(new Map(sequences.map((q) => [q._id, q])));
	const armNow = $derived(data.armNow as ArmRead | null);

	const flash = $derived(form as { success?: string; warning?: string | null; error?: string; createdPoseId?: string } | null);

	const armReachable = $derived(!!data.arm?.reachable);
	// A teleop session = the follower is following the control arm, whoever started it.
	const following = $derived((data.active as { kind?: string } | null)?.kind === 'teleop');
	const busyElsewhere = $derived(!following && (data.holder != null || !!data.active));

	const playback = new Playback();
	playback.onend = () => void invalidateAll();
	onDestroy(() => playback.destroy());

	// ARM-09: pose camera references and the verified run. The camera is the one remembered from the Vision tab.
	const poseCals = $derived((data.poseCalibrations ?? []) as PoseCalibrationSummary[]);
	const cameraNames = $derived([...new Set([...((data.cameras ?? []) as CameraStatus[]).map((c) => c.name), ...poseCals.map((c) => c.cameraName)])]);
	let chosenCamera = $state<string | null>(null);
	const camera = $derived(pickCamera(cameraNames, chosenCamera, poseCals.map((c) => c.cameraName)));
	function setCamera(n: string) {
		chosenCamera = n;
		saveChosenCamera(n);
	}
	const calFor = (poseId: string): PoseCalibrationSummary | null => poseCals.find((c) => c.poseId === poseId && c.cameraName === camera) ?? null;
	/**
	 * How many of a set's (or a sequence's) steps have a camera reference for
	 * the chosen camera, and how many of those are stale. The Verified run
	 * button is coloured by this, so a green circle on a row means "every step
	 * is covered", not merely "you may press this" (2026-10-23: all rows read
	 * green while no move set had a single reference).
	 */
	function coverage(ms: MoveSetSummary | null, sq: SequenceSummary | null): { ok: number; stale: number; total: number } {
		const sets = ms ? [ms] : (sq?.items ?? []).map((i) => moveSetById.get(i.moveSetId)).filter((m): m is MoveSetSummary => !!m);
		let ok = 0;
		let stale = 0;
		let total = 0;
		for (const m of sets)
			for (const k of m.keyframes) {
				if (k.fire) continue; // fire steps are never camera-checked
				total++;
				const c = calFor(k.poseId);
				if (c) c.stale ? stale++ : ok++;
			}
		return { ok, stale, total };
	}
	// Home (Vision tab calibration) for the chosen camera, else any camera's: the editor's default reference marker.
	const homeSteps = $derived((data.homeSteps ?? {}) as Record<string, (number | null)[]>);
	const home = $derived(homeSteps[camera] ?? Object.values(homeSteps)[0] ?? null);
	const vr = new VerifiedRun();
	vr.onend = () => void invalidateAll();
	onDestroy(() => vr.destroy());
	onMount(() => {
		chosenCamera = loadChosenCamera();
		const r = data.verifiedRun as VerifiedRunSummary | null;
		if (r?.status === 'running') void vr.resume(r._id);
	});
	function verified(kind: 'move_set' | 'sequence', id: string, name: string) {
		if (!camera) return;
		if (confirm(`Verified run: the arm will MOVE through "${friendlyName(name)}" step by step, checking each verified pose with camera ${camera}. A failed check stops it. Is the path clear?`)) void vr.start(kind, id, camera);
	}

	const blocked = $derived(!armReachable || busyElsewhere || following || playback.running || playback.busy || vr.active || vr.busy);
	const blockReason = $derived(
		!armReachable
			? 'The arm is unreachable.'
			: following
				? 'Following the control arm.'
				: playback.running || playback.busy
					? 'The arm is playing.'
					: vr.active || vr.busy
						? 'A verified run is in progress.'
						: busyElsewhere
							? 'The arm is running something.'
							: ''
	);

	// Which pose is in the editor: an id, or 'new'.
	let editing = $state<string>('new');
	const editPose = $derived(editing !== 'new' ? (poseById.get(editing) ?? null) : null);
	onMount(() => {
		const q = page.url.searchParams.get('edit') ?? page.url.searchParams.get('jog');
		if (q && poseById.has(q)) editing = q;
	});
	$effect(() => {
		if (editing !== 'new' && !poseById.has(editing)) editing = 'new';
	});
	$effect(() => {
		if (flash?.createdPoseId && poseById.has(flash.createdPoseId)) editing = flash.createdPoseId;
	});

	// Library, grouped: poses made together (a clean-up sent here) share a "<group> · " prefix.
	const grouped = $derived.by(() => {
		const loose: PoseSummary[] = [];
		const groups = new Map<string, PoseSummary[]>();
		for (const p of activePoses) {
			const g = poseGroup(p.name).group;
			if (!g) loose.push(p);
			else groups.set(g, [...(groups.get(g) ?? []), p]);
		}
		return { loose, groups: [...groups.entries()] };
	});
	let renaming = $state<string | null>(null);
	let showArchived = $state(false);
	// Poses card Hide/Show (2026-11-04); shown by default, an explicit Hide is remembered.
	const POSES_HIDDEN_KEY = 'robot-arm:teach-poses-hidden';
	let posesHidden = $state(false);
	$effect(() => {
		try {
			posesHidden = localStorage.getItem(POSES_HIDDEN_KEY) === '1';
		} catch {
			/* storage unavailable — default to shown */
		}
	});
	function setPosesHidden(value: boolean) {
		posesHidden = value;
		try {
			localStorage.setItem(POSES_HIDDEN_KEY, value ? '1' : '0');
		} catch {
			/* ignore */
		}
	}

	// Select mode: tick live poses to archive them; archived ones are ticked to restore or delete for good.
	let selecting = $state(false);
	const picked = new SvelteSet<string>();
	const pickedArchived = new SvelteSet<string>();
	const archivedPoses = $derived(poses.filter((p) => p.archived));
	const pickedLive = $derived(activePoses.filter((p) => picked.has(p._id)).map((p) => p._id));
	const pickedOld = $derived(archivedPoses.filter((p) => pickedArchived.has(p._id)).map((p) => p._id));
	// Show Deleted draws a page at a time (hundreds of rows lagged the page): newest deletions first, searchable.
	const DELETED_PAGE = 20;
	let deletedQuery = $state('');
	let deletedLimit = $state(DELETED_PAGE);
	const deletedMatches = $derived.by(() => {
		const q = deletedQuery.trim().toLowerCase();
		const hits = q ? archivedPoses.filter((p) => friendlyName(p.name).toLowerCase().includes(q) || p.name.toLowerCase().includes(q)) : archivedPoses;
		return [...hits].sort((a, b) => (b.deletesAt ?? '').localeCompare(a.deletesAt ?? ''));
	});
	const deletedShown = $derived(deletedMatches.slice(0, deletedLimit));
	// How many move sets (archived ones too) use each pose: those poses can be restored but never deleted.
	const setsUsing = $derived.by(() => {
		const n = new Map<string, number>();
		for (const ms of moveSets) for (const id of new Set(ms.keyframes.filter((k) => !k.fire).map((k) => k.poseId))) n.set(id, (n.get(id) ?? 0) + 1);
		return n;
	});
	const pickedDeletable = $derived(pickedOld.filter((id) => !setsUsing.has(id)));

	// Library marks. Link: used by a live move set (poses) or a live sequence (move sets).
	// Drop: used by the wax-fill run's chosen animations — a chosen sequence, the move
	// sets it holds (or a move set chosen directly), and every pose in those move sets.
	const liveSetsUsing = $derived.by(() => {
		const n = new Map<string, number>();
		for (const ms of moveSets) if (!ms.archived) for (const id of new Set(ms.keyframes.filter((k) => !k.fire).map((k) => k.poseId))) n.set(id, (n.get(id) ?? 0) + 1);
		return n;
	});
	const seqsUsing = $derived.by(() => {
		const n = new Map<string, number>();
		for (const sq of sequences) if (!sq.archived) for (const id of new Set(sq.items.map((it) => it.moveSetId))) n.set(id, (n.get(id) ?? 0) + 1);
		return n;
	});
	type WaxRole = 'grab' | 'withdraw' | 'fail';
	const waxRoles = $derived.by(() => {
		const add = (m: Map<string, Set<WaxRole>>, id: string, role: WaxRole) => m.set(id, (m.get(id) ?? new Set<WaxRole>()).add(role));
		const seqs = new Map<string, Set<WaxRole>>();
		const sets = new Map<string, Set<WaxRole>>();
		const poseIds = new Map<string, Set<WaxRole>>();
		for (const role of ['grab', 'withdraw', 'fail'] as const) {
			const ref = data.waxFill?.[role] ?? null;
			if (!ref) continue;
			const setIds: string[] = [];
			if (ref.kind === 'sequence') {
				add(seqs, ref.id, role);
				for (const it of sequenceById.get(ref.id)?.items ?? []) setIds.push(it.moveSetId);
			} else setIds.push(ref.id);
			for (const sid of setIds) {
				add(sets, sid, role);
				for (const k of moveSetById.get(sid)?.keyframes ?? []) if (!k.fire) add(poseIds, k.poseId, role);
			}
		}
		return { seqs, sets, poses: poseIds };
	});
	const waxTitle = (roles: Set<WaxRole>) => `Wax fill: ${[...roles].join(', ')}`;
	function toggle(set: SvelteSet<string>, id: string) {
		if (set.has(id)) set.delete(id);
		else set.add(id);
	}
	function toggleAll(set: SvelteSet<string>, ids: string[]) {
		const all = ids.every((id) => set.has(id));
		for (const id of ids) {
			if (all) set.delete(id);
			else set.add(id);
		}
	}
	function setSelecting(on: boolean) {
		selecting = on;
		renaming = null;
		picked.clear();
	}
	const clearAfter =
		(set: SvelteSet<string>): SubmitFunction =>
		() =>
		async ({ result, update }) => {
			await update();
			if (result.type === 'success') set.clear();
		};
	// Delete (the 30-day R2 trash): confirm; a move set then offers its poses that no other live move set uses.
	let showDeleted = $state({ moveSets: false, sequences: false });
	const deletedRows = $derived({ moveSets: moveSets.filter((m) => m.archived), sequences: sequences.filter((s) => s.archived) });
	let msArchiveForm = $state<HTMLFormElement>();
	let msArchive = $state({ id: '', poses: '0' });
	let seqDeleteForm = $state<HTMLFormElement>();
	let seqDeleteId = $state('');
	async function deleteSequence(sq: SequenceSummary) {
		if (!confirm(`Delete sequence "${friendlyName(sq.name)}"? You can restore it for 30 days.`)) return;
		seqDeleteId = sq._id;
		await tick();
		seqDeleteForm?.requestSubmit();
	}
	async function archiveMoveSet(ms: MoveSetSummary) {
		if (!confirm(`Delete move set "${friendlyName(ms.name)}"? You can restore it for 30 days.`)) return;
		const ids = [...new Set(ms.keyframes.filter((k) => !k.fire).map((k) => k.poseId))].filter((id) => poseById.has(id) && !poseById.get(id)!.archived);
		const own = ids.filter((id) => (liveSetsUsing.get(id) ?? 0) <= 1);
		const shared = ids.length - own.length;
		const withPoses =
			own.length > 0 &&
			confirm(
				`Also delete its ${own.length} pose${own.length === 1 ? '' : 's'} that no other move set uses?\n\n${own.map((id) => friendlyName(poseById.get(id)!.name)).join('\n')}${shared ? `\n\n${shared} pose${shared === 1 ? ' is' : 's are'} shared with other move sets and will stay.` : ''}`
			);
		msArchive = { id: ms._id, poses: withPoses ? '1' : '0' };
		await tick();
		msArchiveForm?.requestSubmit();
	}

	function confirmDelete(e: SubmitEvent) {
		const n = pickedDeletable.length;
		const kept = pickedOld.length - n;
		const msg = `Delete ${n} archived pose${n === 1 ? '' : 's'} for good? This cannot be undone.${kept ? `\n\n${kept} selected pose${kept === 1 ? ' is' : 's are'} used by a move set and will be kept.` : ''}`;
		if (!confirm(msg)) e.preventDefault();
	}

	const heat = $derived(armNow ? heatCheck(armNow.temps) : null);

	function goTo(p: PoseSummary) {
		if (confirm(`The arm will MOVE to "${friendlyName(p.name)}". Is the path clear?`)) {
			editing = p._id;
			void playback.play('goToPose', { id: p._id }, `Go to ${friendlyName(p.name)}`);
		}
	}

	function resolve(ms: MoveSetSummary): ResolvedKeyframe[] | null {
		return resolveForPreview(ms.keyframes, poseById, { offsets: false });
	}
	function moveSetDuration(ms: MoveSetSummary): string {
		const kfs = resolve(ms);
		if (!kfs || !kfs.length) return '';
		try {
			return `${previewPath(kfs, ms.rateHz || DEFAULT_RATE_HZ).durationS.toFixed(1)} s`;
		} catch {
			return '';
		}
	}
	function sequenceDuration(s: SequenceSummary): string {
		const items = [];
		for (const it of s.items) {
			const ms = moveSetById.get(it.moveSetId);
			const kfs = ms && resolve(ms);
			if (!kfs) return '';
			items.push({ name: ms.name, keyframes: kfs, join: { durationS: it.joinDurationS, easing: it.joinEasing } });
		}
		const flat = flattenSequence(items);
		if (!flat.length) return '';
		try {
			return `${previewPath(flat).durationS.toFixed(1)} s`;
		} catch {
			return '';
		}
	}
	function play(kind: 'playMoveSet' | 'playSequence', id: string, name: string) {
		if (confirm(`The arm will MOVE through "${friendlyName(name)}" from where it is. Is the path clear?`)) void playback.play(kind, { id }, friendlyName(name));
	}

	const input = 'rounded border bg-black/40 px-2 py-1 text-sm';
	const inputStyle = 'border-color: var(--color-tron-border); color: var(--color-tron-text)';
	const btn = 'min-h-[38px] rounded px-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40';
	const cyan = 'background: rgba(56,189,248,0.15); color: var(--color-tron-cyan); border: 1px solid var(--color-tron-cyan);';
	const green = 'background: rgba(74,222,128,0.12); color: #4ade80; border: 1px solid #4ade80;';
	const red = 'background: rgba(239,68,68,0.15); color: #fca5a5; border: 1px solid #ef4444;';
	const card = 'rounded border p-3 sm:p-4';
	const cardStyle = 'border-color: var(--color-tron-border); background: var(--color-tron-surface);';
	const muted = 'color: var(--color-tron-text-secondary)';
	// "replay" → "Replay", for the "Replay Running" chip.
	const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());
	const chip = 'rounded border px-2 py-0.5 text-xs';
	const heatColor = (t: number | null) => ({ stop: '#ef4444', hot: '#f97316', warm: '#fbbf24', ok: '#4ade80' })[heatLevel(t)];
</script>

{#snippet useMarks(used: number, what: string, roles: Set<WaxRole> | undefined)}
	{#if roles}
		<span class="shrink-0" style="color: #94a3b8" title={waxTitle(roles)} aria-label={waxTitle(roles)}>
			<svg class="h-3 w-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.7l5.66 5.66a8 8 0 11-11.32 0L12 2.7z" /></svg>
		</span>
	{/if}
	{#if used}
		<span class="shrink-0" style={muted} title="Used by {used} {what}{used === 1 ? '' : 's'}" aria-label="Used by {used} {what}{used === 1 ? '' : 's'}">
			<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" /></svg>
		</span>
	{/if}
{/snippet}

<div class="mx-auto max-w-7xl space-y-3">
	<!-- header + arm status -->
	<div class="flex flex-wrap items-center justify-between gap-2">
		<div class="flex flex-wrap items-baseline gap-3">
			<h1 class="text-base font-semibold" style="color: var(--color-tron-cyan)">Teach</h1>
		</div>
		<div class="flex flex-wrap items-center gap-2">
			{#if !armReachable}
				<span class={chip} style="border-color: #ef4444; color: #fca5a5">Arm Unreachable</span>
			{:else if armNow}
				{#if armNow.torqueOn === false}
					<span class={chip} style="border-color: #94a3b8; color: #cbd5e1" title="Turn torque on from the status card before posing">Torque OFF</span>
				{/if}
				{#if heat?.maxC != null}
					<span class="{chip} font-mono" style="border-color: var(--color-tron-border); color: {heatColor(heat.maxC)}" title={armNow.temps.map((t, i) => `servo ${i + 1}: ${t ?? '?'} °C`).join('\n')}>
						{heat.maxC} °C Max
					</span>
				{/if}
			{:else if data.active}
				{#if following}
					<span class={chip} style="border-color: var(--color-tron-border); {muted}">Following Control Arm</span>
				{:else}
					<!-- Yellow, so a session holding the arm (e.g. a replay) is hard to miss. -->
					<span class="{chip} font-semibold" style="border-color: #f59e0b; background: rgba(245,158,11,0.18); color: #fbbf24">{titleCase(String(data.active.kind ?? 'session'))} Running</span>
				{/if}
			{/if}
		</div>
	</div>

	{#if heat?.tooHot.length}
		<div class="rounded border border-red-500/50 bg-red-900/15 p-3 text-sm text-red-300">
			Servo {heat.tooHot.join(', ')} at or above {SERVO_TEMP_STOP_C} °C. Motion refused until it cools.
		</div>
	{/if}
	{#if data.libraryError}<p class="text-xs text-red-300">{data.libraryError}</p>{/if}
	{#if flash?.error}
		<div class="rounded border border-red-500/40 bg-red-900/10 p-3 text-sm text-red-300">{flash.error}</div>
	{:else if flash?.warning}
		<div class="rounded border border-amber-500/40 bg-amber-900/10 p-3 text-sm text-amber-300">{flash.warning}</div>
	{:else if flash?.success}
		<div class="rounded border border-green-500/40 bg-green-900/10 p-3 text-sm text-green-300">{flash.success}</div>
	{/if}

	<VerifiedRunPanel {vr} />

	<!-- playback -->
	{#if playback.running || playback.busy || playback.outcome || playback.error}
		<div class="{card} flex flex-wrap items-center gap-3 text-sm" style="border-color: {playback.running ? '#4ade80' : 'var(--color-tron-border)'}; background: var(--color-tron-surface);">
			{#if playback.running}
				<span class="font-semibold" style="color: #4ade80">▶ {playback.title}</span>
				<span class="font-mono text-xs" style={muted}>{playback.elapsedS.toFixed(0)} / {playback.durationS.toFixed(1)} s</span>
				<span class="grow"></span>
				<button type="button" class={btn} style={red} onclick={() => playback.stop()} disabled={playback.busy}>Stop</button>
			{:else if playback.busy}
				<span style={muted}>Starting…</span>
			{:else if playback.error}
				<span class="text-red-300">{playback.error}</span>
			{:else}
				<span style={muted}>{playback.title} — {playback.outcome}.</span>
			{/if}
			{#if playback.settled}<p class="w-full text-xs" style={muted}>{playback.settled}</p>{/if}
			{#if playback.warnings.length}<p class="w-full text-xs" style="color: #f59e0b">{playback.warnings.join(' ')}</p>{/if}
		</div>
	{/if}

	<div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
		<!-- editor column -->
		<div class="space-y-3">
			<!-- control arm: only while following (Follow Leader Arm itself sits next to Live in the pose editor) -->
			{#if following}
			<div class="{card} flex flex-wrap items-end gap-3" style="border-color: #4ade80; background: var(--color-tron-surface);">
				<div class="w-full text-xs text-emerald-300">Following Control Arm</div>
				<form method="POST" action="?/saveLeaderPose" use:enhance class="flex flex-wrap items-end gap-2">
					<input type="hidden" name="resume" value="1" />
					<input name="name" required maxlength="80" placeholder="Pose Name" class="{input} w-44" style={inputStyle} aria-label="Pose name" />
					<button type="submit" class={btn} style={green} disabled={!armReachable}>Save</button>
				</form>
				<form method="POST" action="?/stopLeaderPosing" use:enhance>
					<button type="submit" class={btn} style={cyan} disabled={!armReachable}>Done</button>
				</form>
			</div>
			{/if}

			{#snippet followLeader()}
				<form method="POST" action="?/poseWithLeader" use:enhance onsubmit={(e) => { if (!confirm('The follower will move to wherever the control arm is now, then follow it. Is the control arm roughly matching the follower and is the path clear?')) e.preventDefault(); }}>
					<button type="submit" class={btn} style={cyan} disabled={blocked || !!heat?.tooHot.length}>Follow Leader Arm</button>
				</form>
			{/snippet}

			{#key editing}
				<PoseEditor
					pose={editPose}
					allPoses={poses}
					arm={armNow}
					{armReachable}
					{blocked}
					{blockReason}
					ongoto={goTo}
					onclose={editPose ? () => (editing = 'new') : undefined}
					{home}
					beforeLive={following ? undefined : followLeader}
				/>
				{#if editPose}
					<PoseCameraCard pose={editPose} {camera} cameras={cameraNames} oncamera={setCamera} calibration={calFor(editPose._id)} arm={armNow} {armReachable} {blocked} {blockReason} ongoto={goTo} />
				{/if}
			{/key}

			<!-- The cartridge trapdoors, under the pose editor, then the conveyor belt and teleop recording. Fire steps go in a move set; these test the GPIO without the arm. -->
			<SolenoidPanel status={(data.solenoids ?? null) as SolenoidStatus | null} {armReachable} />
			<ConveyorPanel initial={data.conveyor} />
			<TeleopRecordPanel active={data.active} {armReachable} />
		</div>

		<!-- pose library -->
		<aside class={card} style={cardStyle}>
			<div class="flex items-center justify-between">
				<h2 class="text-sm font-semibold tracking-wide" style="color: var(--color-tron-text)">Poses</h2>
				<div class="flex items-center gap-3">
					{#if !posesHidden && (activePoses.length || selecting)}
						<button type="button" class="text-xs underline" style={selecting ? 'color: var(--color-tron-cyan)' : muted} onclick={() => setSelecting(!selecting)}>{selecting ? 'Done' : 'Select'}</button>
					{/if}
					<button type="button" class="text-xs underline" style="color: var(--color-tron-cyan)" onclick={() => (editing = 'new')}>+ New</button>
					<button type="button" onclick={() => setPosesHidden(!posesHidden)} class="rounded border px-2 py-0.5 text-xs" style="border-color: var(--color-tron-cyan); color: var(--color-tron-cyan)" aria-expanded={!posesHidden}>{posesHidden ? 'Show' : 'Hide'}</button>
				</div>
			</div>
			{#if !posesHidden}
				{#if !activePoses.length}<p class="mt-2 text-xs" style={muted}>No Poses Yet</p>{/if}
				{#if selecting && activePoses.length}
					<div class="mt-2 flex flex-wrap items-center gap-2 rounded border px-2 py-1.5 text-xs" style="border-color: var(--color-tron-border)">
						<span style="color: var(--color-tron-text)">{pickedLive.length} Selected</span>
						<button type="button" class="underline" style="color: var(--color-tron-cyan)" onclick={() => toggleAll(picked, activePoses.map((p) => p._id))}>{pickedLive.length === activePoses.length ? 'None' : 'All'}</button>
						<span class="grow"></span>
						<form method="POST" action="?/archivePoses" use:enhance={clearAfter(picked)} onsubmit={(e) => { if (!confirm(`Delete ${pickedLive.length} pose${pickedLive.length === 1 ? '' : 's'}? You can restore them for 30 days.`)) e.preventDefault(); }}>
							{#each pickedLive as id (id)}<input type="hidden" name="id" value={id} />{/each}
							<button type="submit" class="rounded px-2 py-0.5 font-semibold disabled:cursor-not-allowed disabled:opacity-40" style={red} disabled={!pickedLive.length} title="Restorable for 30 days">Delete{pickedLive.length ? ` ${pickedLive.length}` : ''}</button>
						</form>
					</div>
				{/if}

				{#snippet poseRow(p: PoseSummary, label: string)}
					<li class="group rounded" style="background: {editing === p._id ? 'rgba(56,189,248,0.12)' : 'transparent'}">
						{#if renaming === p._id}
							<form method="POST" action="?/renamePose" use:enhance={() => async ({ update }) => { await update({ reset: false }); renaming = null; }} class="flex items-center gap-1 p-1">
								<input type="hidden" name="id" value={p._id} />
								<input type="hidden" name="notes" value={p.notes ?? ''} />
								<input name="name" required maxlength="80" value={p.name} class="{input} min-w-0 flex-1 py-0.5 text-xs" style={inputStyle} aria-label="Name" />
								<button type="submit" class="text-xs" style="color: #4ade80">Save</button>
								<button type="button" class="text-xs" style={muted} onclick={() => (renaming = null)}>✕</button>
							</form>
						{:else if selecting}
							<label class="flex cursor-pointer items-center gap-2 px-1.5 py-1">
								<input type="checkbox" checked={picked.has(p._id)} onchange={() => toggle(picked, p._id)} />
								<span class="min-w-0 flex-1 truncate text-sm" style="color: var(--color-tron-text)" title={p.notes ?? p.name}>{label}</span>
								{@render useMarks(liveSetsUsing.get(p._id) ?? 0, 'move set', waxRoles.poses.get(p._id))}
							</label>
						{:else}
							<div class="flex items-center gap-1 px-1.5 py-1">
								<button type="button" class="min-w-0 flex-1 truncate text-left text-sm" style="color: var(--color-tron-text)" title={p.notes ?? p.name} onclick={() => (editing = p._id)}>{label}</button>
								{@render useMarks(liveSetsUsing.get(p._id) ?? 0, 'move set', waxRoles.poses.get(p._id))}
								{#if calFor(p._id)}<span class="text-[10px]" style="color: {calFor(p._id)?.stale ? '#fbbf24' : '#4ade80'}" title={calFor(p._id)?.stale ? 'Camera reference is stale (pose edited since) — retake' : `Camera reference for ${camera}`}>◎</span>{/if}
								<button type="button" class="px-1 text-xs disabled:opacity-30" style="color: #fbbf24" title="Go to this pose" disabled={blocked || !!heat?.tooHot.length} onclick={() => goTo(p)}>▶</button>
								<details class="relative">
									<summary class="cursor-pointer list-none px-1 text-xs" style={muted} title="More">⋯</summary>
									<div class="absolute right-0 z-10 mt-1 w-28 space-y-1 rounded border p-2 text-xs" style="border-color: var(--color-tron-border); background: var(--color-tron-surface)">
										<button type="button" class="block underline" style="color: var(--color-tron-cyan)" onclick={() => (renaming = p._id)}>Rename</button>
										<form method="POST" action="?/archivePose" use:enhance>
											<input type="hidden" name="id" value={p._id} />
											<button type="submit" class="underline" style={muted}>Archive</button>
										</form>
									</div>
								</details>
							</div>
						{/if}
					</li>
				{/snippet}

				<ul class="mt-2 space-y-0.5">
					{#each grouped.loose as p (p._id)}{@render poseRow(p, friendlyName(p.name))}{/each}
				</ul>
				{#each grouped.groups as [g, list] (g)}
					<details class="mt-2" open={list.some((p) => p._id === editing)}>
						<summary class="cursor-pointer text-xs font-semibold" style={muted}>
							{g} <span class="font-normal">· {list.length}</span>
							{#if selecting}
								<button type="button" class="ml-2 font-normal underline" style="color: var(--color-tron-cyan)" onclick={(e) => { e.preventDefault(); toggleAll(picked, list.map((p) => p._id)); }}>{list.every((p) => picked.has(p._id)) ? 'None' : 'All'}</button>
							{/if}
						</summary>
						<ul class="mt-1 space-y-0.5 pl-2">
							{#each list as p (p._id)}{@render poseRow(p, poseGroup(p.name).label)}{/each}
						</ul>
					</details>
				{/each}

				{#if archivedPoses.length}
					<button type="button" onclick={() => (showArchived = !showArchived)} class="mt-3 text-xs underline" style={muted}>{showArchived ? 'Hide' : 'Show'} Deleted · {archivedPoses.length}</button>
					{#if showArchived}
						<div class="mt-1 flex flex-wrap items-center gap-2 text-xs" style={muted}>
							<button type="button" class="underline" style="color: var(--color-tron-cyan)" onclick={() => toggleAll(pickedArchived, deletedMatches.map((p) => p._id))}>{deletedMatches.length && deletedMatches.every((p) => pickedArchived.has(p._id)) ? 'None' : 'All'}</button>
							<input type="search" bind:value={deletedQuery} oninput={() => (deletedLimit = DELETED_PAGE)} placeholder="Search Deleted" class="{input} w-36 py-0.5 text-xs" style={inputStyle} aria-label="Search Deleted" />
							<span class="grow"></span>
							<form method="POST" action="?/archivePoses" use:enhance={clearAfter(pickedArchived)}>
								<input type="hidden" name="restore" value="1" />
								{#each pickedOld as id (id)}<input type="hidden" name="id" value={id} />{/each}
								<button type="submit" class="underline disabled:cursor-not-allowed disabled:opacity-40" style="color: var(--color-tron-cyan)" disabled={!pickedOld.length}>Restore{pickedOld.length ? ` ${pickedOld.length}` : ''}</button>
							</form>
							<form method="POST" action="?/deletePoses" use:enhance={clearAfter(pickedArchived)} onsubmit={confirmDelete}>
								{#each pickedDeletable as id (id)}<input type="hidden" name="id" value={id} />{/each}
								<button type="submit" class="rounded px-2 py-0.5 font-semibold disabled:cursor-not-allowed disabled:opacity-40" style={red} disabled={!pickedDeletable.length}
									title={pickedOld.length && !pickedDeletable.length ? 'Every selected pose is used by a move set — remove it from the move set first' : 'Delete the selected archived poses for good'}>Delete{pickedDeletable.length ? ` ${pickedDeletable.length}` : ''} For Good</button>
							</form>
						</div>
						<ul class="mt-1 space-y-1 text-xs" style={muted}>
							{#each deletedShown as p (p._id)}
								{@const sets = setsUsing.get(p._id) ?? 0}
								<li class="flex items-center gap-2">
									<input type="checkbox" checked={pickedArchived.has(p._id)} onchange={() => toggle(pickedArchived, p._id)} aria-label="Select {friendlyName(p.name)}" />
									<span class="min-w-0 flex-1 truncate">{friendlyName(p.name)}</span>
									{#if sets}<span class="shrink-0 text-[10px]" title="Used by {sets} move set{sets === 1 ? '' : 's'}: it can be restored, not deleted">In {sets} Set{sets === 1 ? '' : 's'}</span>{/if}
									{#if p.deletesAt}<span class="shrink-0 text-[10px]">{daysLeftLabel(p.deletesAt)}</span>{/if}
									<form method="POST" action="?/archivePose" use:enhance><input type="hidden" name="id" value={p._id} /><input type="hidden" name="restore" value="1" /><button type="submit" class="underline" style="color: var(--color-tron-cyan)">Restore</button></form>
								</li>
							{/each}
						</ul>
						{#if deletedMatches.length > deletedShown.length}
							<button type="button" class="mt-1 text-xs underline" style="color: var(--color-tron-cyan)" onclick={() => (deletedLimit += DELETED_PAGE)}>Show More · {deletedMatches.length - deletedShown.length}</button>
						{:else if deletedQuery && !deletedMatches.length}
							<p class="mt-1 text-xs" style={muted}>No Match</p>
						{/if}
					{/if}
				{/if}
			{/if}
		</aside>
	</div>

	<form method="POST" action="?/archiveMoveSet" use:enhance bind:this={msArchiveForm} class="hidden">
		<input type="hidden" name="id" value={msArchive.id} /><input type="hidden" name="poses" value={msArchive.poses} />
	</form>
	<form method="POST" action="?/archiveSequence" use:enhance bind:this={seqDeleteForm} class="hidden">
		<input type="hidden" name="id" value={seqDeleteId} />
	</form>

	<!-- move sets + sequences -->
	<div class="grid gap-4 md:grid-cols-2">
		{#each [{ kind: 'moveSets' as const }, { kind: 'sequences' as const }] as col (col.kind)}
			{@const isSets = col.kind === 'moveSets'}
			{@const rows = (isSets ? moveSets : sequences).filter((r) => !r.archived)}
			<section class={card} style={cardStyle}>
				<div class="flex items-center justify-between gap-2">
					<h2 class="text-sm font-semibold tracking-wide" style="color: var(--color-tron-text)">{isSets ? 'Move Sets' : 'Sequences'}</h2>
					<form method="POST" action={isSets ? '?/createMoveSet' : '?/createSequence'} use:enhance class="flex items-center gap-1">
						<input name="name" required maxlength="80" placeholder={isSets ? 'New Move Set' : 'New Sequence'} class="{input} w-36 py-0.5 text-xs" style={inputStyle} aria-label="Name" />
						<button type="submit" class="rounded px-2 py-0.5 text-xs font-semibold" style={cyan}>+</button>
					</form>
				</div>
				<ul class="mt-2 space-y-0.5">
					{#each rows as r (r._id)}
						{@const ms = isSets ? (r as MoveSetSummary) : null}
						{@const sq = isSets ? null : (r as SequenceSummary)}
						{@const cov = coverage(ms, sq)}
						{@const covColor = isSets ? 'var(--color-tron-cyan)' : cov.total && cov.ok === cov.total ? '#4ade80' : cov.ok + cov.stale > 0 ? '#fbbf24' : 'var(--color-tron-text-secondary)'}
						<li class="flex items-center gap-2 rounded px-1.5 py-1 text-sm">
							<a href="/manufacturing/cart-mfg/robot-arm/teach/{isSets ? 'moveset' : 'sequence'}/{r._id}" class="min-w-0 flex-1 truncate" style="color: var(--color-tron-cyan)" title={r.name}>{friendlyName(r.name)}</a>
							{@render useMarks(ms ? (seqsUsing.get(r._id) ?? 0) : 0, 'sequence', ms ? waxRoles.sets.get(r._id) : waxRoles.seqs.get(r._id))}
							<span class="shrink-0 text-xs" style={muted}>
								{ms ? stepCountLabel(ms.keyframes) : `${sq!.items.length} sets`}{(ms ? moveSetDuration(ms) : sequenceDuration(sq!)) ? ` · ${ms ? moveSetDuration(ms) : sequenceDuration(sq!)}` : ''}
							</span>
							<button type="button" class="px-1 text-xs disabled:opacity-30" style="color: #fbbf24" title="Play on the arm"
								disabled={blocked || !!heat?.tooHot.length || (ms ? !ms.keyframes.length : !sq!.items.length)}
								onclick={() => play(isSets ? 'playMoveSet' : 'playSequence', r._id, r.name)}>▶</button>
							<button type="button" class="px-1 font-mono text-xs disabled:opacity-30" style="color: {covColor}"
								title={cov.ok + cov.stale === 0
									? `No pose in this ${isSets ? 'set' : 'sequence'} has a camera reference for ${camera || 'the camera'} — open a pose and capture one (camera card → Capture) before a verified run`
									: `Verified run with ${camera}: ${cov.ok} of ${cov.total} poses have a reference${cov.stale ? `, ${cov.stale} stale (pose edited since; retake)` : ''}. Steps without one are played unchecked.`}
								disabled={blocked || !camera || !!heat?.tooHot.length || cov.ok + cov.stale === 0}
								onclick={() => verified(isSets ? 'move_set' : 'sequence', r._id, r.name)}>◎ {cov.ok}/{cov.total}</button>
							<button type="button" class="rounded px-2 py-0.5 text-xs font-semibold" style={red} title="Restorable for 30 days"
								onclick={() => void (ms ? archiveMoveSet(ms) : deleteSequence(sq!))}>Delete</button>
						</li>
					{/each}
				</ul>
				{#if !rows.length}<p class="mt-2 text-xs" style={muted}>None Yet</p>{/if}
				{#if deletedRows[col.kind].length}
					<button type="button" onclick={() => (showDeleted[col.kind] = !showDeleted[col.kind])} class="mt-3 text-xs underline" style={muted}>{showDeleted[col.kind] ? 'Hide' : 'Show'} Deleted · {deletedRows[col.kind].length}</button>
					{#if showDeleted[col.kind]}
						<ul class="mt-1 space-y-0.5">
							{#each deletedRows[col.kind] as r (r._id)}
								<li class="flex items-center gap-2 rounded px-1.5 py-1 text-sm">
									<span class="min-w-0 flex-1 truncate" style={muted} title={r.name}>{friendlyName(r.name)}</span>
									{#if r.deletesAt}<span class="shrink-0 text-xs" style={muted}>{daysLeftLabel(r.deletesAt)}</span>{/if}
									<form method="POST" action={isSets ? '?/archiveMoveSet' : '?/archiveSequence'} use:enhance>
										<input type="hidden" name="id" value={r._id} /><input type="hidden" name="restore" value="1" /><input type="hidden" name="poses" value="1" />
										<button type="submit" class="text-xs underline" style="color: var(--color-tron-cyan)" title={isSets ? 'Restore this move set and its deleted poses' : 'Restore this sequence'}>Restore</button>
									</form>
								</li>
							{/each}
						</ul>
					{/if}
				{/if}
			</section>
		{/each}
	</div>
</div>
