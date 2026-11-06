<script lang="ts">
	/**
	 * ARM-06 §13 — the pose editor: one slider per servo, with an axis.
	 *
	 * With Live on, every slider change drives that servo of the real arm to
	 * the slider's value (an absolute goal, POST /api/robot-arm/animate/live),
	 * so a pose is made by moving sliders and watching the arm. The values
	 * saved are the goals the arm was given, so playing the pose later sends
	 * the same goals and the arm lands in the same place.
	 *
	 * One request at a time: each request sends every changed slider's value
	 * as the servo's absolute goal — the whole distance, no pieces and no step
	 * limit (operator decision 2026-10-23: "if I want to move the joint to a
	 * specific value, it should move to that specific value"). The arm read
	 * (positions, temperatures, torque) is polled only while nothing is being
	 * sent — the Pi's servo bus must never see two callers at once.
	 *
	 * The sliders are locked until Live is on (2026-10-28): moving a slider
	 * that does nothing confused operators, who then pressed Live and had the
	 * arm start moving under them.
	 *
	 * Turning Live on sends NOTHING (2026-11-05). It used to write the arm's
	 * encoder reading back as every servo's goal; a loaded joint sits short of
	 * its goal, so the new, lower goal dropped the arm again (elbow 2377 →
	 * 2456 → 2464 on Rr.0.5 home). Now, at the pose, the sliders start on the
	 * pose's numbers and each servo keeps the goal it holds; only a slider that
	 * moves sends its servo a goal — the slider's number, exactly (no droop
	 * trim and no closed-loop correction since 2026-11-06: what you set is
	 * what every play sends). Away from the pose they start at the reading,
	 * still sending nothing.
	 *
	 * Edit Values (2026-11-05): an explicit second way in. It unlocks the
	 * sliders and number boxes WITHOUT the arm (unreachable, torque off, a
	 * session on it — no matter), nothing moves, and Save Pose writes the
	 * numbers. Asked for from the Move Set page: edit and save a step's pose
	 * there. Live and Edit Values never run together; Live takes the arm's
	 * position, so it asks before throwing unsaved values away.
	 */
	import type { Snippet } from 'svelte';
	import { enhance } from '$app/forms';
	import { onDestroy } from 'svelte';
	import {
		axisTicks,
		friendlyName,
		heatLevel,
		sliderRange,
		DEG_PER_STEP,
		ENCODER_MAX,
		SERVO_COUNT,
		SERVO_TEMP_STOP_C
	} from '$lib/robot-arm/animation';
	import type { PoseSummary } from '$lib/server/robot-arm-animation';
	import { liveBus } from '$lib/robot-arm/bus-free';

	interface ArmRead {
		positions: number[];
		temps: (number | null)[];
		torqueOn: boolean | null;
	}

	interface Props {
		/** The pose being edited, or null for a new pose. */
		pose: PoseSummary | null;
		/** Every pose, for the slider ranges. */
		allPoses: PoseSummary[];
		/** The page's last read of the arm, so the editor has numbers before its first poll. */
		arm: ArmRead | null;
		armReachable: boolean;
		/** Page-level reason nothing may move (a session or a play is running, …). */
		blocked: boolean;
		blockReason: string;
		/** Play a Go to for this pose (the page owns playback). */
		ongoto?: (pose: PoseSummary) => void;
		onclose?: () => void;
		/** Drawn just left of Live (the Animate page puts Follow Leader Arm here). */
		beforeLive?: Snippet;
		/** Home as encoder steps (servo 1..6; null where unknown), from the Vision tab's calibration — the default reference marker. */
		home?: (number | null)[] | null;
	}

	let { pose, allPoses, arm, armReachable, blocked, blockReason, ongoto, onclose, home = null, beforeLive }: Props = $props();

	/** "The arm is at these values" — loaded joints sit a few tens of steps short of their goal. */
	const AT_POSE_STEPS = 80;
	/** Live starts on the pose's numbers when every servo is this close. */
	const LIVE_FROM_POSE_STEPS = 150;
	// Fast enough that the New Pose sliders track an arm moved by hand (2026-11-04, was 1500).
	// One read at a time (readArmNow), so a slow route just lowers the rate.
	const POLL_MS = 300;
	const SERVOS = Array.from({ length: SERVO_COUNT }, (_, i) => i);
	const JOINT_LABELS = ['Base', 'Shoulder', 'Elbow', 'Wrist Flex', 'Wrist Roll', 'Gripper'];

	// The sliders: what the arm is (or will be) told. Starts at the pose, or at the arm for a new pose.
	// svelte-ignore state_referenced_locally
	let values = $state<number[]>([...(pose?.positions ?? arm?.positions ?? new Array(SERVO_COUNT).fill(2048))]);
	// svelte-ignore state_referenced_locally
	let armPos = $state<number[] | null>(arm?.positions ?? null);
	/**
	 * Where the arm was when this editor opened (first read), kept for the
	 * whole edit — after a few −10s the operator asked "what was it before?"
	 * (2026-10-22). One of the reference-marker choices; a page reload
	 * starts a new one.
	 */
	// svelte-ignore state_referenced_locally
	let opened = $state<number[] | null>(arm?.positions ? [...arm.positions] : null);
	/**
	 * The reference marker (green dot) above each slider. It used to be
	 * "where the arm is", which just follows the slider once Live is on —
	 * useless. Now it stays on a chosen reference: Home (default, from the
	 * Vision tab calibration), where the arm was when the editor opened, or
	 * any saved pose (e.g. the previous step). Hover the dot for the numbers;
	 * ↺ puts the slider (and, live, the arm) back to it.
	 */
	let refChoice = $state<'home' | 'opened' | string>('home');
	// svelte-ignore state_referenced_locally
	let temps = $state<(number | null)[]>(arm?.temps ?? new Array(SERVO_COUNT).fill(null));
	// svelte-ignore state_referenced_locally
	let torqueOn = $state<boolean | null>(arm?.torqueOn ?? null);
	let activeKind = $state<string | null>(null);
	let live = $state(false);
	/** Edit Values: the controls are open and the arm is left alone. */
	let editing = $state(false);
	const unlocked = $derived(live || editing);
	let sending = $state(false);
	let note = $state<{ text: string; kind: 'ok' | 'warn' | 'error' } | null>(null);
	let newName = $state('');
	/** Goals last sent to the arm, per servo (null = never sent this session). */
	let sent: (number | null)[] = new Array(SERVO_COUNT).fill(null);

	// Take the page's fresh read after its own actions (Go to, Torque on) re-ran the load —
	// only when that prop actually changes, never on our own state changes.
	// svelte-ignore state_referenced_locally
	let seenArm: ArmRead | null = arm;
	$effect(() => {
		const a = arm;
		if (a && a !== seenArm) {
			seenArm = a;
			armPos = a.positions;
			if (!opened) opened = [...a.positions];
			temps = a.temps;
			torqueOn = a.torqueOn;
		}
	});

	// Reference marker: which values the green dot sits on.
	const refOptions = $derived.by(() => {
		const out: { id: string; label: string; values: (number | null)[] | null }[] = [];
		out.push({ id: 'home', label: home ? 'Home' : 'Home (Not Calibrated)', values: home });
		out.push({ id: 'opened', label: 'When Editor Opened', values: opened });
		for (const p of allPoses.filter((p) => !p.archived && p._id !== pose?._id)) out.push({ id: p._id, label: friendlyName(p.name), values: p.positions });
		return out;
	});
	// Home is the default; without a home calibration, fall back to where the arm was when the editor opened.
	$effect(() => {
		if (refChoice === 'home' && !home && opened) refChoice = 'opened';
	});
	const ref = $derived(refOptions.find((o) => o.id === refChoice) ?? refOptions[0]);
	const refValues = $derived(ref?.values ?? null);
	const refValue = (s: number): number | null => {
		const v = refValues?.[s];
		return typeof v === 'number' && Number.isFinite(v) ? v : null;
	};

	const ranges = $derived(
		SERVOS.map((s) => sliderRange([...allPoses.filter((p) => !p.archived).map((p) => p.positions[s]), ...(armPos ? [armPos[s]] : []), ...(refValue(s) != null ? [refValue(s)!] : []), values[s]]))
	);
	const dirty = $derived(!!pose && values.some((v, i) => v !== pose.positions[i]));
	const offBy = $derived(armPos ? Math.max(...values.map((v, i) => Math.abs(v - armPos![i]))) : Infinity);
	const atValues = $derived(offBy <= AT_POSE_STEPS);
	const tooHot = $derived(temps.some((t) => heatLevel(t) === 'stop'));
	const canLive = $derived(armReachable && !blocked && !activeKind && torqueOn !== false && !tooHot);
	const why = $derived(
		!armReachable || blocked
			? blockReason
			: activeKind
				? `A ${activeKind} session is using the arm.`
				: torqueOn === false
					? 'Torque is off.'
					: tooHot
						? `A servo is at or above ${SERVO_TEMP_STOP_C} °C.`
						: ''
	);
	$effect(() => {
		if (live && !canLive) live = false;
	});

	/** The poll's request in flight, if any — a move must wait for it (the Pi's servo read has no bus lock). */
	let reading: Promise<void> | null = null;
	function readArmNow(): Promise<void> {
		// Not while the page is playing (or anything else owns the arm): the Pi's bus belongs to that session.
		if (!armReachable || sending || blocked) return Promise.resolve();
		if (!reading) reading = doRead().finally(() => (reading = null));
		return reading;
	}
	const READ_FAILED = 'Could not read the arm:';
	async function doRead() {
		try {
			const res = await fetch('/api/robot-arm/animate/live', { cache: 'no-store' });
			const body = await res.json().catch(() => ({}));
			// A session took the bus between BIMS's check and the read (a Move To just started): busy, not a fault.
			if (res.status === 409 && /session is currently active|single-owner/i.test(String(body?.error ?? ''))) return;
			if (!res.ok) throw new Error(body?.error ?? `${res.status}`);
			activeKind = body.active?.kind ?? null;
			if (note?.text.startsWith(READ_FAILED)) note = null;
			if (Array.isArray(body.positions)) {
				armPos = body.positions;
				// New Pose with Live off: the sliders show where the arm is right now (unless the numbers are being edited).
				if (!pose && !live && !editing && !sending) values = [...body.positions];
				if (!opened) opened = [...body.positions];
				temps = body.temps ?? temps;
				torqueOn = typeof body.torqueOn === 'boolean' ? body.torqueOn : null;
			}
		} catch (e) {
			note = { text: `${READ_FAILED} ${e instanceof Error ? e.message : String(e)}`, kind: 'warn' };
		}
	}

	let timer: ReturnType<typeof setInterval> | null = null;
	$effect(() => {
		if (!armReachable) return;
		void readArmNow();
		timer = setInterval(() => void readArmNow(), POLL_MS);
		return () => {
			if (timer) clearInterval(timer);
			timer = null;
		};
	});
	onDestroy(() => {
		if (timer) clearInterval(timer);
	});

	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	/** Send goals until every servo's last goal equals its slider, exactly; one request in flight. */
	async function pump() {
		if (sending || !live) return;
		sending = true;
		liveBus.sending = true;
		let sentAny = false;
		try {
			if (reading) await reading;
			while (live) {
				const goals: Record<number, number> = {};
				SERVOS.forEach((s) => {
					const g = Math.max(0, Math.min(ENCODER_MAX, values[s]));
					if (sent[s] === g) return;
					goals[s + 1] = g;
				});
				if (!Object.keys(goals).length) break;
				const res = await fetch('/api/robot-arm/animate/live', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ goals })
				});
				const body = await res.json().catch(() => ({}));
				if (!res.ok) {
					live = false;
					note = { text: body?.error ?? `The arm did not move (${res.status}).`, kind: 'error' };
					if (res.status === 409 && /torque/i.test(note.text)) torqueOn = false;
					break;
				}
				for (const [sid, g] of Object.entries(goals)) sent[Number(sid) - 1] = g;
				sentAny = true;
				if (Array.isArray(body.positions)) armPos = body.positions;
				if (Array.isArray(body.temps)) temps = body.temps;
				note = body.warnings?.length ? { text: body.warnings.join(' '), kind: 'warn' } : body.via === 'jog' ? { text: 'No absolute move route; using jogs.', kind: 'warn' } : null;
			}
		} catch (e) {
			live = false;
			note = { text: `The arm did not move: ${e instanceof Error ? e.message : String(e)}`, kind: 'error' };
		} finally {
			sending = false;
			liveBus.sending = false;
		}
		// Show where the arm came to rest after the last move (Arm Now); nothing corrects it.
		if (sentAny) {
			await sleep(350);
			void readArmNow();
		}
	}

	function setValue(s: number, v: number) {
		// Sliders only move the arm: nothing changes them until Live or Edit Values is on.
		if (!unlocked || !Number.isFinite(v)) return;
		// The slider's range follows the value (sliderRange includes it), so only the encoder bounds apply.
		const next = Math.round(Math.max(0, Math.min(ENCODER_MAX, v)));
		values[s] = next;
		if (live) void pump();
	}

	/**
	 * Live on. Nothing is sent: each servo keeps the goal it holds, so the arm
	 * does not move. At the pose the sliders start on the pose's numbers;
	 * elsewhere on the reading. From then on a slider that moves sends only its
	 * own servo, the number as typed.
	 */
	async function startLive() {
		if (editing && dirty && !confirm('Live sets the sliders to the pose (or where the arm is). Discard the unsaved values?')) return;
		editing = false;
		await readArmNow();
		if (!armPos || !canLive) {
			if (!armPos) note = { text: 'Could not read the arm.', kind: 'warn' };
			return;
		}
		const now = armPos;
		const atPose = !!pose && pose.positions.every((v, i) => Math.abs(v - now[i]) <= LIVE_FROM_POSE_STEPS);
		values = atPose ? [...pose!.positions] : [...now];
		sent = [...values];
		live = true;
		note = { text: atPose ? 'Sliders At The Pose' : 'Sliders At The Arm', kind: 'ok' };
	}

	function reset() {
		if (pose && unlocked) {
			values = [...pose.positions];
			if (live) void pump();
		}
	}

	const deg = (v: number) => ((v - 2048) * DEG_PER_STEP).toFixed(1);
	const pct = (v: number, s: number) => {
		const r = ranges[s];
		return r.max > r.min ? ((v - r.min) / (r.max - r.min)) * 100 : 50;
	};
	const heatColor = (t: number | null) => {
		const l = heatLevel(t);
		return l === 'stop' ? '#ef4444' : l === 'hot' ? '#f97316' : l === 'warm' ? '#fbbf24' : 'var(--color-tron-text-secondary)';
	};
	const btn = 'min-h-[38px] rounded px-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40';
	const cyan = 'background: rgba(56,189,248,0.15); color: var(--color-tron-cyan); border: 1px solid var(--color-tron-cyan);';
	const green = 'background: rgba(74,222,128,0.12); color: #4ade80; border: 1px solid #4ade80;';
	const amber = 'background: rgba(245,158,11,0.15); color: #fbbf24; border: 1px solid #f59e0b;';
	const nudge = 'h-8 w-9 rounded border font-mono text-xs disabled:opacity-30';
	const nudgeStyle = 'border-color: var(--color-tron-border); color: var(--color-tron-text-secondary);';
	const input = 'rounded border bg-black/40 px-2 py-1 text-sm';
	const inputStyle = 'border-color: var(--color-tron-border); color: var(--color-tron-text)';
</script>

<section class="rounded border p-3 sm:p-4" style="border-color: {live ? '#4ade80' : 'var(--color-tron-border)'}; background: var(--color-tron-surface);">
	<div class="flex flex-wrap items-center gap-3">
		<h2 class="text-sm font-semibold tracking-wide" style="color: var(--color-tron-text)">
			{pose ? friendlyName(pose.name) : 'New Pose'}
		</h2>
		{#if live}<span class="rounded px-2 py-0.5 text-[11px] font-semibold" style="background: rgba(74,222,128,0.15); color: #4ade80">LIVE</span>
		{:else if editing}<span class="rounded px-2 py-0.5 text-[11px] font-semibold" style="background: rgba(245,158,11,0.15); color: #fbbf24" title="The numbers are open; the arm does not move">EDITING VALUES</span>{/if}
		{#if dirty}<span class="text-[11px]" style="color: #fbbf24">Unsaved Changes</span>{/if}
		<span class="grow"></span>
		{#if live}
			<button type="button" class={btn} style={cyan} onclick={() => (live = false)}>Stop Live</button>
		{:else}
			{#if pose && ongoto && !atValues}
				<button type="button" class={btn} style={amber} disabled={!canLive} onclick={() => ongoto?.(pose!)}>Go To Pose</button>
			{/if}
			{@render beforeLive?.()}
			<button type="button" class={btn} style={editing ? amber : cyan} onclick={() => (editing = !editing)} title={editing ? 'Lock the numbers again' : 'Change the numbers without moving the arm; Save Pose keeps them'}>{editing ? 'Stop Editing' : 'Edit Values'}</button>
			<button type="button" class={btn} style={green} disabled={!canLive} onclick={startLive} title="The arm does not move until a slider does; then only that servo moves">Live</button>
		{/if}
		{#if onclose}<button type="button" class="text-xs underline" style="color: var(--color-tron-text-secondary)" onclick={() => { live = false; onclose?.(); }}>Close</button>{/if}
		<label class="flex w-full items-center gap-1 text-[11px] sm:w-auto" style="color: var(--color-tron-text-secondary)" title="The green dot above each slider stays on this reference; hover a dot for its number and where the arm really is">
			<span class="inline-block h-2 w-2 rounded-full" style="background: #4ade80"></span> Marker
			<select bind:value={refChoice} class="{input} py-0.5 text-[11px]" style={inputStyle} aria-label="Reference marker">
				{#each refOptions as o (o.id)}<option value={o.id} disabled={!o.values}>{o.label}</option>{/each}
			</select>
		</label>
	</div>

	{#if why}
		<p class="mt-2 text-xs" style="color: #f59e0b">{why}</p>
	{:else if note}
		<p class="mt-2 text-xs" style="color: {note.kind === 'error' ? '#fca5a5' : note.kind === 'warn' ? '#fbbf24' : '#4ade80'}">{note.text}</p>
	{/if}

	<div class="mt-3 space-y-4">
		{#each SERVOS as s (s)}
			{@const r = ranges[s]}
			{@const ticks = axisTicks(r.min, r.max, 6)}
			<div class="grid grid-cols-[6.5rem_1fr] items-start gap-x-3 gap-y-1 sm:grid-cols-[7.5rem_1fr]">
				<div class="pt-1">
					<div class="text-sm" style="color: var(--color-tron-text)">{JOINT_LABELS[s]}</div>
					<div class="text-[10px]" style="color: var(--color-tron-text-secondary)">
						Servo {s + 1}
						<span class="ml-1 font-mono" style="color: {heatColor(temps[s])}" title="Servo temperature">{temps[s] != null ? `${temps[s]}°C` : ''}</span>
					</div>
				</div>
				<div class="min-w-0">
					<!-- markers: saved pose value and where the arm is -->
					<div class="relative mx-2 h-3">
						{#if pose}
							<span class="absolute -translate-x-1/2 text-[10px] leading-none" style="left: {pct(pose.positions[s], s)}%; color: var(--color-tron-text-secondary)" title="Saved: {pose.positions[s]}">▼</span>
						{/if}
						{#if refValue(s) != null}
							<span class="absolute top-1 h-2 w-2 -translate-x-1/2 rounded-full" style="left: {pct(refValue(s)!, s)}%; background: #4ade80" title="{ref.label}: {refValue(s)}{armPos ? ` · arm now: ${armPos[s]}` : ''}{opened && opened[s] !== refValue(s) ? ` · when this editor opened: ${opened[s]}` : ''}"></span>
						{/if}
					</div>
					<input
						type="range"
						min={r.min}
						max={r.max}
						step="1"
						value={values[s]}
						disabled={!unlocked}
						oninput={(e) => setValue(s, Number(e.currentTarget.value))}
						class="w-full accent-cyan-400 disabled:cursor-not-allowed disabled:opacity-40"
						aria-label="{JOINT_LABELS[s]} (servo {s + 1})"
					/>
					<!-- axis -->
					<div class="relative mx-2 h-5">
						{#each ticks as t (t)}
							<span class="absolute top-0 h-1.5 w-px" style="left: {pct(t, s)}%; background: var(--color-tron-border)"></span>
							<span class="absolute top-1.5 -translate-x-1/2 font-mono text-[9px]" style="left: {pct(t, s)}%; color: var(--color-tron-text-secondary)">{t}</span>
						{/each}
					</div>
				</div>
				<div class="col-start-2 flex flex-wrap items-center gap-1">
					<button type="button" class={nudge} style={nudgeStyle} disabled={!unlocked} onclick={() => setValue(s, values[s] - 10)} aria-label="minus 10">−10</button>
					<button type="button" class={nudge} style={nudgeStyle} disabled={!unlocked} onclick={() => setValue(s, values[s] - 1)} aria-label="minus 1">−1</button>
					<!-- Exact entry: type a step value and press Enter (or leave the box) to apply it; the slider follows. -->
					<input
						type="number"
						min="0"
						max={ENCODER_MAX}
						step="1"
						value={values[s]}
						disabled={!unlocked}
						onchange={(e) => { setValue(s, Math.round(Number(e.currentTarget.value))); e.currentTarget.value = String(values[s]); }}
						onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
						class="{input} w-24 text-center font-mono tabular-nums disabled:cursor-not-allowed disabled:opacity-40"
						style={inputStyle}
						aria-label="{JOINT_LABELS[s]} value (steps)"
						title="Absolute encoder goal, 0–{ENCODER_MAX}. Enter applies it."
					/>
					<button type="button" class={nudge} style={nudgeStyle} disabled={!unlocked} onclick={() => setValue(s, values[s] + 1)} aria-label="plus 1">+1</button>
					<button type="button" class={nudge} style={nudgeStyle} disabled={!unlocked} onclick={() => setValue(s, values[s] + 10)} aria-label="plus 10">+10</button>
					<span class="ml-1 w-14 text-right font-mono text-[10px]" style="color: var(--color-tron-text-secondary)" title="Angle from the servo's centre">{deg(values[s])}°</span>
					{#if armPos}
						<span class="ml-2 font-mono text-[10px] tabular-nums" style="color: var(--color-tron-text-secondary)" title="Where this servo's encoder reads right now">Arm Now {armPos[s]}</span>
					{/if}
					{#if refValue(s) != null}
						<!-- the reference marker's value in words, and a way back to it -->
						<span class="ml-2 font-mono text-[10px]" style="color: {values[s] === refValue(s) ? 'var(--color-tron-text-secondary)' : '#4ade80'}" title="{ref.label}: {refValue(s)}{armPos ? ` · arm now: ${armPos[s]}` : ''}">● {refValue(s)}</span>
						{#if values[s] !== refValue(s)}
							<button type="button" class="{nudge} w-7" style={nudgeStyle} disabled={!unlocked} onclick={() => setValue(s, refValue(s)!)} title="Back to {refValue(s)} ({ref.label})" aria-label="back to the reference value">↺</button>
						{/if}
					{/if}
				</div>
			</div>
		{/each}
	</div>

	<div class="mt-4 flex flex-wrap items-end gap-3 border-t pt-3" style="border-color: var(--color-tron-border)">
		{#if pose}
			<form method="POST" action="?/savePosePositions" use:enhance={() => async ({ update }) => { await update({ reset: false }); }}>
				<input type="hidden" name="id" value={pose._id} />
				<input type="hidden" name="positions" value={JSON.stringify(values)} />
				<button type="submit" class={btn} style={green} disabled={!dirty}>Save Pose</button>
			</form>
			<button type="button" class="text-xs underline disabled:opacity-40" style="color: var(--color-tron-text-secondary)" disabled={!dirty || !unlocked} onclick={reset} title={live ? 'Sliders (and the arm) back to the saved pose' : editing ? 'The numbers back to the saved pose' : 'Press Live or Edit Values first'}>Reset To Saved</button>
		{/if}
		<form method="POST" action="?/createPose" use:enhance={() => async ({ result, update }) => { await update({ reset: false }); if (result.type === 'success') newName = ''; }} class="flex flex-wrap items-end gap-2">
			<input type="hidden" name="positions" value={JSON.stringify(values)} />
			<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
				{pose ? 'New Pose Name' : 'Name'}
				<input name="name" bind:value={newName} required maxlength="80" placeholder="e.g. Over Tray" class="{input} mt-1 block w-48" style={inputStyle} />
			</label>
			<button type="submit" class={btn} style={cyan} disabled={!newName.trim()}>Save As New</button>
		</form>
	</div>
</section>
