<script lang="ts">
	/**
	 * Recording clean-up editor. The draft lives here, in the browser, until
	 * Save; every change goes through edit() so it can be undone. The page
	 * never invalidates its own data except after a re-split, so a reload of
	 * the arm layout cannot wipe unsaved edits.
	 */
	import { deserialize } from '$app/forms';
	import { beforeNavigate, goto, invalidateAll } from '$app/navigation';
	import type { ActionResult } from '@sveltejs/kit';
	import CleanupTimeline from '$lib/components/robot-arm/CleanupTimeline.svelte';
	import {
		DEFAULT_ANIMATION_EASING,
		SERVO_IDS,
		draftToAnimation,
		newStepId,
		resolveSteps,
		roundTenth,
		type AnimationDraft,
		type CleanMove,
		type CleanStep
	} from '$lib/robot-arm/recording-cleanup';
	import { EASINGS, type Easing } from '$lib/robot-arm/animation';
	import { STEPS_PER_DEGREE } from '$lib/robot-arm/recording-steps';

	let { data } = $props();

	const BASE = '/manufacturing/cart-mfg/robot-arm';
	/** Moves smaller than this get a "small" tag, as a hint only. */
	const SMALL_MOVE = 25;
	const UNDO_LIMIT = 100;

	type Snapshot = { title: string; start: Record<string, number>; steps: CleanStep[] };

	function fromData(): Snapshot {
		const c = data.cleanup;
		return JSON.parse(JSON.stringify({ title: c.title ?? '', start: c.start ?? {}, steps: c.steps ?? [] }));
	}
	const initial = fromData();
	let title = $state(initial.title);
	let start = $state<Record<string, number>>(initial.start);
	let steps = $state<CleanStep[]>(initial.steps);
	let savedJson = $state(JSON.stringify(initial));
	let undoStack = $state<string[]>([]);
	let redoStack = $state<string[]>([]);

	const snapshot = (): Snapshot => $state.snapshot({ title, start, steps }) as Snapshot;
	const currentJson = $derived(JSON.stringify({ title, start, steps }));
	const dirty = $derived(currentJson !== savedJson);

	function restore(json: string) {
		const s = JSON.parse(json) as Snapshot;
		title = s.title;
		start = s.start;
		steps = s.steps;
	}
	/** Every change goes through here so Undo can take it back. */
	function edit(fn: () => void) {
		undoStack = [...undoStack.slice(-UNDO_LIMIT + 1), JSON.stringify(snapshot())];
		redoStack = [];
		fn();
	}
	function undo() {
		const prev = undoStack.at(-1);
		if (!prev) return;
		redoStack = [...redoStack, JSON.stringify(snapshot())];
		undoStack = undoStack.slice(0, -1);
		restore(prev);
	}
	function redo() {
		const next = redoStack.at(-1);
		if (!next) return;
		undoStack = [...undoStack, JSON.stringify(snapshot())];
		redoStack = redoStack.slice(0, -1);
		restore(next);
	}

	const resolved = $derived(resolveSteps({ start, steps }));
	const names = $derived(data.cleanup.jointNames);
	const moveCount = $derived(steps.reduce((n, s) => n + s.moves.length, 0));
	const armReachable = $derived(data.arm?.reachable ?? false);

	let selectedId = $state<string | null>(null);
	function select(id: string) {
		selectedId = id;
		document.getElementById(`step-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
	}

	// --- messages --------------------------------------------------------
	let notice = $state<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);
	let busy = $state<string | null>(null);

	async function callAction(name: string, fields: Record<string, string>): Promise<ActionResult> {
		const fd = new FormData();
		for (const [k, v] of Object.entries(fields)) fd.set(k, v);
		const res = await fetch(`?/${name}`, { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
		return deserialize(await res.text());
	}
	function errorOf(r: ActionResult): string {
		if (r.type === 'failure') return String((r.data as { error?: string })?.error ?? 'Failed');
		if (r.type === 'error') return r.error?.message ?? 'Server error';
		return 'Unexpected response';
	}
	async function run<T>(label: string, name: string, fields: Record<string, string>): Promise<T | null> {
		busy = label;
		notice = null;
		try {
			const r = await callAction(name, fields);
			if (r.type === 'success') return (r.data ?? {}) as T;
			notice = { kind: 'error', text: errorOf(r) };
			return null;
		} catch (err) {
			notice = { kind: 'error', text: (err as Error).message };
			return null;
		} finally {
			busy = null;
		}
	}

	// --- save --------------------------------------------------------------
	async function save() {
		const json = JSON.stringify(snapshot());
		const ok = await run<{ saved: boolean }>('save', 'save', { payload: json });
		if (ok) {
			savedJson = json;
			notice = { kind: 'ok', text: 'Saved.' };
		}
	}

	function suggestedName() {
		const stem = data.cleanup.sourceName.replace(/\.jsonl$/i, '');
		const n = data.cleanup.savedAs.length;
		return `${stem}-clean${n ? `-${n + 1}` : ''}`;
	}
	let piName = $state(suggestedName());
	async function saveToPi() {
		if (!steps.length) return;
		const json = JSON.stringify(snapshot());
		const r = await run<{ savedAs: { name: string; frames: number; durationS: number } }>('pi', 'saveToPi', {
			payload: json,
			name: piName
		});
		if (r) {
			savedJson = json;
			notice = {
				kind: 'ok',
				text: `Saved on the Pi as "${r.savedAs.name}" (${r.savedAs.frames} frames, ${r.savedAs.durationS.toFixed(1)} s). Replay it from the Control tab.`
			};
			await invalidateAll();
			piName = suggestedName();
		}
	}

	// --- to the Animate tab ---------------------------------------------------
	// Same steps, rendered by the Animate engine: poses + a move set the operator
	// keeps adjusting there. Previewed here from the draft on screen.
	let animateName = $state(initial.title || data.cleanup.sourceName.replace(/\.jsonl$/i, ''));
	let animateEasing = $state<Easing>(DEFAULT_ANIMATION_EASING);
	const animatePreview = $derived.by((): { draft: AnimationDraft | null; error: string | null } => {
		if (!steps.length) return { draft: null, error: null };
		try {
			return { draft: draftToAnimation({ start, steps }, { easing: animateEasing }), error: null };
		} catch (e) {
			return { draft: null, error: (e as Error).message };
		}
	});
	const animateDurationS = $derived(
		animatePreview.draft ? animatePreview.draft.keyframes.reduce((t, k, i) => t + (i ? k.durationS : 0) + k.holdS, 0) : 0
	);
	const listSteps = (ns: number[]) => `Step${ns.length > 1 ? 's' : ''} ${ns.join(', ')}`;
	async function sendToAnimate() {
		if (!steps.length || animatePreview.error) return;
		const json = JSON.stringify(snapshot());
		const r = await run<{ animate: { moveSetId: string; name: string; poses: number; keyframes: number } }>('animate', 'toAnimate', {
			payload: json,
			name: animateName,
			easing: animateEasing
		});
		if (r) {
			savedJson = json;
			notice = { kind: 'ok', text: `Made "${r.animate.name}" (${r.animate.poses} poses). Opening it in the Animate tab…` };
			await goto(`${BASE}/animate/moveset/${r.animate.moveSetId}`);
		}
	}

	// --- re-split ------------------------------------------------------------
	const splitWas = () => ({ threshold: data.cleanup.thresholdSteps, pause: data.cleanup.pauseS });
	let splitThreshold = $state(splitWas().threshold);
	let splitPause = $state(splitWas().pause);
	async function resplit() {
		if (!confirm(`Split the recording again? This replaces all ${steps.length} steps and every edit you made (Undo cannot bring them back).`)) return;
		const r = await run<{ steps: number }>('resplit', 'resplit', {
			thresholdSteps: String(splitThreshold),
			pauseS: String(splitPause)
		});
		if (r) {
			await invalidateAll();
			const fresh = fromData();
			restore(JSON.stringify(fresh));
			savedJson = JSON.stringify(fresh);
			undoStack = [];
			redoStack = [];
			selectedId = null;
			notice = { kind: 'ok', text: `Split again: ${r.steps} steps.` };
		}
	}

	// --- arm -----------------------------------------------------------------
	let arm = $state<{ positions: Record<string, number>; at: Date } | null>(null);
	async function readArm(): Promise<Record<string, number> | null> {
		const r = await run<{ arm: Record<string, number> }>('read', 'readArm', {});
		if (r) arm = { positions: r.arm, at: new Date() };
		return r?.arm ?? null;
	}
	async function moveArmTo(label: string, targets: Record<string, number>) {
		const list = Object.entries(targets)
			.map(([sid, v]) => `${names[Number(sid) - 1] ?? sid} → ${v}`)
			.join('\n');
		if (!confirm(`Move the follower arm to ${label}?\n\n${list}\n\nServos move one at a time, at full speed, ≤300 steps per jog.`)) return;
		const r = await run<{ moved: { after: Record<string, number>; jogs: number; residual: Record<string, number> } }>(
			'move',
			'moveArm',
			{ label, targets: JSON.stringify(targets) }
		);
		if (r) {
			arm = { positions: r.moved.after, at: new Date() };
			const off = Object.entries(r.moved.residual).filter(([, d]) => Math.abs(d) > 5);
			notice = off.length
				? { kind: 'info', text: `Moved (${r.moved.jogs} jogs), but ${off.map(([sid, d]) => `${names[Number(sid) - 1]} is ${d} steps short`).join(', ')}. Something may be blocking it, or it hit a limit.` }
				: { kind: 'ok', text: `Arm is at ${label} (${r.moved.jogs} jogs).` };
		}
	}

	// --- step operations -----------------------------------------------------
	const clampPos = (v: number) => Math.max(0, Math.min(4095, Math.round(v)));
	function num(e: Event): number | null {
		const v = Number((e.currentTarget as HTMLInputElement).value);
		return Number.isFinite(v) ? v : null;
	}

	function setTo(si: number, sid: number, v: number) {
		edit(() => {
			const m = steps[si].moves.find((x) => x.servoId === sid);
			if (m) m.to = clampPos(v);
		});
	}
	function setDuration(si: number, v: number) {
		edit(() => (steps[si].durationS = Math.max(0.1, Math.min(120, roundTenth(v)))));
	}
	function setPause(si: number, v: number) {
		edit(() => (steps[si].pauseAfterS = Math.max(0, Math.min(120, roundTenth(v)))));
	}
	function setLabel(si: number, v: string) {
		edit(() => (steps[si].label = v.slice(0, 120)));
	}
	function deleteMove(si: number, sid: number) {
		edit(() => (steps[si].moves = steps[si].moves.filter((m) => m.servoId !== sid)));
	}
	function addMove(si: number, sid: number) {
		const from = resolved.steps[si].before[String(sid)] ?? 2048;
		edit(() => {
			steps[si].moves = [...steps[si].moves, { servoId: sid, to: from, raw: null }].sort((a, b) => a.servoId - b.servoId);
		});
	}
	function deleteStep(si: number) {
		if (!confirm(`Delete step ${si + 1}${steps[si].moves.length ? ` and its ${steps[si].moves.length} move(s)` : ''}? Later steps keep their targets.`)) return;
		edit(() => (steps = steps.filter((_, i) => i !== si)));
	}
	function moveStep(si: number, dir: -1 | 1) {
		const j = si + dir;
		if (j < 0 || j >= steps.length) return;
		edit(() => {
			const next = [...steps];
			[next[si], next[j]] = [next[j], next[si]];
			steps = next;
		});
	}
	function insertAfter(si: number) {
		const s: CleanStep = { id: newStepId(), label: '', durationS: 1, pauseAfterS: 0, raw: null, moves: [] };
		edit(() => (steps = [...steps.slice(0, si + 1), s, ...steps.slice(si + 1)]));
		selectedId = s.id;
	}
	/** Fold the next step into this one: servos in both end at the later target. */
	function mergeNext(si: number) {
		const a = steps[si];
		const b = steps[si + 1];
		if (!b) return;
		edit(() => {
			const moves = new Map<number, CleanMove>(a.moves.map((m) => [m.servoId, { ...m }]));
			for (const m of b.moves) {
				const prev = moves.get(m.servoId);
				moves.set(m.servoId, {
					servoId: m.servoId,
					to: m.to,
					raw: prev?.raw && m.raw ? { from: prev.raw.from, to: m.raw.to } : (m.raw ?? prev?.raw ?? null)
				});
			}
			const raw =
				a.raw && b.raw
					? { tStart: Math.min(a.raw.tStart, b.raw.tStart), tEnd: Math.max(a.raw.tEnd, b.raw.tEnd) }
					: (a.raw ?? b.raw);
			const merged: CleanStep = {
				...a,
				label: a.label || b.label,
				durationS: roundTenth(a.durationS + b.durationS),
				pauseAfterS: b.pauseAfterS,
				raw,
				moves: [...moves.values()].sort((x, y) => x.servoId - y.servoId)
			};
			steps = [...steps.slice(0, si), merged, ...steps.slice(si + 2)];
		});
	}
	/** Pull one servo's move out of a step into its own step right after it. */
	function splitOut(si: number, sid: number) {
		const s = steps[si];
		const m = s.moves.find((x) => x.servoId === sid);
		if (!m || s.moves.length < 2) return;
		const own: CleanStep = { id: newStepId(), label: '', durationS: s.durationS, pauseAfterS: 0, raw: s.raw, moves: [{ ...m }] };
		edit(() => {
			steps[si].moves = s.moves.filter((x) => x.servoId !== sid);
			steps = [...steps.slice(0, si + 1), own, ...steps.slice(si + 1)];
		});
	}
	async function targetsFromArm(si: number) {
		const p = await readArm();
		if (!p) return;
		edit(() => {
			for (const m of steps[si].moves) if (Number.isFinite(p[String(m.servoId)])) m.to = p[String(m.servoId)];
		});
		notice = { kind: 'ok', text: `Step ${si + 1}: targets set from the arm.` };
	}
	function oneFromArm(si: number, sid: number) {
		const v = arm?.positions[String(sid)];
		if (v !== undefined) setTo(si, sid, v);
	}
	async function startFromArm() {
		const p = await readArm();
		if (!p) return;
		edit(() => {
			for (const sid of SERVO_IDS) if (Number.isFinite(p[String(sid)])) start[String(sid)] = p[String(sid)];
		});
		notice = { kind: 'ok', text: 'Start pose set from the arm.' };
	}
	function setStart(sid: number, v: number) {
		edit(() => (start[String(sid)] = clampPos(v)));
	}
	function stepEndPose(si: number): Record<string, number> {
		return Object.fromEntries(SERVO_IDS.map((sid) => [String(sid), resolved.steps[si].after[String(sid)]]).filter(([, v]) => Number.isFinite(v)));
	}
	function stepStartPose(si: number): Record<string, number> {
		return Object.fromEntries(SERVO_IDS.map((sid) => [String(sid), resolved.steps[si].before[String(sid)]]).filter(([, v]) => Number.isFinite(v)));
	}

	// --- leave guard -----------------------------------------------------------
	beforeNavigate(({ cancel, type }) => {
		if (dirty && type !== 'leave' && !confirm('You have unsaved changes to this clean-up. Leave anyway?')) cancel();
	});
	$effect(() => {
		const h = (e: BeforeUnloadEvent) => {
			if (dirty) e.preventDefault();
		};
		window.addEventListener('beforeunload', h);
		return () => window.removeEventListener('beforeunload', h);
	});

	function fmtS(s: number) {
		return s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${s.toFixed(1)} s`;
	}
	const inputCls =
		'rounded border border-[var(--color-tron-border)] bg-black/40 px-1.5 py-0.5 font-mono text-xs focus:border-[var(--color-tron-cyan)] focus:outline-none';
	const btnCls =
		'rounded border border-[var(--color-tron-border)] px-2 py-0.5 text-[11px] transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)] disabled:cursor-not-allowed disabled:opacity-40';
</script>

<div class="space-y-4">
	<!-- Header: what this is, save state -->
	<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
		<div class="flex flex-wrap items-start justify-between gap-3">
			<div class="min-w-0 flex-1">
				<a href={`${BASE}/cleanup`} class="text-xs hover:underline" style="color: var(--color-tron-text-secondary)">← all clean-ups</a>
				<input
					value={title}
					onchange={(e) => edit(() => (title = (e.currentTarget as HTMLInputElement).value.slice(0, 120)))}
					placeholder="Name this clean-up"
					class="mt-1 block w-full border-b border-transparent bg-transparent text-lg font-semibold hover:border-[var(--color-tron-border)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
					style="color: var(--color-tron-text)"
				/>
				<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
					From <span class="font-mono">{data.cleanup.sourceName}</span>{#if data.cleanup.overlay}
						with the positions of <span class="font-mono">{data.cleanup.overlay.preciseName}</span> laid over it{/if}
					({data.cleanup.trace.frames} frames,
					{fmtS(data.cleanup.trace.durationS)}) · split at {data.cleanup.thresholdSteps} steps / {data.cleanup.pauseS} s ·
					<strong style="color: var(--color-tron-text)">{steps.length} steps, {moveCount} moves</strong>, plays in
					<strong style="color: var(--color-tron-text)">{fmtS(resolved.durationS)}</strong>
				</p>
				{#if data.cleanup.overlay}
					<p class="mt-1 text-[11px]" style="color: var(--color-tron-text-secondary)">
						Overlay lined up by {data.cleanup.overlay.align === 'stretch' ? 'stretch to fit' : 'follow the motion'}, at {Math.round(data.cleanup.overlay.strength * 100)}% strength, {data.cleanup.overlay.windowS} s window, cap
						{data.cleanup.overlay.maxOffset} steps, servos {data.cleanup.overlay.servos.join(', ')}; the pilot's path sat
						{Math.round(data.cleanup.overlay.fit)} steps from the animation on average. The grey trace below is the overlaid
						recording, not either source.
					</p>
				{/if}
			</div>
			<div class="flex items-center gap-2">
				<button type="button" class={btnCls} onclick={undo} disabled={!undoStack.length} title="Undo">↶ Undo</button>
				<button type="button" class={btnCls} onclick={redo} disabled={!redoStack.length} title="Redo">↷ Redo</button>
				<button
					type="button"
					onclick={save}
					disabled={!dirty || busy !== null}
					class="rounded border border-[var(--color-tron-cyan)]/60 bg-[var(--color-tron-cyan)]/15 px-4 py-1.5 text-sm font-medium transition-colors hover:bg-[var(--color-tron-cyan)]/25 disabled:cursor-not-allowed disabled:opacity-40"
					style="color: var(--color-tron-cyan)"
				>
					{busy === 'save' ? 'Saving…' : dirty ? 'Save' : 'Saved'}
				</button>
			</div>
		</div>

		{#if notice}
			<div
				class="mt-3 rounded border p-2 text-xs {notice.kind === 'error'
					? 'border-red-500/40 bg-red-900/10 text-red-300'
					: notice.kind === 'info'
						? 'border-amber-500/40 bg-amber-900/10 text-amber-200'
						: 'border-green-500/40 bg-green-900/10 text-green-300'}"
			>
				{notice.text}
				{#if notice.kind === 'ok' && notice.text.includes('Control tab')}
					<a href={`${BASE}/control`} class="ml-1 underline">Go to Control →</a>
				{/if}
			</div>
		{/if}
	</section>

	<!-- Timeline -->
	<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
		<CleanupTimeline
			t={data.cleanup.trace.t}
			goal={data.cleanup.trace.goal}
			jointNames={names}
			steps={resolved.steps}
			playbackS={resolved.durationS}
			{selectedId}
			onselect={select}
		/>
	</section>

	<!-- Start pose -->
	<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
		<div class="mb-2 flex flex-wrap items-center justify-between gap-2">
			<div>
				<h2 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Start pose</h2>
				<p class="text-[11px]" style="color: var(--color-tron-text-secondary)">Replay ramps the follower here before step 1.</p>
			</div>
			<div class="flex flex-wrap gap-2">
				<button type="button" class={btnCls} disabled={!armReachable || busy !== null} onclick={startFromArm}>
					{busy === 'read' ? 'Reading…' : 'Set from arm'}
				</button>
				<button type="button" class={btnCls} disabled={!armReachable || busy !== null} onclick={() => moveArmTo('the start pose', { ...start })}>
					Send arm here
				</button>
			</div>
		</div>
		<div class="grid grid-cols-3 gap-2 sm:grid-cols-6">
			{#each SERVO_IDS as sid (sid)}
				<label class="block text-[11px]" style="color: var(--color-tron-text-secondary)">
					<span class="font-mono text-cyan-400">{sid}</span> {names[sid - 1]}
					<input
						type="number"
						min="0"
						max="4095"
						value={start[String(sid)]}
						onchange={(e) => {
							const v = num(e);
							if (v !== null) setStart(sid, v);
						}}
						class="{inputCls} mt-0.5 w-full"
						style="color: var(--color-tron-text)"
					/>
					{#if arm?.positions[String(sid)] !== undefined}
						<span class="font-mono text-[10px] opacity-70">arm {arm.positions[String(sid)]}</span>
					{/if}
				</label>
			{/each}
		</div>
	</section>

	<!-- Steps -->
	<section class="space-y-2">
		<div class="flex flex-wrap items-center justify-between gap-2">
			<h2 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Steps</h2>
			<div class="flex items-center gap-2 text-[11px]" style="color: var(--color-tron-text-secondary)">
				{#if arm}
					arm read {arm.at.toLocaleTimeString()}
				{/if}
				<button type="button" class={btnCls} disabled={!armReachable || busy !== null} onclick={readArm}>
					{busy === 'read' ? 'Reading…' : 'Read arm'}
				</button>
				<button type="button" class={btnCls} onclick={() => insertAfter(-1)}>+ step at start</button>
			</div>
		</div>

		{#if steps.length === 0}
			<p class="rounded border border-dashed border-[var(--color-tron-border)] p-6 text-center text-xs" style="color: var(--color-tron-text-secondary)">
				No steps. Add one, or re-split the recording with a lower threshold.
			</p>
		{/if}

		{#each resolved.steps as rs, si (rs.step.id)}
			{@const s = rs.step}
			{@const sel = s.id === selectedId}
			{@const missing = SERVO_IDS.filter((sid) => !s.moves.some((m) => m.servoId === sid))}
			<div
				id="step-{s.id}"
				class="rounded-lg border bg-[var(--color-tron-surface)] transition-colors {sel
					? 'border-[var(--color-tron-cyan)]'
					: 'border-[var(--color-tron-border)]'}"
			>
				<!-- Step header -->
				<div
					class="flex flex-wrap items-center gap-2 border-b border-[var(--color-tron-border)]/60 px-3 py-2"
					role="button"
					tabindex="0"
					onclick={(e) => {
						if ((e.target as HTMLElement).closest('input,button,select')) return;
						selectedId = s.id;
					}}
					onkeydown={(e) => e.key === 'Enter' && (selectedId = s.id)}
				>
					<span
						class="inline-flex h-6 min-w-6 items-center justify-center rounded px-1.5 font-mono text-xs font-bold {sel
							? 'bg-[var(--color-tron-cyan)] text-black'
							: s.raw
								? 'bg-cyan-500/20 text-cyan-300'
								: 'bg-violet-500/25 text-violet-200'}"
						title={s.raw ? 'From the recording' : 'Added by hand'}>{rs.number}</span
					>
					<input
						value={s.label}
						onchange={(e) => setLabel(si, (e.currentTarget as HTMLInputElement).value)}
						placeholder="label (optional)"
						class="{inputCls} w-40 font-sans"
						style="color: var(--color-tron-text)"
					/>
					<label class="flex items-center gap-1 text-[11px]" style="color: var(--color-tron-text-secondary)">
						takes
						<input
							type="number"
							min="0.1"
							max="120"
							step="0.1"
							value={s.durationS}
							onchange={(e) => {
								const v = num(e);
								if (v !== null) setDuration(si, v);
							}}
							class="{inputCls} w-16"
							style="color: var(--color-tron-text)"
						/> s
					</label>
					<label class="flex items-center gap-1 text-[11px]" style="color: var(--color-tron-text-secondary)">
						then wait
						<input
							type="number"
							min="0"
							max="120"
							step="0.1"
							value={s.pauseAfterS}
							onchange={(e) => {
								const v = num(e);
								if (v !== null) setPause(si, v);
							}}
							class="{inputCls} w-16"
							style="color: var(--color-tron-text)"
						/> s
					</label>
					{#if s.raw}
						<span class="text-[10px] opacity-60" style="color: var(--color-tron-text-secondary)">
							recorded {fmtS(s.raw.tEnd - s.raw.tStart)} at {s.raw.tStart.toFixed(1)} s
						</span>
					{/if}
					<span class="ml-auto text-[10px] font-mono opacity-60" style="color: var(--color-tron-text-secondary)">
						plays at {rs.tStart.toFixed(1)} s
					</span>
					<div class="flex items-center gap-1">
						<button type="button" class={btnCls} disabled={si === 0} onclick={() => moveStep(si, -1)} title="Move step up">↑</button>
						<button type="button" class={btnCls} disabled={si === steps.length - 1} onclick={() => moveStep(si, 1)} title="Move step down">↓</button>
						<button type="button" class={btnCls} disabled={si === steps.length - 1} onclick={() => mergeNext(si)} title="Fold the next step into this one">merge ↓</button>
						<button type="button" class={btnCls} onclick={() => insertAfter(si)} title="Insert an empty step after this one">+ after</button>
						<button
							type="button"
							class="{btnCls} hover:!border-red-500 hover:!text-red-400"
							onclick={() => deleteStep(si)}
							title="Delete step">✕</button
						>
					</div>
				</div>

				<!-- Moves -->
				{#if rs.moves.length}
					<table class="w-full text-xs">
						<thead class="text-left text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
							<tr>
								<th class="px-3 py-1 font-medium">Servo</th>
								<th class="px-2 py-1 font-medium">From</th>
								<th class="px-2 py-1 font-medium">To</th>
								<th class="px-2 py-1 font-medium">Moves by</th>
								<th class="px-2 py-1 font-medium">Recorded</th>
								<th class="px-3 py-1"><span class="sr-only">Actions</span></th>
							</tr>
						</thead>
						<tbody style="color: var(--color-tron-text)">
							{#each rs.moves as m (m.servoId)}
								{@const armV = arm?.positions[String(m.servoId)]}
								<tr class="border-t border-[var(--color-tron-border)]/30">
									<td class="px-3 py-1">
										<span class="font-mono text-cyan-400">{m.servoId}</span>
										{names[m.servoId - 1]}
									</td>
									<td class="px-2 py-1 font-mono" style="color: var(--color-tron-text-secondary)">{m.from}</td>
									<td class="px-2 py-1">
										<input
											type="number"
											min="0"
											max="4095"
											value={m.to}
											onchange={(e) => {
												const v = num(e);
												if (v !== null) setTo(si, m.servoId, v);
											}}
											class="{inputCls} w-20"
											style="color: var(--color-tron-text)"
										/>
									</td>
									<td class="px-2 py-1">
										<input
											type="number"
											value={m.delta}
											onchange={(e) => {
												const v = num(e);
												if (v !== null) setTo(si, m.servoId, m.from + v);
											}}
											class="{inputCls} w-20 {m.delta === 0 ? 'opacity-50' : ''}"
											style="color: var(--color-tron-text)"
										/>
										<span class="ml-1 text-[10px] opacity-60">{(m.delta / STEPS_PER_DEGREE).toFixed(1)}°</span>
										{#if Math.abs(m.delta) < SMALL_MOVE}
											<span class="ml-1 rounded bg-white/10 px-1 text-[9px] uppercase opacity-70" title="Under {SMALL_MOVE} steps. Possibly jitter; your call.">small</span>
										{/if}
									</td>
									<td class="px-2 py-1 font-mono text-[11px]" style="color: var(--color-tron-text-secondary)">
										{#if m.raw}
											{m.raw.from} → {m.raw.to}
											<span class="opacity-60">({m.raw.to - m.raw.from > 0 ? '+' : ''}{m.raw.to - m.raw.from})</span>
										{:else}
											<span class="italic opacity-60">added</span>
										{/if}
									</td>
									<td class="whitespace-nowrap px-3 py-1 text-right">
										{#if armV !== undefined}
											<button type="button" class={btnCls} onclick={() => oneFromArm(si, m.servoId)} title="Use the arm's last-read position ({armV}) as this target">
												arm {armV}
											</button>
										{/if}
										{#if rs.moves.length > 1}
											<button type="button" class={btnCls} onclick={() => splitOut(si, m.servoId)} title="Move this servo into its own step after this one">own step</button>
										{/if}
										<button
											type="button"
											class="{btnCls} hover:!border-red-500 hover:!text-red-400"
											onclick={() => deleteMove(si, m.servoId)}
											title="Remove this servo from the step (it holds still)">✕</button
										>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{:else}
					<p class="px-3 py-2 text-[11px] italic" style="color: var(--color-tron-text-secondary)">
						No servo moves in this step: it only waits {s.durationS + s.pauseAfterS} s.
					</p>
				{/if}

				<!-- Step footer -->
				<div class="flex flex-wrap items-center gap-2 border-t border-[var(--color-tron-border)]/40 px-3 py-1.5">
					{#if missing.length}
						<select
							class="{inputCls} font-sans"
							style="color: var(--color-tron-text-secondary)"
							value=""
							onchange={(e) => {
								const v = Number((e.currentTarget as HTMLSelectElement).value);
								(e.currentTarget as HTMLSelectElement).value = '';
								if (v) addMove(si, v);
							}}
						>
							<option value="">+ servo…</option>
							{#each missing as sid (sid)}
								<option value={sid}>{sid} {names[sid - 1]}</option>
							{/each}
						</select>
					{/if}
					<div class="ml-auto flex flex-wrap gap-1">
						<button type="button" class={btnCls} disabled={!armReachable || busy !== null || !rs.moves.length} onclick={() => targetsFromArm(si)} title="Read the follower and use its position as every target in this step">
							targets from arm
						</button>
						<button type="button" class={btnCls} disabled={!armReachable || busy !== null} onclick={() => moveArmTo(`the start of step ${rs.number}`, stepStartPose(si))}>
							arm → start of step
						</button>
						<button type="button" class={btnCls} disabled={!armReachable || busy !== null} onclick={() => moveArmTo(`the end of step ${rs.number}`, stepEndPose(si))}>
							arm → end of step
						</button>
					</div>
				</div>
			</div>
		{/each}

		{#if steps.length}
			<button type="button" class="{btnCls} w-full py-1.5" onclick={() => insertAfter(steps.length - 1)}>+ step at end</button>
		{/if}
	</section>

	<!-- Save to Pi + send to Animate + re-split -->
	<section class="grid gap-4 lg:grid-cols-3">
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
			<h2 class="mb-1 text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Save to Pi</h2>
			<p class="mb-3 text-[11px]" style="color: var(--color-tron-text-secondary)">
				Writes a new recording on the Pi: each step moves its servos together in a straight line over its
				time, then waits. Replay it from the Control tab like any recording. The original stays as it is.
			</p>
			<div class="flex gap-2">
				<input bind:value={piName} class="{inputCls} min-w-0 flex-1 py-1 font-sans text-sm" style="color: var(--color-tron-text)" />
				<button
					type="button"
					onclick={saveToPi}
					disabled={!armReachable || busy !== null || !steps.length || !piName.trim()}
					class="rounded border border-emerald-500/50 bg-emerald-900/10 px-3 py-1 text-sm font-medium text-emerald-300 transition-colors hover:bg-emerald-900/25 disabled:cursor-not-allowed disabled:opacity-40"
				>
					{busy === 'pi' ? 'Saving…' : 'Save to Pi'}
				</button>
			</div>
			{#if data.cleanup.savedAs.length}
				<ul class="mt-3 space-y-0.5 text-[11px]" style="color: var(--color-tron-text-secondary)">
					{#each [...data.cleanup.savedAs].reverse() as s (s.name + s.at)}
						<li>
							<span class="font-mono" style="color: var(--color-tron-text)">{s.name}</span>
							· {new Date(s.at).toLocaleString()}{#if s.by} · {s.by.username}{/if}{#if s.durationS} · {s.durationS.toFixed(1)} s{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>

		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
			<h2 class="mb-1 text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Send to Animate</h2>
			<p class="mb-3 text-[11px]" style="color: var(--color-tron-text-secondary)">
				Makes a move set in the Animate tab from these steps: the start and the end of each step become saved
				poses; a step's time becomes the move into its pose and its wait becomes the hold. Playback there eases
				into every pose instead of moving in straight lines, and each pose, time and easing can still be changed.
				This clean-up is not altered.
			</p>
			<div class="flex flex-wrap gap-2">
				<input
					bind:value={animateName}
					placeholder="Move set name"
					maxlength="80"
					class="{inputCls} min-w-0 flex-1 py-1 font-sans text-sm"
					style="color: var(--color-tron-text)"
				/>
				<select bind:value={animateEasing} class="{inputCls} py-1 font-sans text-sm" style="color: var(--color-tron-text)" title="How every move arrives at its pose; change per pose in the Animate tab">
					{#each EASINGS as e (e.id)}
						<option value={e.id} title={e.hint}>{e.label}</option>
					{/each}
				</select>
				<button
					type="button"
					onclick={sendToAnimate}
					disabled={busy !== null || !steps.length || !animateName.trim() || !!animatePreview.error}
					class="rounded border border-[var(--color-tron-cyan)]/50 bg-cyan-900/10 px-3 py-1 text-sm font-medium text-[var(--color-tron-cyan)] transition-colors hover:bg-cyan-900/25 disabled:cursor-not-allowed disabled:opacity-40"
				>
					{busy === 'animate' ? 'Making…' : 'Send to Animate'}
				</button>
			</div>
			{#if animatePreview.error}
				<p class="mt-2 text-[11px] text-amber-300">{animatePreview.error}</p>
			{:else if animatePreview.draft}
				<p class="mt-2 text-[11px]" style="color: var(--color-tron-text-secondary)">
					{animatePreview.draft.poses.length} poses · about {fmtS(animateDurationS)} before easing.
					{#if animatePreview.draft.lengthened.length}
						{listSteps(animatePreview.draft.lengthened)} will be slowed to the arm's speed limit.
					{/if}
					{#if animatePreview.draft.folded.length}
						{listSteps(animatePreview.draft.folded)} move nothing and become hold time.
					{/if}
				</p>
			{/if}
			{#if data.cleanup.moveSets?.length}
				<ul class="mt-3 space-y-0.5 text-[11px]" style="color: var(--color-tron-text-secondary)">
					{#each [...data.cleanup.moveSets].reverse() as m (m.moveSetId)}
						<li>
							<a href="{BASE}/animate/moveset/{m.moveSetId}" class="underline decoration-dotted hover:text-[var(--color-tron-cyan)]" style="color: var(--color-tron-text)">{m.name}</a>
							· {new Date(m.at).toLocaleString()}{#if m.by} · {m.by.username}{/if}{#if m.poses} · {m.poses} poses{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>

		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
			<h2 class="mb-1 text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Split again</h2>
			<p class="mb-3 text-[11px]" style="color: var(--color-tron-text-secondary)">
				Starts over from the recording with other settings. Replaces every step and edit.
			</p>
			<div class="flex flex-wrap items-end gap-2">
				<label class="text-[11px]" style="color: var(--color-tron-text-secondary)">
					Threshold (steps)
					<input type="number" min="0" max="500" bind:value={splitThreshold} class="{inputCls} mt-0.5 block w-24 py-1" style="color: var(--color-tron-text)" />
				</label>
				<label class="text-[11px]" style="color: var(--color-tron-text-secondary)">
					Pause ends a move (s)
					<input type="number" min="0.05" max="5" step="0.05" bind:value={splitPause} class="{inputCls} mt-0.5 block w-24 py-1" style="color: var(--color-tron-text)" />
				</label>
				<button type="button" class={btnCls} disabled={busy !== null} onclick={resplit}>
					{busy === 'resplit' ? 'Splitting…' : 'Split again'}
				</button>
			</div>
		</div>
	</section>
</div>
