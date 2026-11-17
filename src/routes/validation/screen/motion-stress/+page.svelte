<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { onMount } from 'svelte';
	import { TronBadge, TronButton } from '$lib/components/ui';
	import Sparkline from '$lib/components/validation/screen/Sparkline.svelte';

	let { data, form } = $props();

	let spuId = $state('');
	let runs = $state(16);
	let stopOnFail = $state(true);
	let busy = $state(false);

	const hours = $derived(Math.round(((runs * data.limits.minutesPerRun) / 60) * 10) / 10);
	const blocks = $derived(Math.ceil(runs / data.limits.perBlock));
	const sel = $derived(data.selected);
	const anyRunning = $derived(data.soaks.some((s: any) => s.status === 'running'));

	// While a test runs this page is also the backstop that fires a block the
	// webhook missed — every refresh runs the server's advance step.
	onMount(() => {
		const id = setInterval(async () => {
			if (anyRunning) await invalidateAll();
		}, 60_000);
		return () => clearInterval(id);
	});

	const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
	const statusVariant = (s: string) => (s === 'running' ? 'info' : s === 'completed' ? 'success' : s === 'failed' ? 'error' : 'neutral');
	const fmt = (v: number | null) => (v == null ? '—' : String(v));
	const absErr = $derived(data.runs.filter((r: any) => r.err != null).map((r: any) => Math.abs(r.err)));
	const hitSeries = $derived(data.runs.map((r: any) => r.hits ?? 0));
	const homeSeries = $derived(data.runs.filter((r: any) => r.homeMs != null).map((r: any) => r.homeMs));
	const eta = $derived.by(() => {
		if (!sel || sel.status !== 'running') return null;
		const left = sel.targetRuns - sel.runsDone;
		return new Date(Date.now() + left * data.limits.minutesPerRun * 60_000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
	});
</script>

<div class="space-y-6">
	<div>
		<div class="flex items-center gap-3">
			<a href="/validation/screen" class="text-sm text-[var(--color-tron-cyan)] hover:underline">← Screen</a>
		</div>
		<h1 class="tron-heading mt-1 text-2xl font-bold">Motion stress test</h1>
		<p class="tron-text-muted mt-1 max-w-3xl text-sm">
			Overnight stress test of the motion system. Runs the production assay motion over and over with nothing
			inserted — the screen's level 2 only — and records each run's home error, limit hits, home time and travel so
			wear like seizing bushings shows up as a trend. The unit allows {data.limits.perBlock} runs per screen, so BIMS
			chains blocks of up to {data.limits.perBlock} and starts the next one as soon as the last one reports. Each run
			is about {Math.round(data.limits.minutesPerRun)} minutes. Its blocks do not change the unit's Screen validation.
		</p>
	</div>

	{#if form?.error}
		<div class="rounded-lg bg-[var(--color-tron-red)]/10 p-4 text-sm text-[var(--color-tron-red)]">{form.error}</div>
	{:else if form?.started}
		<div class="rounded-lg bg-[var(--color-tron-cyan)]/10 p-4 text-sm text-[var(--color-tron-cyan)]">Motion stress test started — the first block is running on the unit.</div>
	{:else if form?.stopped}
		<div class="rounded-lg bg-[var(--color-tron-cyan)]/10 p-4 text-sm text-[var(--color-tron-cyan)]">Motion stress test stopped. A block already on the unit finishes its runs; no new block starts.</div>
	{/if}

	<form
		method="POST"
		action="?/start"
		use:enhance={() => {
			busy = true;
			return async ({ update }) => {
				try {
					await update({ reset: false });
				} finally {
					busy = false;
				}
			};
		}}
		class="tron-card space-y-4 p-6"
	>
		<div class="grid gap-4 md:grid-cols-3">
			<div>
				<label for="soak-spu" class="tron-label">Unit</label>
				<select id="soak-spu" name="spuId" bind:value={spuId} class="tron-select w-full" style="min-height: 44px;" required>
					<option value="" disabled>Choose a unit…</option>
					{#each data.spus as s (s.id)}
						<option value={s.id}>{s.udi} — {s.status}</option>
					{/each}
				</select>
			</div>
			<div>
				<label for="soak-runs" class="tron-label">Assay-motion runs</label>
				<input id="soak-runs" name="runs" type="number" min="1" max={data.limits.maxRuns} bind:value={runs} class="tron-input w-full" style="min-height: 44px;" />
			</div>
			<div class="flex items-end">
				<label class="flex items-center gap-2 text-sm" style="min-height: 44px;">
					<input type="checkbox" name="stopOnFail" bind:checked={stopOnFail} />
					Stop at the first failing block
				</label>
			</div>
		</div>
		<p class="tron-text-muted text-xs">
			About {hours} h on the unit ({blocks} block{blocks === 1 ? '' : 's'}). The slot must be empty. Leaving this page
			open overnight is a good backstop: it checks every minute and restarts the chain if a hand-off was missed.
		</p>
		<TronButton type="submit" variant="primary" disabled={!spuId || busy || runs < 1}>{busy ? 'Asking the unit…' : 'Start motion stress test'}</TronButton>
	</form>

	{#if sel}
		<div class="tron-card space-y-4 p-6">
			<div class="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h2 class="tron-heading text-lg font-semibold">
						<a href="/spu/{sel.spuId}" class="hover:underline">{sel.spuUdi}</a>
						<TronBadge variant={statusVariant(sel.status)}>{sel.status}</TronBadge>
					</h2>
					<p class="tron-text-muted text-sm">
						{sel.runsDone} / {sel.targetRuns} runs · started {when(sel.startedAt)}{sel.startedBy ? ` by ${sel.startedBy}` : ''}
						{#if eta}· done around {eta}{/if}
						{#if sel.endedAt}· ended {when(sel.endedAt)}{/if}
					</p>
					{#if sel.endReason}<p class="mt-1 text-sm">{sel.endReason}</p>{/if}
					{#if sel.lastError && sel.status === 'running'}
						<p class="mt-1 text-sm text-[var(--color-tron-yellow,#e5c07b)]">Last hand-off problem: {sel.lastError}</p>
					{/if}
				</div>
				{#if sel.status === 'running'}
					<form method="POST" action="?/stop" use:enhance>
						<input type="hidden" name="id" value={sel.id} />
						<TronButton type="submit" variant="danger" size="sm">Stop test</TronButton>
					</form>
				{/if}
			</div>

			{#if data.runs.length}
				<div class="grid gap-4 md:grid-cols-3">
					<div>
						<div class="tron-text-muted text-xs">|End-of-test home error| (µm), per run</div>
						<Sparkline points={absErr} />
					</div>
					<div>
						<div class="tron-text-muted text-xs">Limit-switch hits, per run</div>
						<Sparkline points={hitSeries} />
					</div>
					<div>
						<div class="tron-text-muted text-xs">Home time (ms), per run</div>
						<Sparkline points={homeSeries} />
					</div>
				</div>

				<div class="overflow-x-auto">
					<table class="w-full text-xs">
						<thead class="text-[10px] uppercase text-[var(--color-tron-text-secondary)]">
							<tr class="border-b border-[var(--color-tron-border)]">
								<th class="py-1 pr-3 text-left font-medium">Run</th>
								<th class="py-1 pr-3 text-left font-medium">Block</th>
								<th class="py-1 pr-3 text-left font-medium">Finished</th>
								<th class="py-1 pr-3 text-right font-medium">Hits</th>
								<th class="py-1 pr-3 text-right font-medium">Home err µm</th>
								<th class="py-1 pr-3 text-left font-medium">Per-well err µm (w1…w6)</th>
								<th class="py-1 pr-3 text-right font-medium">Home ms</th>
								<th class="py-1 pr-3 text-right font-medium">Travel µm</th>
								<th class="py-1 pr-3 text-right font-medium">Dur s</th>
								<th class="py-1 pr-3 text-right font-medium">Heater °C</th>
								<th class="py-1 text-left font-medium">Flags</th>
							</tr>
						</thead>
						<tbody>
							{#each data.runs as r (r.n)}
								<tr class="border-b border-[var(--color-tron-border)]/40 {r.fails.length ? 'bg-[var(--color-tron-red)]/10' : ''}">
									<td class="py-1 pr-3">{r.n}</td>
									<td class="py-1 pr-3"><a href="/validation/screen/{r.sessionId}" class="text-[var(--color-tron-cyan)] hover:underline">{r.block}</a></td>
									<td class="py-1 pr-3">{when(r.at)}</td>
									<td class="py-1 pr-3 text-right {r.hits ? 'text-[var(--color-tron-red)]' : ''}">{fmt(r.hits)}</td>
									<td class="py-1 pr-3 text-right">{fmt(r.err)}</td>
									<td class="py-1 pr-3 font-mono">{r.wellErr.map(fmt).join(' / ')}</td>
									<td class="py-1 pr-3 text-right">{fmt(r.homeMs)}</td>
									<td class="py-1 pr-3 text-right">{fmt(r.travel)}</td>
									<td class="py-1 pr-3 text-right">{fmt(r.durS)}</td>
									<td class="py-1 pr-3 text-right">{fmt(r.tempC)}</td>
									<td class="py-1">{[...r.fails.map((f: string) => `FAIL ${f}`), ...r.warns.map((w: string) => `warn ${w}`)].join(' · ') || '—'}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{:else}
				<p class="tron-text-muted text-sm">No runs reported yet. The first run's results arrive about {Math.round(data.limits.minutesPerRun)} minutes after a block starts.</p>
			{/if}
		</div>
	{/if}

	{#if data.soaks.length}
		<div class="tron-card p-6">
			<h2 class="tron-heading mb-2 text-sm font-semibold uppercase tracking-wide">Recent motion stress tests</h2>
			<table class="w-full text-xs">
				<tbody>
					{#each data.soaks as s (s.id)}
						<tr class="border-b border-[var(--color-tron-border)]/40">
							<td class="py-1 pr-3"><a href="?id={s.id}" class="text-[var(--color-tron-cyan)] hover:underline">{when(s.startedAt)}</a></td>
							<td class="py-1 pr-3">{s.spuUdi}</td>
							<td class="py-1 pr-3"><TronBadge variant={statusVariant(s.status)}>{s.status}</TronBadge></td>
							<td class="py-1 pr-3">{s.runsDone} / {s.targetRuns} runs</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
