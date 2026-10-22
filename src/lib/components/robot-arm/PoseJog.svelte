<script lang="ts">
	/**
	 * ARM-06 §10 — adjust a pose by jogging the real arm.
	 *
	 * One row per servo: the pose's value, where the arm is now (live), the
	 * difference, and −/+ buttons that move that joint by the chosen step.
	 * Every press POSTs /api/robot-arm/animate/jog and the row updates from
	 * the encoders the Pi read back, so the operator sees the change on the
	 * arm and in the numbers at once — no recording to save and play.
	 * Presses queue per servo (rapid clicks add up, one request in flight).
	 * When satisfied: "Save into pose" overwrites the pose from the encoders;
	 * "Save as new pose" keeps the original. With no target pose the panel
	 * is a free jog that ends in a new pose.
	 */
	import { enhance } from '$app/forms';
	import { onDestroy } from 'svelte';
	import { ENCODER_MAX, MAX_JOG_STEPS, SERVO_COUNT } from '$lib/robot-arm/animation';
	import { DEFAULT_JOINT_NAMES } from '$lib/robot-arm/recording-cleanup';
	import type { ArmNow, PoseSummary } from '$lib/server/robot-arm-animation';

	interface Props {
		/** The pose being adjusted, or null for a free jog. */
		pose: PoseSummary | null;
		/** The page's last read of the arm, so the panel has numbers before its first poll. */
		initial: ArmNow | null;
		armReachable: boolean;
		/** Page-level reason nothing may move (session running, unreachable, torque off). */
		blocked: boolean;
		blockReason: string;
		onclose: () => void;
	}

	let { pose, initial, armReachable, blocked, blockReason, onclose }: Props = $props();

	const STEPS = [1, 5, 10, 25, 50, 100];
	let step = $state(10);
	// Filled from `initial` by the sync effect below, then by jogs and the poll.
	let live = $state<number[] | null>(null);
	let torqueOn = $state<boolean | null>(null);
	let activeKind = $state<string | null>(null);
	let note = $state<string | null>(null);
	let noteKind = $state<'ok' | 'warn' | 'error'>('ok');
	let polling = $state(true);
	let inFlight = $state(0);
	let lastJogAt = $state(0);
	const pending: number[] = new Array(SERVO_COUNT).fill(0);
	let flushing = false;

	const canJog = $derived(armReachable && !blocked && !activeKind && torqueOn !== false);
	const why = $derived(
		!armReachable || blocked
			? blockReason
			: activeKind
				? `A ${activeKind} session is using the arm — stop it first.`
				: torqueOn === false
					? 'Torque is off — press Hold (torque on) first; the arm has to hold itself to be jogged.'
					: ''
	);
	const deltas = $derived(pose && live ? live.map((v, i) => v - pose.positions[i]) : null);
	const moved = $derived(!!deltas?.some((d) => d !== 0));
	const degPerStep = 360 / (ENCODER_MAX + 1);
	const SERVOS = Array.from({ length: SERVO_COUNT }, (_, i) => i);

	// Keep the panel's numbers in step with the page's reads (after Go to / Save the load re-runs).
	$effect(() => {
		if (initial && Date.now() - lastJogAt > 1500) {
			live = initial.positions;
			torqueOn = initial.torqueOn;
		}
	});

	async function refresh() {
		if (!armReachable || inFlight) return;
		try {
			const res = await fetch('/api/robot-arm/animate/jog', { cache: 'no-store' });
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body?.error ?? `${res.status}`);
			activeKind = body.active?.kind ?? null;
			if (Array.isArray(body.positions)) {
				live = body.positions;
				torqueOn = typeof body.torqueOn === 'boolean' ? body.torqueOn : null;
			}
		} catch (e) {
			note = `Could not read the arm: ${e instanceof Error ? e.message : String(e)}`;
			noteKind = 'warn';
		}
	}

	let timer: ReturnType<typeof setInterval> | null = null;
	$effect(() => {
		if (timer) clearInterval(timer);
		timer = null;
		if (polling && armReachable) {
			void refresh();
			timer = setInterval(() => void refresh(), 2000);
		}
		return () => {
			if (timer) clearInterval(timer);
			timer = null;
		};
	});
	onDestroy(() => {
		if (timer) clearInterval(timer);
	});

	/** Queue a nudge; rapid presses on one servo add up into one request. */
	function jog(sid: number, delta: number) {
		if (!canJog) return;
		pending[sid - 1] = Math.max(-MAX_JOG_STEPS, Math.min(MAX_JOG_STEPS, pending[sid - 1] + delta));
		if (live) live = live.map((v, i) => (i === sid - 1 ? Math.max(0, Math.min(ENCODER_MAX, v + delta)) : v));
		void flush();
	}

	async function flush() {
		if (flushing) return;
		flushing = true;
		try {
			for (;;) {
				const idx = pending.findIndex((d) => d !== 0);
				if (idx < 0) break;
				const delta = pending[idx];
				pending[idx] = 0;
				inFlight++;
				try {
					const res = await fetch('/api/robot-arm/animate/jog', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ sid: idx + 1, delta })
					});
					const body = await res.json().catch(() => ({}));
					if (!res.ok) {
						note = body?.error ?? `Jog failed (${res.status}).`;
						noteKind = 'error';
						if (res.status === 409 && /torque/i.test(note ?? '')) torqueOn = false;
						pending.fill(0);
						inFlight--;
						await refresh();
						break;
					}
					lastJogAt = Date.now();
					if (Array.isArray(body.positions)) live = body.positions;
					if (typeof body.torqueOn === 'boolean') torqueOn = body.torqueOn;
					note = `J${idx + 1} ${delta > 0 ? '+' : ''}${delta} → goal ${body.goal}`;
					noteKind = 'ok';
					inFlight--;
				} catch (e) {
					inFlight--;
					throw e;
				}
			}
		} catch (e) {
			note = `Jog failed: ${e instanceof Error ? e.message : String(e)}`;
			noteKind = 'error';
			pending.fill(0);
		} finally {
			flushing = false;
		}
	}

	/** After a page action that moved or saved the arm, take the page's fresh read. */
	const thenRefresh = () => async ({ update }: { update: () => Promise<void> }) => {
		await update();
		lastJogAt = 0;
		await refresh();
	};

	const fmt = (d: number) => (d > 0 ? `+${d}` : `${d}`);
	const input = 'rounded border bg-black/40 px-2 py-1 text-sm';
	const inputStyle = 'border-color: var(--color-tron-border); color: var(--color-tron-text)';
	const btn = 'min-h-[40px] rounded px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40';
	const jogBtn = 'min-h-[36px] min-w-[44px] rounded border px-2 font-mono text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-30';
	const jogStyle = 'border-color: rgba(56,189,248,0.5); background: rgba(56,189,248,0.10); color: var(--color-tron-cyan);';
	const cyan = 'background: rgba(56,189,248,0.15); color: var(--color-tron-cyan); border: 1px solid var(--color-tron-cyan);';
	const green = 'background: rgba(74,222,128,0.12); color: #4ade80; border: 1px solid #4ade80;';
	const amber = 'background: rgba(245,158,11,0.15); color: #fbbf24; border: 1px solid #f59e0b;';
</script>

<section class="rounded border p-3 sm:p-4" style="border-color: {canJog ? 'var(--color-tron-cyan)' : 'var(--color-tron-border)'}; background: var(--color-tron-surface);">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<h2 class="text-sm font-semibold tracking-wide" style="color: var(--color-tron-text)">JOG {pose ? `· ${pose.name}` : '· free'}</h2>
			<p class="max-w-2xl text-xs" style="color: var(--color-tron-text-secondary)">
				{#if pose}
					<b>Go to pose</b> first, then nudge each joint with − / + and watch the arm; the row shows the pose, where the arm is, and the
					difference. <b>Save into pose</b> writes the new position to "{pose.name}" (every move set using it follows; its droop trim is cleared).
					<b>Save as new pose</b> keeps the original.
				{:else}
					Nudge each joint with − / + and watch the arm; name the result and save it as a new pose.
				{/if}
			</p>
		</div>
		<div class="flex items-center gap-3 text-xs" style="color: var(--color-tron-text-secondary)">
			<label class="flex items-center gap-1"><input type="checkbox" bind:checked={polling} class="accent-cyan-400" /> live (2 s)</label>
			<span>Torque <span class="font-semibold" style="color: {torqueOn === false ? '#f59e0b' : torqueOn ? '#4ade80' : 'var(--color-tron-text-secondary)'}">{torqueOn === false ? 'OFF' : torqueOn ? 'ON' : '?'}</span></span>
			<button type="button" class="underline" onclick={onclose}>close</button>
		</div>
	</div>

	<div class="mt-3 flex flex-wrap items-center gap-2 text-xs" style="color: var(--color-tron-text-secondary)">
		<span>Step</span>
		{#each STEPS as s (s)}
			<button type="button" onclick={() => (step = s)} class="min-h-[30px] rounded border px-2 font-mono" style="border-color: {step === s ? 'var(--color-tron-cyan)' : 'var(--color-tron-border)'}; color: {step === s ? 'var(--color-tron-cyan)' : 'var(--color-tron-text-secondary)'}; background: {step === s ? 'rgba(56,189,248,0.12)' : 'transparent'}">{s}</button>
		{/each}
		<input
			type="number"
			min="1"
			max={MAX_JOG_STEPS}
			value={step}
			onchange={(e) => {
				const v = Math.round(Number(e.currentTarget.value));
				step = Number.isFinite(v) ? Math.max(1, Math.min(MAX_JOG_STEPS, v)) : step;
			}}
			class="{input} w-20 font-mono"
			style={inputStyle}
			aria-label="Step in encoder steps"
		/>
		<span>steps ≈ {(step * degPerStep).toFixed(2)}° at the joint</span>
	</div>

	<div class="mt-3 overflow-x-auto">
		<table class="w-full text-xs">
			<thead>
				<tr class="text-left" style="color: var(--color-tron-text-secondary)">
					<th class="py-1 pr-2 font-medium">Servo</th>
					{#if pose}<th class="py-1 pr-2 font-medium">Pose</th>{/if}
					<th class="py-1 pr-2 font-medium" title="From the encoders">Arm now</th>
					{#if pose}<th class="py-1 pr-2 font-medium" title="Arm now − pose">Δ</th>{/if}
					<th class="py-1 font-medium">Jog</th>
				</tr>
			</thead>
			<tbody>
				{#each SERVOS as s (s)}
					{@const d = deltas?.[s] ?? 0}
					<tr class="border-t" style="border-color: var(--color-tron-border)">
						<td class="py-1 pr-2 whitespace-nowrap" style="color: var(--color-tron-text-secondary)">{s + 1} {DEFAULT_JOINT_NAMES[s] ?? ''}</td>
						{#if pose}<td class="py-1 pr-2 font-mono" style="color: var(--color-tron-text)">{pose.positions[s]}</td>{/if}
						<td class="py-1 pr-2 font-mono text-sm" style="color: var(--color-tron-text)">{live ? live[s] : '—'}</td>
						{#if pose}<td class="py-1 pr-2 font-mono" style="color: {d ? '#fbbf24' : 'var(--color-tron-text-secondary)'}">{live ? fmt(d) : '—'}</td>{/if}
						<td class="py-1">
							<div class="flex items-center gap-1">
								<button type="button" class={jogBtn} style={jogStyle} disabled={!canJog} onclick={() => jog(s + 1, -step)} aria-label="Servo {s + 1} minus {step}">−{step}</button>
								<button type="button" class={jogBtn} style={jogStyle} disabled={!canJog} onclick={() => jog(s + 1, step)} aria-label="Servo {s + 1} plus {step}">+{step}</button>
							</div>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	{#if !canJog && why}
		<p class="mt-2 text-xs" style="color: #f59e0b">{why}</p>
	{:else if note}
		<p class="mt-2 text-xs" style="color: {noteKind === 'error' ? '#fca5a5' : noteKind === 'warn' ? '#fbbf24' : 'var(--color-tron-text-secondary)'}">{note}{inFlight ? ' …' : ''}</p>
	{/if}

	<div class="mt-3 flex flex-wrap items-end gap-3">
		{#if pose}
			{@const name = pose.name}
			<form method="POST" action="?/goToPose" use:enhance={thenRefresh} onsubmit={(e) => { if (!confirm(`The arm will MOVE to "${name}". Is the path clear?`)) e.preventDefault(); }}>
				<input type="hidden" name="id" value={pose._id} />
				<button type="submit" class={btn} style={amber} disabled={!canJog}>Go to pose</button>
			</form>
			<form method="POST" action="?/savePoseFromJog" use:enhance={thenRefresh} onsubmit={(e) => { if (!confirm(`Overwrite "${name}" with where the arm is now? Every move set that uses it will follow, and its droop trim (if measured) is cleared.`)) e.preventDefault(); }}>
				<input type="hidden" name="id" value={pose._id} />
				<button type="submit" class={btn} style={green} disabled={!armReachable || !!activeKind || !moved} title={moved ? '' : 'Nothing has moved yet'}>Save into pose</button>
			</form>
		{/if}
		<form method="POST" action="?/savePose" use:enhance={thenRefresh} class="flex flex-wrap items-end gap-2">
			<input type="hidden" name="hold" value="0" />
			<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
				{pose ? 'Or save as a new pose' : 'Pose name'}
				<input name="name" required maxlength="80" placeholder={pose ? `e.g. ${pose.name} (adjusted)` : 'e.g. Over tray'} class="{input} mt-1 w-48" style={inputStyle} />
			</label>
			<button type="submit" class={btn} style={cyan} disabled={!armReachable || !!activeKind}>Save as new pose</button>
		</form>
	</div>
</section>
