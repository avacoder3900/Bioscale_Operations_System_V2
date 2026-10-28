<script lang="ts">
	/**
	 * Follower torque on/off, shown at the top of the ARM CONNECTION panel on
	 * every Robot Arm tab (the panel lives in the arm +layout, so this follows
	 * the operator across tabs, and stays visible when the panel is hidden).
	 * Reads the state on mount, after every change, and when the arm bus
	 * frees up after a play or session (ARM_BUS_FREE_EVENT): a Go to pose
	 * leaves torque on, and a value read before it would be stale.
	 *
	 * Automatic check (2026-10-28): the servo poll every 10 s (PiThermalChip)
	 * already reads each servo's torque flag and hands it over here
	 * (ARM_SERVOS_EVENT), so the label stays current with no extra bus read.
	 * Torque going OFF without Off being pressed here (power drop, servo
	 * fault, a session that left the arm limp) turns the row amber.
	 */
	import { ARM_BUS_FREE_EVENT, ARM_SERVOS_EVENT, type ArmServosDetail } from '$lib/robot-arm/bus-free';

	interface Props {
		armReachable: boolean;
	}

	let { armReachable }: Props = $props();

	let torqueOn = $state<boolean | null>(null);
	let known = $state(false);
	let busy = $state(false);
	let note = $state<string | null>(null);
	let noteKind = $state<'ok' | 'warn' | 'error'>('ok');
	/** Torque went off with nobody pressing Off here: the arm may be limp. */
	let wentOff = $state(false);
	/** Set by Off: the next OFF reading is expected, not an alarm. */
	let offExpected = false;

	// All on → true, all off → false, mixed or unreported → null.
	function summarise(servos: { torque: boolean | null }[]): boolean | null {
		const t = servos.map((s) => s.torque).filter((v): v is boolean => v !== null);
		return !t.length ? null : t.every(Boolean) ? true : t.every((v) => !v) ? false : null;
	}

	function apply(next: boolean | null) {
		if (next === false && torqueOn === true && !offExpected) wentOff = true;
		if (next === true) {
			wentOff = false;
			offExpected = false;
		}
		torqueOn = next;
		known = true;
	}

	async function refresh() {
		if (!armReachable) return;
		try {
			const res = await fetch('/api/robot-arm/torque', { cache: 'no-store' });
			if (!res.ok) throw new Error(`${res.status}`);
			const body = await res.json();
			apply(typeof body.torqueOn === 'boolean' ? body.torqueOn : null);
		} catch {
			known = false;
		}
	}

	$effect(() => {
		void armReachable;
		void refresh();
	});

	$effect(() => {
		const onBusFree = () => void refresh();
		window.addEventListener(ARM_BUS_FREE_EVENT, onBusFree);
		return () => window.removeEventListener(ARM_BUS_FREE_EVENT, onBusFree);
	});

	// The automatic check: every servo poll's torque flags (null = the servos did not answer).
	$effect(() => {
		const onServos = (e: Event) => {
			if (busy) return;
			const d = (e as CustomEvent<ArmServosDetail>).detail;
			if (d?.servos?.length) apply(summarise(d.servos));
			else known = false;
		};
		window.addEventListener(ARM_SERVOS_EVENT, onServos);
		return () => window.removeEventListener(ARM_SERVOS_EVENT, onServos);
	});

	async function set(enable: boolean) {
		if (busy) return;
		const ok = enable
			? confirm('Turn torque ON? The arm holds where it is (or, without the Pi hold route, moves to its last commanded position).')
			: confirm('Turn torque OFF? The arm will go LIMP and sag. Are you supporting it?');
		if (!ok) return;
		busy = true;
		note = null;
		try {
			const res = await fetch('/api/robot-arm/torque', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enable }) });
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				note = body?.message ?? `Torque ${enable ? 'on' : 'off'} failed (${res.status}).`;
				noteKind = 'error';
			} else {
				if (!enable) offExpected = true;
				else wentOff = false;
				torqueOn = typeof body.torqueOn === 'boolean' ? body.torqueOn : enable;
				known = true;
				if (body.warning) {
					note = body.warning;
					noteKind = 'warn';
				} else {
					note = enable ? 'Torque on — the arm is holding its position.' : 'Torque off — the arm is limp.';
					noteKind = 'ok';
				}
			}
		} catch (e) {
			note = `Torque ${enable ? 'on' : 'off'} failed: ${e instanceof Error ? e.message : String(e)}`;
			noteKind = 'error';
		} finally {
			busy = false;
		}
	}

	const color = $derived(!known ? 'var(--color-tron-text-secondary)' : torqueOn ? '#4ade80' : torqueOn === false ? '#f59e0b' : 'var(--color-tron-text-secondary)');
	const label = $derived(!known ? '?' : torqueOn ? 'ON' : torqueOn === false ? 'OFF' : 'MIXED');
</script>

<div class="flex flex-wrap items-center gap-2 border-t px-3 py-1.5 text-[11px]" style="border-color: var(--color-tron-border); color: var(--color-tron-text-secondary)">
	<span>Torque <span class="font-semibold" style="color: {color}">{label}</span></span>
	{#if wentOff && torqueOn === false}
		<span class="rounded px-1.5 py-0.5 font-semibold" style="background: rgba(245,158,11,0.18); color: #fbbf24; border: 1px solid #f59e0b" title="The servos report torque off, and Off was not pressed here. Power drop, a servo fault, or a session that ended without turning it back on. Support the arm, then press On.">Torque went off</span>
	{/if}
	<button
		type="button"
		onclick={() => set(true)}
		disabled={!armReachable || busy || torqueOn === true}
		class="rounded px-2 py-0.5 font-semibold disabled:cursor-not-allowed disabled:opacity-40"
		style="background: rgba(74,222,128,0.12); color: #4ade80; border: 1px solid #4ade80;"
		title="Hold the arm where it is"
	>
		On
	</button>
	<button
		type="button"
		onclick={() => set(false)}
		disabled={!armReachable || busy || torqueOn === false}
		class="rounded px-2 py-0.5 font-semibold disabled:cursor-not-allowed disabled:opacity-40"
		style="background: rgba(245,158,11,0.15); color: #fbbf24; border: 1px solid #f59e0b;"
		title="The arm goes limp — support it"
	>
		Off
	</button>
	<button type="button" onclick={refresh} disabled={!armReachable || busy} class="underline disabled:opacity-40" title="Re-read the servos">refresh</button>
	{#if note}
		<span class="basis-full" style="color: {noteKind === 'error' ? '#fca5a5' : noteKind === 'warn' ? '#fbbf24' : '#4ade80'}">{note}</span>
	{/if}
</div>
