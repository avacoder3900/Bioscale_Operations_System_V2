<script lang="ts">
	/**
	 * The conveyor belt on the arm Pi's BCM 22 (pin 15): Pulse / Stop / Force
	 * Off, a delay before the pulse, and the shared default pulse (stored in
	 * BIMS, changed only by Save). Posts the page's `conveyor*` actions
	 * ($lib/server/robot-arm-conveyor), so any page that spreads
	 * `conveyorActions` and returns `loadConveyor()` can show it.
	 *
	 * The Pi runs a pulse in the background; this panel polls conveyorStatus
	 * every 500 ms while one is running to follow it to the end.
	 */
	import { deserialize } from '$app/forms';
	import { untrack } from 'svelte';
	import type { ConveyorView } from '$lib/server/robot-arm-conveyor';
	import type { ConveyorStatus } from '$lib/server/robot-arm-client';

	let { initial }: { initial: ConveyorView } = $props();

	let status = $state<ConveyorStatus | null>(untrack(() => initial.status));
	let statusError = $state<string | null>(untrack(() => initial.statusError));
	let savedDefault = $state(untrack(() => initial.defaultPulseMs));
	let defaultMs = $state(untrack(() => initial.defaultPulseMs));
	let pulseMs = $state(untrack(() => initial.defaultPulseMs));
	let delayMs = $state(0);
	let busy = $state(false);
	let error = $state<string | null>(null);

	const reachable = $derived(status != null);
	const running = $derived(status?.running === true);
	const defaultDirty = $derived(defaultMs !== savedDefault);

	async function action(name: string, fields: Record<string, string> = {}) {
		const fd = new FormData();
		for (const [k, v] of Object.entries(fields)) fd.set(k, v);
		const res = await fetch(`?/${name}`, { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
		return deserialize(await res.text());
	}

	async function send(name: string, fields: Record<string, string> = {}) {
		busy = true;
		error = null;
		try {
			const r = await action(name, fields);
			const d = (r.type === 'success' || r.type === 'failure' ? r.data : null) as {
				status?: ConveyorStatus;
				savedDefaultMs?: number;
				error?: string;
			} | null;
			if (r.type === 'success') {
				if (d?.status) status = d.status;
				if (typeof d?.savedDefaultMs === 'number') {
					savedDefault = d.savedDefaultMs;
					pulseMs = d.savedDefaultMs;
				}
			} else {
				error = d?.error ?? 'Request failed.';
			}
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	async function poll() {
		try {
			const r = await action('conveyorStatus');
			if (r.type === 'success') {
				const d = r.data as { status: ConveyorStatus | null; statusError: string | null };
				status = d.status;
				statusError = d.statusError;
			}
		} catch {
			/* keep the last status */
		}
	}

	// Follow a pulse to its end.
	$effect(() => {
		if (!running) return;
		const wait = Math.min(500, (status?.ends_in_ms ?? 0) + 100);
		const t = setTimeout(poll, wait);
		return () => clearTimeout(t);
	});

	function seconds(ms: number | null | undefined): string {
		return `${((ms ?? 0) / 1000).toFixed(1)} s`;
	}

	const muted = 'color: var(--color-tron-text-secondary)';
	const inputClass = 'mt-1 w-full min-w-0 rounded border border-[var(--color-tron-border)] bg-black/40 px-2 py-1 text-sm';
	const inputStyle = 'color: var(--color-tron-text)';
</script>

<section class="rounded border p-3 sm:p-4" style="border-color: var(--color-tron-border); background: var(--color-tron-surface);">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<h2 class="text-sm font-semibold tracking-wide" style="color: var(--color-tron-text)">Conveyor Belt</h2>
		{#if status}
			<span class="flex items-center gap-1.5 text-[11px]" style={muted}>
				<span class="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono" style="border-color: var(--color-tron-border); color: {status.state ? '#4ade80' : 'var(--color-tron-text-secondary)'}">
					<span class="inline-block h-1.5 w-1.5 rounded-full" style="background: {status.state ? '#22c55e' : 'var(--color-tron-border)'}"></span>
					GPIO {status.pin}
				</span>
				{#if status.phase === 'on'}
					On · {seconds(status.ends_in_ms)} Left
				{:else if status.phase === 'delay'}
					Waiting · On In {seconds((status.ends_in_ms ?? 0) - (status.ms ?? 0))}
				{:else}
					Off
				{/if}
				{#if status.simulated}
					<span class="rounded border border-amber-500/50 bg-amber-500/10 px-1.5 text-amber-300">SIMULATED</span>
				{/if}
			</span>
		{/if}
	</div>

	<div class="mt-3 grid grid-cols-1 gap-4 md:grid-cols-[12rem_minmax(0,1fr)]">
		<div class="space-y-3">
			<label class="block text-xs" style={muted}>
				Pulse (ms)
				<input type="number" bind:value={pulseMs} min="10" max={initial.pulseMaxMs} step="10" class={inputClass} style={inputStyle} />
			</label>
			<div>
				<label class="block text-xs" style={muted} for="conveyor-default-ms">Default (ms)</label>
				<div class="mt-1 flex gap-2">
					<input id="conveyor-default-ms" type="number" bind:value={defaultMs} min="10" max={initial.pulseMaxMs} step="10" class="w-full min-w-0 rounded border border-[var(--color-tron-border)] bg-black/40 px-2 py-1 text-sm" style={inputStyle} />
					<button
						type="button"
						disabled={busy || !defaultDirty}
						onclick={() => send('conveyorSaveDefault', { default_ms: String(defaultMs) })}
						class="rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-3 py-1 text-xs font-medium transition-colors hover:bg-[var(--color-tron-cyan)]/20 disabled:cursor-not-allowed disabled:opacity-40"
						style="color: var(--color-tron-cyan)"
					>
						Save
					</button>
				</div>
			</div>
			<label class="block text-xs" style={muted}>
				Delay (ms)
				<input type="number" bind:value={delayMs} min="0" max={initial.delayMaxMs} step="100" class={inputClass} style={inputStyle} />
			</label>
		</div>

		<div class="grid grid-cols-1 content-start gap-3 sm:grid-cols-3">
			<button
				type="button"
				disabled={!reachable || busy || running}
				onclick={() => send('conveyorPulse', { pulse_ms: String(pulseMs), delay_ms: String(delayMs) })}
				class="min-h-[44px] w-full rounded px-3 py-1.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40"
				style="background: rgba(56,189,248,0.15); color: var(--color-tron-cyan); border: 1px solid var(--color-tron-cyan);"
			>
				Pulse
			</button>
			<button
				type="button"
				disabled={!reachable || busy}
				onclick={() => send('conveyorStop')}
				class="min-h-[44px] w-full rounded border border-red-500/60 bg-red-500/10 px-3 py-1.5 text-sm font-semibold text-red-300 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
			>
				Stop
			</button>
			<!-- Last resort: never disabled, so it can be sent even when the status read failed. -->
			<button
				type="button"
				onclick={() => send('conveyorForceOff')}
				class="min-h-[44px] w-full rounded border border-red-500 bg-red-500/25 px-3 py-1.5 text-sm font-semibold text-red-200 transition-colors hover:bg-red-500/40"
			>
				Force Off
			</button>
		</div>
	</div>

	{#if error}
		<p class="mt-2 text-xs text-red-400">{error}</p>
	{:else if statusError}
		<p class="mt-2 text-xs" style="color: #f59e0b">{statusError}</p>
	{/if}
</section>
