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
	 * One request at a time: a fast drag becomes a short series of moves of at
	 * most LIVE_STEP from the last goal sent (stepToward), and the arm read
	 * (positions, temperatures, torque) is polled only while nothing is being
	 * sent — the Pi's servo bus must never see two callers at once.
	 */
	import { enhance } from '$app/forms';
	import { onDestroy } from 'svelte';
	import {
		axisTicks,
		friendlyName,
		heatLevel,
		sliderRange,
		stepToward,
		DEG_PER_STEP,
		ENCODER_MAX,
		SERVO_COUNT,
		SERVO_TEMP_STOP_C
	} from '$lib/robot-arm/animation';
	import type { PoseSummary } from '$lib/server/robot-arm-animation';

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
		/** Home as encoder steps (servo 1..6; null where unknown), from the Vision tab's calibration — the default reference marker. */
		home?: (number | null)[] | null;
	}

	let { pose, allPoses, arm, armReachable, blocked, blockReason, ongoto, onclose, home = null }: Props = $props();

	/** Largest move per live request; the servo covers this in a few tens of ms. */
	const LIVE_STEP = 120;
	/** "The arm is at these values" — loaded joints sit a few tens of steps short of their goal. */
	const AT_POSE_STEPS = 80;
	const POLL_MS = 1500;
	const SERVOS = Array.from({ length: SERVO_COUNT }, (_, i) => i);
	const JOINT_LABELS = ['Base', 'Shoulder', 'Elbow', 'Wrist flex', 'Wrist roll', 'Gripper'];

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
		out.push({ id: 'home', label: home ? 'Home' : 'Home (no calibration yet)', values: home });
		out.push({ id: 'opened', label: 'When this editor opened', values: opened });
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
					? 'Torque is off — press Torque on first.'
					: tooHot
						? `A servo is at or above ${SERVO_TEMP_STOP_C} °C — let it cool before moving the arm.`
						: ''
	);
	$effect(() => {
		if (live && !canLive) live = false;
	});

	/** The poll's request in flight, if any — a move must wait for it (the Pi's servo read has no bus lock). */
	let reading: Promise<void> | null = null;
	function readArmNow(): Promise<void> {
		if (!armReachable || sending) return Promise.resolve();
		if (!reading) reading = doRead().finally(() => (reading = null));
		return reading;
	}
	async function doRead() {
		try {
			const res = await fetch('/api/robot-arm/animate/live', { cache: 'no-store' });
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body?.error ?? `${res.status}`);
			activeKind = body.active?.kind ?? null;
			if (Array.isArray(body.positions)) {
				armPos = body.positions;
				if (!opened) opened = [...body.positions];
				temps = body.temps ?? temps;
				torqueOn = typeof body.torqueOn === 'boolean' ? body.torqueOn : null;
			}
		} catch (e) {
			note = { text: `Could not read the arm: ${e instanceof Error ? e.message : String(e)}`, kind: 'warn' };
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

	/** Send goals until every servo's last goal equals its slider; one request in flight. */
	async function pump() {
		if (sending || !live) return;
		sending = true;
		try {
			if (reading) await reading;
			while (live) {
				const goals: Record<number, number> = {};
				SERVOS.forEach((s) => {
					const from = sent[s] ?? armPos?.[s] ?? values[s];
					if (sent[s] === values[s]) return;
					goals[s + 1] = stepToward(from, values[s], LIVE_STEP);
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
				if (Array.isArray(body.positions)) armPos = body.positions;
				if (Array.isArray(body.temps)) temps = body.temps;
				note = body.warnings?.length ? { text: body.warnings.join(' '), kind: 'warn' } : body.via === 'jog' ? { text: 'This Pi has no absolute move route; using jogs (exact while the arm is still).', kind: 'warn' } : null;
			}
		} catch (e) {
			live = false;
			note = { text: `The arm did not move: ${e instanceof Error ? e.message : String(e)}`, kind: 'error' };
		} finally {
			sending = false;
		}
		// The arm settles after the last move; show where it ended up.
		setTimeout(() => void readArmNow(), 350);
	}

	function setValue(s: number, v: number) {
		if (!Number.isFinite(v)) return;
		// The slider's range follows the value (sliderRange includes it), so only the encoder bounds apply.
		values[s] = Math.round(Math.max(0, Math.min(ENCODER_MAX, v)));
		if (live) void pump();
	}

	/** Live on: the sliders now drive the arm. The arm must already be at them (Go to pose, or start from the arm). */
	function startLive() {
		if (!canLive) return;
		if (!atValues) {
			note = { text: pose ? 'The arm is not at these values yet — Go to pose first, or start from where the arm is.' : 'Start from where the arm is first.', kind: 'warn' };
			return;
		}
		// The arm's goals are the slider values (Go to left them there), so only changes are sent.
		sent = [...values];
		live = true;
		note = { text: 'Live — the arm follows the sliders.', kind: 'ok' };
	}

	/** Sliders := where the arm is, and make that the arm's goal too, so the two agree from here on. */
	async function startFromArm() {
		await readArmNow();
		if (!armPos || !canLive) return;
		values = [...armPos];
		sent = new Array(SERVO_COUNT).fill(null);
		live = true;
		await pump();
		note = { text: 'Live from where the arm is — the arm follows the sliders.', kind: 'ok' };
	}

	function reset() {
		if (pose) {
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
			{pose ? friendlyName(pose.name) : 'New pose'}
		</h2>
		{#if live}<span class="rounded px-2 py-0.5 text-[11px] font-semibold" style="background: rgba(74,222,128,0.15); color: #4ade80">LIVE</span>{/if}
		{#if dirty}<span class="text-[11px]" style="color: #fbbf24">unsaved changes</span>{/if}
		<span class="grow"></span>
		{#if live}
			<button type="button" class={btn} style={cyan} onclick={() => (live = false)}>Stop live</button>
		{:else}
			{#if pose && ongoto && !atValues}
				<button type="button" class={btn} style={amber} disabled={!canLive} onclick={() => ongoto?.(pose!)}>Go to pose</button>
			{/if}
			<button type="button" class={btn} style={green} disabled={!canLive || !atValues} onclick={startLive} title={atValues ? 'Sliders drive the arm' : 'The arm is not at these values'}>Live</button>
			<button type="button" class="text-xs underline disabled:opacity-40" style="color: var(--color-tron-text-secondary)" disabled={!canLive} onclick={startFromArm} title="Set the sliders to where the arm is and go live">start from the arm</button>
		{/if}
		{#if onclose}<button type="button" class="text-xs underline" style="color: var(--color-tron-text-secondary)" onclick={() => { live = false; onclose?.(); }}>close</button>{/if}
		<label class="flex w-full items-center gap-1 text-[11px] sm:w-auto" style="color: var(--color-tron-text-secondary)" title="The green dot above each slider stays on this reference; hover a dot for its number and where the arm really is">
			<span class="inline-block h-2 w-2 rounded-full" style="background: #4ade80"></span> marker
			<select bind:value={refChoice} class="{input} py-0.5 text-[11px]" style={inputStyle} aria-label="Reference marker">
				{#each refOptions as o (o.id)}<option value={o.id} disabled={!o.values}>{o.label}</option>{/each}
			</select>
		</label>
	</div>

	{#if why}
		<p class="mt-2 text-xs" style="color: #f59e0b">{why}</p>
	{:else if note}
		<p class="mt-2 text-xs" style="color: {note.kind === 'error' ? '#fca5a5' : note.kind === 'warn' ? '#fbbf24' : '#4ade80'}">{note.text}</p>
	{:else if !live}
		<p class="mt-2 text-xs" style="color: var(--color-tron-text-secondary)">
			{atValues ? 'Press Live, then move a slider — the arm follows.' : pose ? 'Go to pose, then press Live.' : 'Press "start from the arm" to pose from where the arm is.'}
		</p>
	{/if}

	<div class="mt-3 space-y-4">
		{#each SERVOS as s (s)}
			{@const r = ranges[s]}
			{@const ticks = axisTicks(r.min, r.max, 6)}
			<div class="grid grid-cols-[6.5rem_1fr] items-start gap-x-3 gap-y-1 sm:grid-cols-[7.5rem_1fr_auto]">
				<div class="pt-1">
					<div class="text-sm" style="color: var(--color-tron-text)">{JOINT_LABELS[s]}</div>
					<div class="text-[10px]" style="color: var(--color-tron-text-secondary)">
						servo {s + 1}
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
						oninput={(e) => setValue(s, Number(e.currentTarget.value))}
						class="w-full accent-cyan-400"
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
				<div class="col-span-2 flex items-center gap-1 sm:col-span-1">
					<button type="button" class={nudge} style={nudgeStyle} onclick={() => setValue(s, values[s] - 10)} aria-label="minus 10">−10</button>
					<button type="button" class={nudge} style={nudgeStyle} onclick={() => setValue(s, values[s] - 1)} aria-label="minus 1">−1</button>
					<!-- Exact entry: type a step value and press Enter (or leave the box) to apply it; the slider follows. -->
					<input
						type="number"
						min="0"
						max={ENCODER_MAX}
						step="1"
						value={values[s]}
						onchange={(e) => { setValue(s, Math.round(Number(e.currentTarget.value))); e.currentTarget.value = String(values[s]); }}
						onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
						class="{input} w-24 text-center font-mono tabular-nums"
						style={inputStyle}
						aria-label="{JOINT_LABELS[s]} value (steps)"
						title="Absolute encoder goal, 0–{ENCODER_MAX}. Enter applies it."
					/>
					<button type="button" class={nudge} style={nudgeStyle} onclick={() => setValue(s, values[s] + 1)} aria-label="plus 1">+1</button>
					<button type="button" class={nudge} style={nudgeStyle} onclick={() => setValue(s, values[s] + 10)} aria-label="plus 10">+10</button>
					<span class="ml-1 w-14 text-right font-mono text-[10px]" style="color: var(--color-tron-text-secondary)" title="Angle from the servo's centre">{deg(values[s])}°</span>
					{#if refValue(s) != null}
						<!-- the reference marker's value in words, and a way back to it -->
						<span class="ml-2 font-mono text-[10px]" style="color: {values[s] === refValue(s) ? 'var(--color-tron-text-secondary)' : '#4ade80'}" title="{ref.label}: {refValue(s)}{armPos ? ` · arm now: ${armPos[s]}` : ''}">● {refValue(s)}</span>
						{#if values[s] !== refValue(s)}
							<button type="button" class="{nudge} w-7" style={nudgeStyle} onclick={() => setValue(s, refValue(s)!)} title="Back to {refValue(s)} ({ref.label})" aria-label="back to the reference value">↺</button>
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
				<button type="submit" class={btn} style={green} disabled={!dirty}>Save pose</button>
			</form>
			<button type="button" class="text-xs underline disabled:opacity-40" style="color: var(--color-tron-text-secondary)" disabled={!dirty} onclick={reset}>reset to saved</button>
		{/if}
		<form method="POST" action="?/createPose" use:enhance={() => async ({ result, update }) => { await update({ reset: false }); if (result.type === 'success') newName = ''; }} class="flex flex-wrap items-end gap-2">
			<input type="hidden" name="positions" value={JSON.stringify(values)} />
			<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
				{pose ? 'Or save as a new pose' : 'Name'}
				<input name="name" bind:value={newName} required maxlength="80" placeholder="e.g. Over tray" class="{input} mt-1 block w-48" style={inputStyle} />
			</label>
			<button type="submit" class={btn} style={cyan} disabled={!newName.trim()}>Save as new</button>
		</form>
	</div>
</section>
