<script lang="ts">
	/**
	 * The cartridge trapdoor solenoids, on the Animate pages (2026-10-28).
	 *
	 * Shows each solenoid's pin state, whether the Pi's replay can fire steps
	 * (GET /gpio/status → replay_fire), and Test fire buttons. Test fire posts
	 * the page's `testFire` action (shared by every Animate page), so the arm
	 * never moves. One coil at a time is the Pi's rule: a second fire while
	 * one is on comes back as "already firing", never as both trapdoors open.
	 *
	 * `step` (the editor's selected fire step) shows one button for exactly
	 * that solenoid and pulse; without it, both solenoids with a pulse box.
	 */
	import { deserialize } from '$app/forms';
	import { onMount } from 'svelte';
	import { DEFAULT_PULSE_MS, MAX_PULSE_MS, MIN_PULSE_MS, SOLENOIDS, type FireSpec, type Solenoid, type SolenoidStatus } from '$lib/robot-arm/animation';

	interface Props {
		status: SolenoidStatus | null;
		armReachable: boolean;
		/** The selected fire step: Test fire uses its solenoid and pulse. */
		step?: FireSpec | null;
	}
	let { status: initial, armReachable, step = null }: Props = $props();

	let status = $state<SolenoidStatus | null>(null);
	let pulseMs = $state(DEFAULT_PULSE_MS);
	let firing = $state<Solenoid | null>(null);
	let note = $state<{ ok: boolean; text: string } | null>(null);

	$effect(() => {
		status = initial;
	});

	async function action(name: string, fields: Record<string, string>) {
		const fd = new FormData();
		for (const [k, v] of Object.entries(fields)) fd.set(k, v);
		const res = await fetch(`?/${name}`, { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
		return deserialize(await res.text());
	}

	async function refresh() {
		try {
			const r = await action('solenoids', {});
			if (r.type === 'success') status = ((r.data as { solenoids?: SolenoidStatus | null } | undefined)?.solenoids ?? null) as SolenoidStatus | null;
		} catch {
			/* keep the last status */
		}
	}

	onMount(() => {
		if (armReachable && !initial) void refresh();
	});

	async function fire(solenoid: Solenoid, ms: number) {
		if (firing) return;
		firing = solenoid;
		note = null;
		try {
			const r = await action('testFire', { solenoid, pulseMs: String(ms) });
			const d = (r.type === 'success' || r.type === 'failure' ? r.data : null) as { success?: string; error?: string } | null;
			note = r.type === 'success' ? { ok: true, text: d?.success ?? 'Fired.' } : { ok: false, text: d?.error ?? 'Fire failed.' };
		} catch (e) {
			note = { ok: false, text: `Fire failed: ${e instanceof Error ? e.message : String(e)}` };
		} finally {
			firing = null;
			void refresh();
		}
	}

	const clampMs = (v: number) => Math.min(MAX_PULSE_MS, Math.max(MIN_PULSE_MS, Math.round(Number.isFinite(v) ? v : DEFAULT_PULSE_MS)));
	const pinOn = (pin: number) => status?.pins?.[String(pin)]?.state === 1;
	const muted = 'color: var(--color-tron-text-secondary)';
	const amber = 'background: rgba(245,158,11,0.15); color: #fbbf24; border: 1px solid #f59e0b;';
	const input = 'rounded border bg-black/40 px-2 py-1 text-sm';
	const inputStyle = 'border-color: var(--color-tron-border); color: var(--color-tron-text)';
</script>

<section class="rounded border p-3 sm:p-4" style="border-color: var(--color-tron-border); background: var(--color-tron-surface);">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<h2 class="text-sm font-semibold tracking-wide" style="color: var(--color-tron-text)">⚡ TRAPDOOR SOLENOIDS</h2>
		<div class="flex flex-wrap items-center gap-1.5 text-[11px]">
			{#each SOLENOIDS as s (s.id)}
				<span class="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono" style="border-color: var(--color-tron-border); color: {pinOn(s.pin) ? '#fbbf24' : 'var(--color-tron-text-secondary)'}" title="{s.label} on GPIO {s.pin}">
					<span class="inline-block h-1.5 w-1.5 rounded-full" style="background: {pinOn(s.pin) ? '#f59e0b' : 'var(--color-tron-border)'}"></span>
					{s.id} · GPIO {s.pin}
				</span>
			{/each}
		</div>
	</div>

	<p class="mt-1 text-[11px]" style={muted}>
		{#if !armReachable}
			The arm Pi is unreachable.
		{:else if !status}
			No solenoid status from the Pi.
		{:else}
			{status.simulated ? 'Simulated: the Pi has no GPIO right now, so firing only times out the pulse.' : 'Pins are live on the Pi.'}
			{status.replayFire ? ' Fire steps play on this Pi.' : ''}
		{/if}
	</p>
	{#if armReachable && status && !status.replayFire}
		<p class="mt-1 text-[11px]" style="color: #fbbf24">
			The Pi's replay cannot fire steps yet (update replay_settle.py and gpio.py on the Pi and restart robot-arm). Move sets with fire steps will refuse to play; Test fire still works.
		</p>
	{/if}

	<div class="mt-3 flex flex-wrap items-end gap-2">
		{#if step}
			<button type="button" class="min-h-[38px] rounded px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40" style={amber}
				disabled={!armReachable || !!firing || !!status?.busy} onclick={() => fire(step.solenoid, step.pulseMs)}
				title="Pulse this step's solenoid now. The arm does not move.">
				{firing ? 'Firing…' : `Test fire ${step.solenoid} · ${step.pulseMs} ms`}
			</button>
		{:else}
			<label class="text-[11px]" style={muted}>Pulse (ms)
				<span class="mt-1 flex items-center gap-2">
					<input type="range" min={MIN_PULSE_MS} max={MAX_PULSE_MS} step="10" value={pulseMs} oninput={(e) => (pulseMs = clampMs(Number(e.currentTarget.value)))} class="w-28" aria-label="Pulse length" />
					<input type="number" min={MIN_PULSE_MS} max={MAX_PULSE_MS} step="10" value={pulseMs} onchange={(e) => (pulseMs = clampMs(Number(e.currentTarget.value)))} class="{input} w-20 font-mono" style={inputStyle} aria-label="Pulse length in ms" />
				</span>
			</label>
			{#each SOLENOIDS as s (s.id)}
				<button type="button" class="min-h-[38px] rounded px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40" style={amber}
					disabled={!armReachable || !!firing || !!status?.busy} onclick={() => fire(s.id, pulseMs)}
					title="Pulse {s.label} (GPIO {s.pin}) now. The arm does not move.">
					{firing === s.id ? 'Firing…' : `Test fire ${s.id}`}
				</button>
			{/each}
		{/if}
	</div>
	{#if note}<p class="mt-2 text-xs" style="color: {note.ok ? '#4ade80' : '#fca5a5'}">{note.text}</p>{/if}
	<p class="mt-2 text-[11px]" style={muted}>One solenoid at a time: the Pi refuses a second pulse while one is on, so both trapdoors never open together.</p>
</section>
