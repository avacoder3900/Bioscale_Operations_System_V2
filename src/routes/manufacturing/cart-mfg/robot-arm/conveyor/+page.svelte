<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidate } from '$app/navigation';
	import { onMount } from 'svelte';

	let { data, form } = $props();

	// The default pulse is a per-browser setting, remembered across reloads.
	const DEFAULT_KEY = 'robot-arm:conveyor-default-ms';
	let defaultMs = $state(600);
	let pulseMs = $state(600);
	onMount(() => {
		try {
			const saved = Number(localStorage.getItem(DEFAULT_KEY));
			if (Number.isInteger(saved) && saved >= 10 && saved <= data.pulseMaxMs) {
				defaultMs = saved;
				pulseMs = saved;
			}
		} catch {
			/* storage unavailable — keep 600 */
		}
	});
	function setDefault() {
		if (!Number.isInteger(defaultMs) || defaultMs < 10 || defaultMs > data.pulseMaxMs) return;
		pulseMs = defaultMs;
		try {
			localStorage.setItem(DEFAULT_KEY, String(defaultMs));
		} catch {
			/* ignore */
		}
	}
	let delayMs = $state(0);
	let busy = $state(false);

	const status = $derived(data.status);
	const reachable = $derived(status != null);
	const running = $derived(status?.running === true);

	const conveyorEnhance = () => {
		busy = true;
		return async ({ update }: { update: (opts?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			busy = false;
		};
	};

	// Follow a pulse to its end. The Pi runs it in the background, so the
	// only way to see the belt stop is to re-read the status.
	$effect(() => {
		if (!running) return;
		const wait = Math.min(500, (status?.ends_in_ms ?? 0) + 100);
		const t = setTimeout(() => invalidate('robot-arm:conveyor'), wait);
		return () => clearTimeout(t);
	});

	function seconds(ms: number | null | undefined): string {
		return `${((ms ?? 0) / 1000).toFixed(1)} s`;
	}
</script>

<section
	class="rounded border p-3 sm:p-4"
	style="border-color: var(--color-tron-border); background: var(--color-tron-surface);"
>
	<div class="flex items-center justify-between gap-3">
		<h2 class="text-sm font-semibold tracking-wide" style="color: var(--color-tron-text)">
			CONVEYOR (GPIO 22)
		</h2>
		{#if status}
			<span class="flex items-center gap-1.5 text-xs" style="color: var(--color-tron-text-secondary)">
				<span
					class="inline-block h-2 w-2 rounded-full"
					style="background: {status.state ? '#22c55e' : '#6b7280'}"
				></span>
				{#if status.phase === 'on'}
					On · {seconds(status.ends_in_ms)} left
				{:else if status.phase === 'delay'}
					Waiting · on in {seconds((status.ends_in_ms ?? 0) - (status.ms ?? 0))}
				{:else}
					Off
				{/if}
				{#if status.simulated}
					<span class="rounded border border-amber-500/50 bg-amber-500/10 px-1.5 text-amber-300">
						SIMULATED
					</span>
				{/if}
			</span>
		{/if}
	</div>

	<div class="mt-3 grid grid-cols-1 gap-4 md:grid-cols-[12rem_minmax(0,1fr)]">
		<div class="space-y-3">
			<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
				Pulse (ms)
				<input
					type="number"
					bind:value={pulseMs}
					min="10"
					max={data.pulseMaxMs}
					step="10"
					class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/40 px-2 py-1 text-sm"
					style="color: var(--color-tron-text)"
				/>
			</label>
			<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
				Default (ms)
				<input
					type="number"
					bind:value={defaultMs}
					onchange={setDefault}
					min="10"
					max={data.pulseMaxMs}
					step="10"
					class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/40 px-2 py-1 text-sm"
					style="color: var(--color-tron-text)"
				/>
			</label>
			<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
				Delay (ms)
				<input
					type="number"
					bind:value={delayMs}
					min="0"
					max={data.delayMaxMs}
					step="100"
					class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/40 px-2 py-1 text-sm"
					style="color: var(--color-tron-text)"
				/>
			</label>
		</div>

		<div class="grid grid-cols-1 content-start gap-3 sm:grid-cols-3">
			<form method="POST" action="?/pulse" use:enhance={conveyorEnhance}>
				<input type="hidden" name="pulse_ms" value={pulseMs} />
				<input type="hidden" name="delay_ms" value={delayMs} />
				<button
					type="submit"
					disabled={!reachable || busy || running}
					class="min-h-[44px] w-full rounded px-3 py-1.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40"
					style="background: rgba(56,189,248,0.15); color: var(--color-tron-cyan); border: 1px solid var(--color-tron-cyan);"
				>
					Pulse
				</button>
			</form>
			<form method="POST" action="?/stop" use:enhance={conveyorEnhance}>
				<button
					type="submit"
					disabled={!reachable || busy}
					class="min-h-[44px] w-full rounded border border-red-500/60 bg-red-500/10 px-3 py-1.5 text-sm font-semibold text-red-300 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
				>
					Stop
				</button>
			</form>
			<!-- Last resort: never disabled, so it can be sent even when the status read failed. -->
			<form method="POST" action="?/forceOff" use:enhance={conveyorEnhance}>
				<button
					type="submit"
					class="min-h-[44px] w-full rounded border border-red-500 bg-red-500/25 px-3 py-1.5 text-sm font-semibold text-red-200 transition-colors hover:bg-red-500/40"
				>
					Force Off
				</button>
			</form>
		</div>
	</div>

	{#if form?.error}
		<p class="mt-2 text-xs text-red-400">{form.error}</p>
	{:else if data.statusError}
		<p class="mt-2 text-xs" style="color: #f59e0b">{data.statusError}</p>
	{/if}
</section>
