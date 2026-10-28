<script lang="ts">
	/**
	 * ARM-06 — move-set editor (redone 2026-10-22, PRD §13): the keyframe list
	 * (pose, how long the move into it takes, easing, hold) and, for the
	 * selected keyframe, the pose editor — sliders that drive the real arm
	 * live. Play, Stop and Save as a recording on the Pi.
	 *
	 * Fire steps (2026-10-28): a step can instead fire a cartridge trapdoor
	 * solenoid (A or B). It sits in the list like a pose, in amber; the arm
	 * holds where it is for the pulse plus the wait after it. The strip above
	 * the list shows where each fire lands in the animation.
	 */
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { onDestroy, onMount } from 'svelte';
	import PoseEditor from '$lib/components/robot-arm/PoseEditor.svelte';
	import PoseCameraCard from '$lib/components/robot-arm/PoseCameraCard.svelte';
	import VerifiedRunPanel from '$lib/components/robot-arm/VerifiedRunPanel.svelte';
	import SolenoidPanel from '$lib/components/robot-arm/SolenoidPanel.svelte';
	import StepStrip from '$lib/components/robot-arm/StepStrip.svelte';
	import { VerifiedRun } from '$lib/robot-arm/verified-run.svelte';
	import { loadChosenCamera, pickCamera, saveChosenCamera } from '$lib/robot-arm/arm-camera';
	import { verifyWanted, MAX_ANGLE_DEG, MAX_POSITION_MM, MAX_TOLERANCE_STEPS } from '$lib/robot-arm/verified-poses';
	import type { PoseCalibrationSummary, VerifiedRunSummary } from '$lib/server/robot-arm-verified';
	import type { CameraStatus } from '$lib/server/robot-arm-client';
	import {
		fireStepS,
		friendlyName,
		heatCheck,
		keyframePositions,
		minDurationS,
		newFireStep,
		pathStats,
		previewPath,
		solenoidLabel,
		solenoidPin,
		stepCountLabel,
		tooFast,
		DEFAULT_RATE_HZ,
		EASINGS,
		MAX_HOLD_S,
		MAX_PULSE_MS,
		MAX_STEPS_PER_S,
		MAX_TRANSITION_S,
		MIN_FIRE_WAIT_S,
		MIN_PULSE_MS,
		MIN_TRANSITION_S,
		SOLENOIDS,
		type Keyframe,
		type ResolvedKeyframe,
		type Solenoid,
		type SolenoidStatus
	} from '$lib/robot-arm/animation';
	import { Playback } from '$lib/robot-arm/playback.svelte';
	import type { MoveSetSummary, PoseSummary } from '$lib/server/robot-arm-animation';

	let { data, form } = $props();

	type ArmRead = { positions: number[]; temps: (number | null)[]; torqueOn: boolean | null };
	const moveSet = $derived(data.moveSet as MoveSetSummary);
	const poses = $derived((data.poses ?? []) as PoseSummary[]);
	const poseById = $derived(new Map(poses.map((p) => [p._id, p])));
	const activePoses = $derived(poses.filter((p) => !p.archived));
	const armNow = $derived((data.armNow ?? null) as ArmRead | null);
	const solenoids = $derived((data.solenoids ?? null) as SolenoidStatus | null);

	const flash = $derived(form as { success?: string; error?: string; createdPoseId?: string } | null);
	const armReachable = $derived(!!data.arm?.reachable);
	const heat = $derived(armNow ? heatCheck(armNow.temps) : null);

	const playback = new Playback();
	playback.onend = () => void invalidateAll();
	onDestroy(() => playback.destroy());

	// ARM-09: pose camera references, per-step verification, the verified run.
	const poseCals = $derived((data.poseCalibrations ?? []) as PoseCalibrationSummary[]);
	const cameraNames = $derived([...new Set([...((data.cameras ?? []) as CameraStatus[]).map((c) => c.name), ...poseCals.map((c) => c.cameraName)])]);
	let chosenCamera = $state<string | null>(null);
	const camera = $derived(pickCamera(cameraNames, chosenCamera, poseCals.map((c) => c.cameraName)));
	function setCamera(n: string) {
		chosenCamera = n;
		saveChosenCamera(n);
	}
	const calFor = (poseId: string): PoseCalibrationSummary | null => poseCals.find((c) => c.poseId === poseId && c.cameraName === camera) ?? null;
	const hasRef = (poseId: string) => {
		const c = calFor(poseId);
		return !!c && !c.stale;
	};
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
	const verifyMode = (k: Keyframe): 'auto' | 'on' | 'off' => (k.verify === true ? 'on' : k.verify === false ? 'off' : 'auto');
	function setVerify(k: Keyframe, mode: string) {
		if (mode === 'on') k.verify = true;
		else if (mode === 'off') k.verify = false;
		else delete k.verify;
	}
	function setTol(k: Keyframe, key: 'positionMm' | 'angleDeg' | 'steps', raw: string) {
		const v = raw.trim() === '' ? null : Number(raw);
		const next = { ...(k.tolerances ?? {}) };
		if (v == null || !Number.isFinite(v)) delete next[key];
		else next[key] = key === 'steps' ? Math.round(v) : Math.round(v * 10) / 10;
		if (Object.keys(next).length) k.tolerances = next;
		else delete k.tolerances;
	}
	function playVerified() {
		if (!camera) return;
		if (confirm(`Verified run: the arm will MOVE through "${friendlyName(moveSet.name)}" step by step, checking each verified pose with camera ${camera}. A failed check stops it. Is the path clear?`)) void vr.start('move_set', moveSet._id, camera);
	}

	const blocked = $derived(!armReachable || data.holder != null || !!data.active || playback.running || playback.busy || vr.active || vr.busy);
	const blockReason = $derived(!armReachable ? 'The arm is unreachable.' : playback.running || playback.busy ? 'The arm is playing.' : vr.active || vr.busy ? 'A verified run is in progress.' : data.active || data.holder ? 'The arm is running something — stop it first.' : '');

	// Local copy of the keyframes; Save posts it as JSON.
	let name = $state('');
	let notes = $state('');
	let kfs = $state<Keyframe[]>([]);
	let saved = $state('');
	let selected = $state<number | null>(null);
	let addPoseId = $state('');
	$effect(() => {
		// Only when the SAVED move set changed: a reload after a pose save must not throw away unsaved keyframe edits.
		const key = JSON.stringify(moveSet.keyframes) + moveSet.name + (moveSet.notes ?? '');
		if (key === saved) return;
		name = moveSet.name;
		notes = moveSet.notes ?? '';
		kfs = moveSet.keyframes.map((k) => ({ ...k, ...(k.offsets ? { offsets: [...k.offsets] } : {}) }));
		saved = key;
		if (selected == null && kfs.length) selected = 0;
	});
	const dirty = $derived(JSON.stringify(kfs) + name + notes !== saved);
	// ARM-09: at least one step would be checked (its own flag, or a reference exists for the camera).
	const anyVerified = $derived(kfs.some((k) => !k.fire && verifyWanted(k.verify, hasRef(k.poseId))));
	// A move set with fire steps plays only on a Pi whose replay fires them (unknown status: let the server decide).
	const hasFires = $derived(kfs.some((k) => k.fire));
	const firesBlocked = $derived(hasFires && !!solenoids && !solenoids.replayFire);
	// The first pose has no "move in": the play leads in to it from wherever the arm is.
	const firstPoseIndex = $derived(kfs.findIndex((k) => !k.fire));

	// "Save as new" in the editor while a keyframe is selected: that keyframe now uses the new pose.
	let lastCreated = '';
	$effect(() => {
		const id = flash?.createdPoseId;
		if (id && id !== lastCreated && selected != null && kfs[selected] && poseById.has(id)) {
			lastCreated = id;
			kfs[selected].poseId = id;
			delete kfs[selected].offsets;
		}
	});

	const resolved = $derived.by((): ResolvedKeyframe[] => {
		const out: ResolvedKeyframe[] = [];
		for (const k of kfs) {
			if (k.fire) {
				out.push({ ...k, name: `Fire ${solenoidLabel(k.fire.solenoid)}`, positions: [] });
				continue;
			}
			const p = poseById.get(k.poseId);
			if (p) out.push({ ...k, name: p.name, positions: keyframePositions(p.positions, k.offsets) });
		}
		return out;
	});
	const render = $derived.by(() => {
		if (!resolved.length) return { path: null, error: null as string | null };
		try {
			return { path: previewPath(resolved, moveSet.rateHz || DEFAULT_RATE_HZ), error: null };
		} catch (e) {
			return { path: null, error: e instanceof Error ? e.message : String(e) };
		}
	});
	const stats = $derived(render.path ? pathStats(render.path) : null);
	const problems = $derived(tooFast(resolved));
	// Against the pose before it: fire steps in between do not move the arm.
	const minFor = (i: number) => {
		const k = resolved[i];
		if (!k || k.fire) return 0;
		for (let j = i - 1; j >= 0; j--) if (!resolved[j].fire) return minDurationS(resolved[j].positions, k.positions, MAX_STEPS_PER_S, k.easing);
		return 0;
	};
	const selPose = $derived(selected != null && kfs[selected] && !kfs[selected].fire ? (poseById.get(kfs[selected].poseId) ?? null) : null);
	const selFire = $derived(selected != null && kfs[selected]?.fire ? kfs[selected] : null);
	// The pose a fire step holds on: the nearest pose before it (none = where the arm is when it starts).
	function holdsOn(i: number): string {
		for (let j = i - 1; j >= 0; j--) {
			if (kfs[j].fire) continue;
			const p = poseById.get(kfs[j].poseId);
			return p ? `"${friendlyName(p.name)}"` : 'the pose before it';
		}
		return 'wherever the arm is when the play starts';
	}
	// The editor's path has no lead-in; the play's does.
	const playheadS = $derived(playback.running ? Math.max(0, playback.elapsedS - playback.leadInS) : null);

	function add() {
		if (!addPoseId) return;
		kfs = [...kfs, { poseId: addPoseId, holdS: 0.5, durationS: 1.5, easing: 'ease' }];
		selected = kfs.length - 1;
		addPoseId = '';
	}
	// A fire step goes right after the selected step (the pose it should fire at), else at the end.
	function addFire(s: Solenoid) {
		const at = selected != null ? selected + 1 : kfs.length;
		kfs = [...kfs.slice(0, at), newFireStep(s), ...kfs.slice(at)];
		selected = at;
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
		selected = kfs.length ? Math.min(i, kfs.length - 1) : null;
	}
	function goTo(p: PoseSummary) {
		if (confirm(`The arm will MOVE to "${friendlyName(p.name)}". Is the path clear?`)) void playback.play('goToPose', { id: p._id }, `Go to ${friendlyName(p.name)}`);
	}
	const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
	const tenth = (v: number) => Math.round(v * 10) / 10;

	const input = 'rounded border bg-black/40 px-2 py-1 text-sm';
	const inputStyle = 'border-color: var(--color-tron-border); color: var(--color-tron-text)';
	const btn = 'min-h-[38px] rounded px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40';
	const cyan = 'background: rgba(56,189,248,0.15); color: var(--color-tron-cyan); border: 1px solid var(--color-tron-cyan);';
	const amber = 'background: rgba(245,158,11,0.15); color: #fbbf24; border: 1px solid #f59e0b;';
	const green = 'background: rgba(74,222,128,0.12); color: #4ade80; border: 1px solid #4ade80;';
	const red = 'background: rgba(239,68,68,0.15); color: #fca5a5; border: 1px solid #ef4444;';
	const card = 'rounded border p-3 sm:p-4';
	const cardStyle = 'border-color: var(--color-tron-border); background: var(--color-tron-surface);';
	const muted = 'color: var(--color-tron-text-secondary)';
</script>

<div class="mx-auto max-w-7xl space-y-4">
	<div class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<a href="/manufacturing/cart-mfg/robot-arm/animate" class="text-xs underline" style={muted}>← Animate</a>
			<h1 class="text-xl font-bold" style="color: var(--color-tron-cyan)">{friendlyName(moveSet.name)}</h1>
		</div>
		<div class="flex flex-wrap items-center gap-2">
			{#if stats}<span class="text-xs" style={muted}>{stats.durationS.toFixed(1)} s</span>{/if}
			{#if playback.running}
				<button type="button" class={btn} style={red} onclick={() => playback.stop()} disabled={playback.busy}>Stop</button>
			{:else}
				<button type="button" class={btn} style={amber} disabled={blocked || dirty || !kfs.length || problems.length > 0 || !!heat?.tooHot.length || firesBlocked}
					title={dirty ? 'Save first' : firesBlocked ? "The Pi's replay cannot fire steps yet" : 'From where the arm is, through every step'}
					onclick={() => { if (confirm(`The arm will MOVE through "${friendlyName(moveSet.name)}" from where it is. Is the path clear?`)) playback.play('play', {}, friendlyName(moveSet.name)); }}>▶ Play</button>
				<button type="button" class={btn} style={green} disabled={blocked || dirty || !kfs.length || problems.length > 0 || !!heat?.tooHot.length || !camera || !anyVerified || firesBlocked}
					title={dirty ? 'Save first' : !camera ? 'No camera' : !anyVerified ? 'No step has a camera reference — capture one below' : `Step by step; each verified pose checked with ${camera}. A failed check stops the run.`}
					onclick={playVerified}>◎ Play verified</button>
			{/if}
		</div>
	</div>

	{#if flash?.error}<div class="rounded border border-red-500/40 bg-red-900/10 p-3 text-sm text-red-300">{flash.error}</div>
	{:else if flash?.success}<div class="rounded border border-green-500/40 bg-green-900/10 p-3 text-sm text-green-300">{flash.success}</div>{/if}
	{#if render.error}<div class="rounded border border-red-500/40 bg-red-900/10 p-3 text-sm text-red-300">{render.error}</div>{/if}
	{#if playback.running || playback.outcome || playback.error}
		<p class="text-sm" style="color: {playback.error ? '#fca5a5' : playback.running ? '#4ade80' : 'var(--color-tron-text-secondary)'}">
			{#if playback.running}▶ {playback.title} · {playback.elapsedS.toFixed(0)} / {playback.durationS.toFixed(1)} s
			{:else if playback.error}{playback.error}
			{:else}{playback.title} — {playback.outcome}.{/if}
		</p>
		{#if playback.settled}<p class="text-xs" style={muted}>{playback.settled}</p>{/if}
		{#if playback.warnings.length}<p class="text-xs" style="color: #f59e0b">{playback.warnings.join(' ')}</p>{/if}
	{/if}
	<VerifiedRunPanel {vr} />
	{#if firesBlocked}
		<p class="text-xs" style="color: #fbbf24">This move set fires solenoids, but the Pi's replay cannot fire steps yet — Play stays off until the Pi is updated. Test fire works.</p>
	{/if}
	{#if render.path && (hasFires || kfs.length > 1)}
		<StepStrip path={render.path} selectedIndex={selected} {playheadS} onselect={(i) => (selected = i)} />
	{/if}

	<div class="grid gap-4 lg:grid-cols-[24rem_minmax(0,1fr)]">
		<!-- keyframes -->
		<form method="POST" action="?/save" use:enhance={() => async ({ update }) => { await update({ reset: false }); }} class="{card} space-y-3 self-start" style={cardStyle}>
			<input type="hidden" name="keyframes" value={JSON.stringify(kfs)} />
			<input type="hidden" name="notes" value={notes} />
			<label class="block text-xs" style={muted}>Name<input name="name" bind:value={name} required maxlength="80" class="{input} mt-1 block w-full" style={inputStyle} /></label>

			<ol class="space-y-1">
				{#each kfs as k, i (i)}
					{@const p = poseById.get(k.poseId)}
					{@const min = minFor(i)}
					{#if k.fire}
						{@const f = k.fire}
						<!-- A fire step: amber, so it never reads as a pose. -->
						<li class="rounded border p-2" style="border-color: {selected === i ? '#f59e0b' : 'rgba(245,158,11,0.45)'}; background: {selected === i ? 'rgba(245,158,11,0.10)' : 'rgba(245,158,11,0.04)'}">
							<div class="flex items-center gap-2">
								<span class="w-5 font-mono text-xs" style={muted}>{i + 1}</span>
								<button type="button" class="min-w-0 flex-1 truncate text-left text-sm font-semibold" style="color: #fbbf24" onclick={() => (selected = i)}>⚡ Fire {solenoidLabel(f.solenoid)}</button>
								<button type="button" onclick={() => move(i, -1)} class="px-1 text-xs" style="color: var(--color-tron-cyan)" title="Earlier">▲</button>
								<button type="button" onclick={() => move(i, 1)} class="px-1 text-xs" style="color: var(--color-tron-cyan)" title="Later">▼</button>
								<button type="button" onclick={() => remove(i)} class="px-1 text-xs text-red-300" title="Remove">✕</button>
							</div>
							{#if selected === i}
								<div class="mt-2 space-y-2 text-[11px]" style={muted}>
									<label class="block">Solenoid
										<select bind:value={f.solenoid} class="{input} mt-1 w-full" style={inputStyle}>
											{#each SOLENOIDS as s (s.id)}<option value={s.id}>{s.label} · GPIO {s.pin}</option>{/each}
										</select>
									</label>
									<label class="block">Pulse (ms)
										<span class="mt-1 flex items-center gap-2">
											<input type="range" min={MIN_PULSE_MS} max={MAX_PULSE_MS} step="10" value={f.pulseMs} oninput={(e) => (f.pulseMs = Math.round(clamp(Number(e.currentTarget.value), MIN_PULSE_MS, MAX_PULSE_MS)))} class="min-w-0 flex-1" aria-label="Pulse length" />
											<input type="number" min={MIN_PULSE_MS} max={MAX_PULSE_MS} step="10" value={f.pulseMs} onchange={(e) => (f.pulseMs = Math.round(clamp(Number(e.currentTarget.value), MIN_PULSE_MS, MAX_PULSE_MS)))} class="{input} w-20 font-mono" style={inputStyle} aria-label="Pulse length in ms" />
										</span>
									</label>
									<label class="block">Wait after (s) — the cartridge drops; the arm waits
										<span class="mt-1 flex items-center gap-2">
											<input type="range" min={MIN_FIRE_WAIT_S} max="10" step="0.1" value={Math.min(10, k.holdS)} oninput={(e) => (k.holdS = tenth(clamp(Number(e.currentTarget.value), MIN_FIRE_WAIT_S, MAX_HOLD_S)))} class="min-w-0 flex-1" aria-label="Wait after firing" />
											<input type="number" min={MIN_FIRE_WAIT_S} max={MAX_HOLD_S} step="0.1" value={k.holdS} onchange={(e) => (k.holdS = tenth(clamp(Number(e.currentTarget.value), MIN_FIRE_WAIT_S, MAX_HOLD_S)))} class="{input} w-20 font-mono" style={inputStyle} aria-label="Wait after firing in seconds" />
										</span>
									</label>
									<p>Step takes {fireStepS(k).toFixed(1)} s. The arm holds on {holdsOn(i)}.</p>
								</div>
							{:else}
								<div class="mt-0.5 pl-7 text-[11px]" style={muted}>GPIO {solenoidPin(f.solenoid)} · {f.pulseMs} ms pulse · then wait {k.holdS} s</div>
							{/if}
						</li>
					{:else}
					<li class="rounded border p-2" style="border-color: {selected === i ? 'var(--color-tron-cyan)' : 'var(--color-tron-border)'}; background: {selected === i ? 'rgba(56,189,248,0.06)' : 'transparent'}">
						<div class="flex items-center gap-2">
							<span class="w-5 font-mono text-xs" style={muted}>{i + 1}</span>
							<button type="button" class="min-w-0 flex-1 truncate text-left text-sm" style="color: {p ? 'var(--color-tron-text)' : '#fca5a5'}" onclick={() => (selected = i)} title={p?.name}>
								{p ? friendlyName(p.name) : 'missing pose'}{p?.archived ? ' (archived)' : ''}
							</button>
							{#if verifyWanted(k.verify, hasRef(k.poseId))}
								<span class="text-[10px]" style="color: {hasRef(k.poseId) ? '#4ade80' : '#ef4444'}" title={hasRef(k.poseId) ? `Checked with the camera in a verified run (${camera})` : calFor(k.poseId)?.stale ? 'Verification on, but the reference is stale — retake it' : 'Verification on, but this pose has no camera reference — capture one or set the check to off'}>◎</span>
							{/if}
							<button type="button" onclick={() => move(i, -1)} class="px-1 text-xs" style="color: var(--color-tron-cyan)" title="Earlier">▲</button>
							<button type="button" onclick={() => move(i, 1)} class="px-1 text-xs" style="color: var(--color-tron-cyan)" title="Later">▼</button>
							<button type="button" onclick={() => remove(i)} class="px-1 text-xs text-red-300" title="Remove">✕</button>
						</div>
						{#if p}
							<!-- The six absolute goals this step sends (servo 1..6). The timeline is this list of values, never a change from the step before. -->
							<div class="mt-0.5 pl-7 font-mono text-[11px] tabular-nums" style={muted} title="Absolute encoder goals, servo 1 to 6 — edit them with the number boxes on the right">
								{keyframePositions(p.positions, k.offsets).join(' · ')}
							</div>
						{/if}
						{#if selected === i}
							<div class="mt-2 grid grid-cols-3 gap-2 text-[11px]" style={muted}>
								<label>Move in (s)
									{#if i === firstPoseIndex}<span class="mt-1 block py-1">start</span>
									{:else}<input type="number" step="0.1" min={MIN_TRANSITION_S} max={MAX_TRANSITION_S} value={k.durationS} oninput={(e) => (k.durationS = clamp(Number(e.currentTarget.value), MIN_TRANSITION_S, MAX_TRANSITION_S))} class="{input} mt-1 w-full" style="{inputStyle}; {k.durationS < min ? 'border-color: #ef4444' : ''}" />{/if}
								</label>
								<label>Easing
									{#if i === firstPoseIndex}<span class="mt-1 block py-1">—</span>
									{:else}<select bind:value={k.easing} class="{input} mt-1 w-full" style={inputStyle} title={EASINGS.find((e) => e.id === k.easing)?.hint}>{#each EASINGS as e (e.id)}<option value={e.id}>{e.label}</option>{/each}</select>{/if}
								</label>
								<label>Hold (s)<input type="number" step="0.1" min="0" max={MAX_HOLD_S} value={k.holdS} oninput={(e) => (k.holdS = clamp(Number(e.currentTarget.value), 0, MAX_HOLD_S))} class="{input} mt-1 w-full" style={inputStyle} /></label>
							</div>
							{#if i !== firstPoseIndex && k.durationS < min}<p class="mt-1 text-[11px] text-red-300">Too fast for this move — at least {min} s.</p>{/if}
							<!-- ARM-09: this step's camera check and its own tolerances (blank = the pose reference's) -->
							<div class="mt-2 grid grid-cols-4 gap-2 text-[11px]" style={muted}>
								<label>Camera check
									<select value={verifyMode(k)} onchange={(e) => setVerify(k, e.currentTarget.value)} class="{input} mt-1 w-full" style={inputStyle} title="auto = checked when the pose has a reference for the camera">
										<option value="auto">auto{calFor(k.poseId) ? ' (on)' : ' (off)'}</option>
										<option value="on">on</option>
										<option value="off">off</option>
									</select>
								</label>
								<label>mm<input type="number" step="0.1" min="0.1" max={MAX_POSITION_MM} value={k.tolerances?.positionMm ?? ''} placeholder={String(calFor(k.poseId)?.tolerances.positionMm ?? '')} oninput={(e) => setTol(k, 'positionMm', e.currentTarget.value)} class="{input} mt-1 w-full font-mono" style={inputStyle} /></label>
								<label>spin °<input type="number" step="0.1" min="0" max={MAX_ANGLE_DEG} value={k.tolerances?.angleDeg ?? ''} placeholder={String(calFor(k.poseId)?.tolerances.angleDeg ?? '')} oninput={(e) => setTol(k, 'angleDeg', e.currentTarget.value)} class="{input} mt-1 w-full font-mono" style={inputStyle} /></label>
								<label>steps<input type="number" step="1" min="1" max={MAX_TOLERANCE_STEPS} value={k.tolerances?.steps ?? ''} placeholder={String(calFor(k.poseId)?.tolerances.steps ?? '')} oninput={(e) => setTol(k, 'steps', e.currentTarget.value)} class="{input} mt-1 w-full font-mono" style={inputStyle} /></label>
							</div>
							{#if k.offsets}
								<p class="mt-1 text-[11px]" style="color: #fbbf24">
									This step was adjusted on the old timeline (the arm goes slightly off the pose here).
									<button type="button" class="underline" onclick={() => delete k.offsets}>use the pose as is</button>
								</p>
							{/if}
						{:else}
							<div class="mt-0.5 pl-7 text-[11px]" style={muted}>{i === firstPoseIndex ? 'start' : `${k.durationS} s ${EASINGS.find((e) => e.id === k.easing)?.label.toLowerCase()}`}{k.holdS ? ` · hold ${k.holdS} s` : ''}</div>
						{/if}
					</li>
					{/if}
				{/each}
			</ol>
			{#if !kfs.length}<p class="text-xs" style={muted}>No steps yet — add a pose or a fire step below.</p>{/if}

			<div class="flex items-center gap-2">
				<select bind:value={addPoseId} class="{input} min-w-0 flex-1" style={inputStyle} aria-label="Add pose">
					<option value="">Add a pose…</option>
					{#each activePoses as ap (ap._id)}<option value={ap._id}>{friendlyName(ap.name)}</option>{/each}
				</select>
				<button type="button" onclick={add} disabled={!addPoseId} class="rounded px-3 py-1 text-sm font-semibold disabled:opacity-40" style={cyan}>Add</button>
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<span class="text-[11px]" style={muted}>Fire step {selected != null && kfs[selected] ? `after step ${selected + 1}` : 'at the end'}:</span>
				{#each SOLENOIDS as s (s.id)}
					<button type="button" onclick={() => addFire(s.id)} class="rounded px-3 py-1 text-sm font-semibold" style={amber} title="Add a step that fires {s.label} (GPIO {s.pin})">⚡ {s.id}</button>
				{/each}
			</div>
			<button type="submit" class="{btn} w-full" style={green} disabled={!dirty}>{dirty ? 'Save move set' : 'Saved'}</button>
		</form>

		<!-- pose editor for the selected keyframe (or, for a fire step, the solenoids) -->
		<div class="space-y-3">
			{#if selFire?.fire}
				<div class={card} style={cardStyle}>
					<h2 class="text-sm font-semibold" style="color: #fbbf24">⚡ Step {selected! + 1}: fire {solenoidLabel(selFire.fire.solenoid)}</h2>
					<p class="mt-1 text-xs" style={muted}>
						When the play reaches this step the arm holds on {holdsOn(selected!)}. The Pi pulses {solenoidLabel(selFire.fire.solenoid)}
						(GPIO {solenoidPin(selFire.fire.solenoid)}) for {selFire.fire.pulseMs} ms, then waits {selFire.holdS} s for the cartridge to drop
						before the next step: {fireStepS(selFire).toFixed(1)} s in all.
					</p>
					<p class="mt-2 text-[11px]" style={muted}>
						The Pi fires on the recording's clock, separately from the arm, so the arm settling into a pose never delays a trapdoor.
						Two fire steps in a row are always at least {MIN_FIRE_WAIT_S} s apart, and the Pi never has both coils on at once.
					</p>
				</div>
				<SolenoidPanel status={solenoids} {armReachable} step={selFire.fire} />
			{:else if selPose}
				{#key selPose._id}
					<PoseEditor pose={selPose} allPoses={poses} arm={armNow} {armReachable} {blocked} {blockReason} ongoto={goTo} {home} />
					<PoseCameraCard pose={selPose} {camera} cameras={cameraNames} oncamera={setCamera} calibration={calFor(selPose._id)} arm={armNow} {armReachable} {blocked} {blockReason} ongoto={goTo} />
				{/key}
				<p class="text-[11px]" style={muted}>Saving a pose changes it in every move set that uses it. "Save as new" makes a new pose and uses it for this step.</p>
				{#if selPose.trim}
					<form method="POST" action="?/clearDroop" use:enhance class="text-[11px]" style={muted}>
						<input type="hidden" name="poseId" value={selPose._id} />
						This captured pose has a learned droop correction. <button type="submit" class="underline">forget it</button>
					</form>
				{/if}
			{:else}
				<div class={card} style={cardStyle}><p class="text-sm" style={muted}>Select a step to edit its pose.</p></div>
			{/if}

			<details class="{card} text-sm" style={cardStyle}>
				<summary class="cursor-pointer text-xs" style={muted}>More: save as a recording on the Pi, archive</summary>
				<div class="mt-3 flex flex-wrap items-end gap-2">
					<form method="POST" action="?/saveToPi" use:enhance class="flex flex-wrap items-end gap-2">
						<label class="block text-xs" style={muted}>Recording name<input name="recordingName" required maxlength="100" value={friendlyName(moveSet.name)} class="{input} mt-1 block w-56" style={inputStyle} /></label>
						<button type="submit" class="rounded px-3 py-1.5 text-sm font-semibold disabled:opacity-40" style={cyan} disabled={dirty || !kfs.length}>Save to Pi</button>
					</form>
					<span class="grow"></span>
					<form method="POST" action="?/archive" use:enhance onsubmit={(e) => { if (!confirm('Archive this move set?')) e.preventDefault(); }}>
						<button type="submit" class="text-xs underline" style={muted}>archive move set</button>
					</form>
				</div>
				<p class="mt-2 text-[11px]" style={muted}>A recording on the Pi can be replayed from the Control tab and used in tasks.</p>
			</details>
		</div>
	</div>
</div>
