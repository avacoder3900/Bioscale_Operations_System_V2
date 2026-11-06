<script lang="ts">
	/**
	 * Maintenance → Movement Log (2026-11-06): every command BIMS sent that
	 * moved the arm, per servo, newest first, with how many times each servo
	 * moved and turned back in the window (shapes in $lib/robot-arm/move-log).
	 */
	import { DEFAULT_JOINT_NAMES } from '$lib/robot-arm/recording-cleanup';
	import { kindTitle } from '$lib/robot-arm/move-log';

	let { data } = $props();

	const BASE = '/manufacturing/cart-mfg/robot-arm/maintenance/moves';
	const windows = [
		{ minutes: 60, title: 'Last Hour' },
		{ minutes: 1440, title: 'Last 24 Hours' },
		{ minutes: 10080, title: 'Last 7 Days' },
		{ minutes: 0, title: 'All' }
	];
	const servos = [1, 2, 3, 4, 5, 6];

	const jointTitle = (sid: number) =>
		(DEFAULT_JOINT_NAMES[sid - 1] ?? '').split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

	function href(minutes: number, servo: number | null): string {
		const q = new URLSearchParams({ minutes: String(minutes) });
		if (servo) q.set('servo', String(servo));
		return `${BASE}?${q}`;
	}

	function when(iso: string): string {
		const d = new Date(iso);
		return isNaN(d.getTime())
			? ''
			: d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
	}

	const pill = 'rounded border px-2 py-0.5 text-xs transition-colors';
	const on = `${pill} border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]`;
	const off = `${pill} border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)]`;
</script>

<div class="mx-auto max-w-5xl space-y-4 p-4">
	<div class="flex items-center justify-between">
		<h1 class="text-base font-semibold" style="color: var(--color-tron-cyan)">Movement Log</h1>
		<a
			href="/manufacturing/cart-mfg/robot-arm/maintenance"
			class="text-xs transition-colors hover:text-[var(--color-tron-cyan)]"
			style="color: var(--color-tron-text-secondary)"
		>
			← Maintenance
		</a>
	</div>

	<div class="flex flex-wrap items-center gap-2">
		{#each windows as w (w.minutes)}
			<a href={href(w.minutes, data.servo)} class={data.minutes === w.minutes ? on : off}>{w.title}</a>
		{/each}
		<span class="mx-1 h-4 border-l border-[var(--color-tron-border)]"></span>
		<a href={href(data.minutes, null)} class={data.servo === null ? on : off}>All Servos</a>
		{#each servos as s (s)}
			<a href={href(data.minutes, s)} class={data.servo === s ? on : off}>Servo {s}</a>
		{/each}
	</div>

	{#if data.movesError}
		<div class="rounded border border-red-500/40 bg-red-900/10 p-3 text-sm text-red-300">{data.movesError}</div>
	{:else}
		<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
			<table class="w-full text-left text-xs">
				<thead style="color: var(--color-tron-text-secondary)">
					<tr><th class="py-1 pr-3">Servo</th><th class="pr-3">Joint</th><th class="pr-3">Moves</th><th class="pr-3">Direction Changes</th></tr>
				</thead>
				<tbody>
					{#each data.summary as s (s.servo)}
						<tr class="border-t border-[var(--color-tron-border)]" style="color: var(--color-tron-text)">
							<td class="py-1 pr-3">{s.servo}</td>
							<td class="pr-3">{jointTitle(s.servo)}</td>
							<td class="pr-3 font-mono">{s.moves}</td>
							<td class="pr-3 font-mono">{s.reversals}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>

		<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
			{#if !data.moves.length}
				<p class="text-xs" style="color: var(--color-tron-text-secondary)">No Movements Logged</p>
			{:else}
				{#if data.capped}
					<p class="mb-2 text-xs" style="color: var(--color-tron-text-secondary)">Newest {data.limit}</p>
				{/if}
				<table class="w-full text-left text-xs">
					<thead style="color: var(--color-tron-text-secondary)">
						<tr><th class="py-1 pr-3">When</th><th class="pr-3">Type</th><th class="pr-3">Movement</th><th class="pr-3">Result</th><th class="pr-3">From</th><th class="pr-3">By</th></tr>
					</thead>
					<tbody>
						{#each data.moves as m (m._id)}
							<tr class="border-t border-[var(--color-tron-border)]" style="color: var(--color-tron-text)">
								<td class="whitespace-nowrap py-1 pr-3" style="color: var(--color-tron-text-secondary)">{when(m.at)}</td>
								<td class="whitespace-nowrap pr-3">{kindTitle(m.kind)}</td>
								<td class="pr-3 font-mono">{m.line}</td>
								<td class="pr-3">
									{#if m.ok}
										<span class="text-green-300">Sent</span>
									{:else}
										<span class="text-red-300">Failed</span>
										<span class="ml-1" style="color: var(--color-tron-text-secondary)">{m.error}</span>
									{/if}
								</td>
								<td class="whitespace-nowrap pr-3" style="color: var(--color-tron-text-secondary)">{m.from ?? ''}</td>
								<td class="whitespace-nowrap pr-3">{m.movedBy?.username ?? ''}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</section>
	{/if}
</div>
