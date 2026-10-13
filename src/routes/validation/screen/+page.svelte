<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import { onMount } from 'svelte';
	import { TronCard, TronBadge, TronButton } from '$lib/components/ui';
	import ScreenRowsTable from '$lib/components/validation/screen/ScreenRowsTable.svelte';
	import Sparkline from '$lib/components/validation/screen/Sparkline.svelte';

	let { data, form } = $props();

	let spuId = $state('');
	let levels = $state<Record<string, boolean>>({ '0': true, '1': true, '2': true, '3': true });
	let reps = $state(data.defaults.reps);
	let running = $state(false);
	let showCriteria = $state(false);
	let criteriaText = $state(JSON.stringify(data.criteria ?? {}, null, 2));
	let expanded = $state<string | null>(null);

	const levelString = $derived(Object.entries(levels).filter(([, on]) => on).map(([k]) => k).sort().join(''));
	const estMinutes = $derived((levels['0'] ? 0.4 : 0) + (levels['1'] ? 4 : 0) + (levels['2'] ? 21 * reps : 0) + (levels['3'] ? 0.7 : 0));

	const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
	function badge(status: string | null | undefined): 'success' | 'error' | 'warning' | 'neutral' {
		if (status === 'passed' || status === 'P') return 'success';
		if (status === 'failed' || status === 'F') return 'error';
		if (status === 'W') return 'warning';
		return 'neutral';
	}
	function verdict(h: any): { text: string; v: 'success' | 'error' | 'warning' | 'neutral' } {
		if (!h.complete) return { text: h.rows.length ? `running… ${Object.values(h.levels).filter((l: any) => l.complete).length} level(s) in` : 'queued', v: 'warning' };
		if (h.overallPassed) return { text: 'PASS', v: 'success' };
		return { text: 'FAIL', v: 'error' };
	}

	// Live refresh while any screen on the page is still running.
	const anyRunning = $derived(data.history.some((h: any) => !h.complete));
	onMount(() => {
		const id = setInterval(async () => {
			if (document.hidden || !anyRunning) return;
			await invalidateAll();
		}, 15000);
		return () => clearInterval(id);
	});

	function setUnitFilter(udi: string) {
		const u = new URL(location.href);
		if (udi) u.searchParams.set('udi', udi);
		else u.searchParams.delete('udi');
		goto(u.toString(), { keepFocus: true, noScroll: true });
	}
	function setMetric(m: string) {
		const u = new URL(location.href);
		u.searchParams.set('metric', m);
		goto(u.toString(), { keepFocus: true, noScroll: true });
	}
</script>

<div class="space-y-6">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<h1 class="tron-heading text-2xl font-bold">Screen</h1>
			<p class="tron-text-muted mt-1 max-w-3xl text-sm">
				The one-button device screen (firmware v102). Nothing inserted. The unit runs its self-test table —
				static checks, actuators and sensors, the real assay motion ×{reps} with the stage check, the cloud
				round trip — and publishes each level as it finishes. Results land here and on the unit; the
				summary writes the unit's Screen validation. A full screen is about 75 minutes; levels 0, 1 and 3
				alone take about 5.
			</p>
		</div>
		<div class="flex gap-2">
			<a href="/validation/screen/export.csv{data.filterUdi ? `?udi=${encodeURIComponent(data.filterUdi)}` : ''}" class="text-sm text-[var(--color-tron-cyan)] hover:underline">Export CSV ↓</a>
			<button type="button" class="text-sm text-[var(--color-tron-cyan)] hover:underline" onclick={() => (showCriteria = !showCriteria)}>
				{showCriteria ? 'Hide criteria' : 'Criteria'}
			</button>
		</div>
	</div>

	{#if form?.error}
		<div class="rounded-lg bg-[var(--color-tron-red)]/10 p-4 text-sm text-[var(--color-tron-red)]">{form.error}</div>
	{:else if form?.queued}
		<div class="rounded-lg bg-[var(--color-tron-cyan)]/10 p-4 text-sm text-[var(--color-tron-cyan)]">
			Screen queued on {form.spuUdi} (levels {form.levels}, ×{form.reps}). The unit's LED cycles green → white → purple → blue while it runs; results appear below as each level finishes.
		</div>
	{:else if form?.criteriaSaved}
		<div class="rounded-lg bg-[var(--color-tron-cyan)]/10 p-4 text-sm text-[var(--color-tron-cyan)]">Criteria saved ({form.count} test ids). Sessions re-evaluate against them when they are opened.</div>
	{/if}

	{#if showCriteria}
		<form method="POST" action="?/saveCriteria" use:enhance class="tron-card space-y-3 p-4">
			<h2 class="tron-heading text-sm font-semibold uppercase tracking-wide">Screen criteria (BIMS-owned limits)</h2>
			<p class="tron-text-muted text-xs">
				JSON keyed by test id. Each entry: <code>min</code>, <code>max</code>, <code>warnOnly</code> (breach = warn, not fail), <code>ignore</code> (count as info). A row with no entry keeps the status the device gave it. Known ids: {data.criteriaIds.map((c: any) => c.id).join(', ')}.
			</p>
			<textarea name="criteria" bind:value={criteriaText} rows="12" class="tron-input w-full font-mono text-xs" spellcheck="false"></textarea>
			<TronButton type="submit" variant="primary" size="sm">Save criteria</TronButton>
		</form>
	{/if}

	<form
		method="POST"
		action="?/run"
		use:enhance={() => {
			running = true;
			return async ({ update }) => {
				try {
					await update({ reset: false });
				} finally {
					running = false;
				}
			};
		}}
		class="tron-card space-y-4 p-6"
	>
		<div class="grid gap-4 md:grid-cols-3">
			<div>
				<label for="screen-spu" class="tron-label">Unit</label>
				<select id="screen-spu" name="spuId" bind:value={spuId} class="tron-select w-full" style="min-height: 44px;" required>
					<option value="" disabled>Choose a unit…</option>
					{#each data.spus as s (s.id)}
						<option value={s.id}>{s.udi} — {s.status}{s.screen !== 'pending' ? ` · screen ${s.screen}` : ''}</option>
					{/each}
				</select>
			</div>
			<div>
				<span class="tron-label">Levels</span>
				<div class="flex flex-wrap gap-2">
					{#each [['0', 'Static'], ['1', 'Actuators & sensors'], ['2', 'Assay motion'], ['3', 'Cloud']] as [k, label] (k)}
						<label class="flex cursor-pointer items-center gap-2 rounded border px-3 py-2 text-sm {levels[k] ? 'border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]' : 'border-[var(--color-tron-border)] tron-text-muted'}">
							<input type="checkbox" bind:checked={levels[k]} class="hidden" />
							{k} · {label}
						</label>
					{/each}
				</div>
				<input type="hidden" name="levels" value={levelString} />
			</div>
			<div>
				<label for="screen-reps" class="tron-label">Repeats (assay motion runs)</label>
				<input id="screen-reps" name="reps" type="number" min="1" max="9" bind:value={reps} class="tron-input w-full" style="min-height: 44px;" />
			</div>
		</div>
		<p class="tron-text-muted text-xs">About {Math.round(estMinutes)} min on the unit. The slot must be empty; the unit refuses otherwise.</p>
		<button type="submit" disabled={!spuId || running || !levelString} class="w-full rounded-lg bg-[var(--color-tron-orange)] px-6 py-4 text-lg font-semibold text-[var(--color-tron-bg-primary)] hover:bg-[var(--color-tron-orange)]/90 disabled:cursor-not-allowed disabled:opacity-50" style="min-height: 44px">
			{running ? 'Asking the unit…' : 'Screen'}
		</button>
	</form>

	{#if data.openJobs?.length}
		<TronCard>
			<h3 class="tron-text-primary mb-2 text-sm font-medium">Record uploads waiting on the device</h3>
			<ul class="space-y-1 text-xs">
				{#each data.openJobs as j (j.id)}
					<li class="font-mono">{j.spuUdi ?? j.particleDeviceId} · record {j.chunkId} · {j.received}/{j.total} chunks{j.missing.length ? ` · missing ${j.missing.slice(0, 10).join(',')}${j.missing.length > 10 ? '…' : ''}` : ''}{j.lastError ? ` · ${j.lastError}` : ''} · {when(j.lastChunkAt)}</li>
				{/each}
			</ul>
		</TronCard>
	{/if}

	<!-- Fleet compare -->
	<TronCard>
		<div class="mb-3 flex flex-wrap items-center justify-between gap-2">
			<h3 class="tron-text-primary text-lg font-medium">Fleet compare — latest screen per unit</h3>
			<select class="tron-select" style="min-height: 36px;" value={data.metric} onchange={(e) => setMetric((e.currentTarget as HTMLSelectElement).value)}>
				{#each data.metrics as m (m.id)}<option value={m.id}>{m.label}</option>{/each}
			</select>
		</div>
		{#if data.compare.length === 0}
			<p class="tron-text-muted text-sm">No unit has a numeric value for this test yet.</p>
		{:else}
			{@const vals = data.compare.map((c: any) => c.value as number)}
			{@const lo = Math.min(...vals)}
			{@const hi = Math.max(...vals)}
			<div class="space-y-1">
				{#each data.compare as c (c.spuUdi)}
					<div class="flex items-center gap-3 text-xs">
						<a href="/validation/screen?udi={encodeURIComponent(c.spuUdi ?? '')}" class="w-40 shrink-0 font-mono text-[var(--color-tron-cyan)] hover:underline">{c.spuUdi}</a>
						<div class="h-3 flex-1 rounded bg-[var(--color-tron-bg-tertiary)]">
							<div class="h-3 rounded" style="width: {hi === lo ? 100 : Math.max(2, (((c.value ?? lo) - lo) / (hi - lo)) * 100)}%; background: {c.status === 'F' ? 'var(--color-tron-red)' : c.status === 'W' ? 'var(--color-tron-orange)' : 'var(--color-tron-cyan)'}"></div>
						</div>
						<span class="w-20 shrink-0 text-right font-mono">{c.value}</span>
						<span class="tron-text-muted w-28 shrink-0">{when(c.at)}</span>
					</div>
				{/each}
			</div>
		{/if}
	</TronCard>

	<!-- History / unit view -->
	<TronCard>
		<div class="mb-3 flex flex-wrap items-center justify-between gap-2">
			<h3 class="tron-text-primary text-lg font-medium">{data.filterUdi ? `Screens — ${data.filterUdi}` : 'Recent screens'} ({data.history.length})</h3>
			<select class="tron-select" style="min-height: 36px;" value={data.filterUdi ?? ''} onchange={(e) => setUnitFilter((e.currentTarget as HTMLSelectElement).value)}>
				<option value="">All units</option>
				{#each data.spus as s (s.id)}<option value={s.udi}>{s.udi}</option>{/each}
			</select>
		</div>

		{#if data.filterUdi && data.trends.length}
			<div class="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
				{#each data.trends as t (t.id)}
					<div class="rounded border border-[var(--color-tron-border)] p-2">
						<div class="tron-text-muted text-[10px] uppercase">{t.label}{t.unit ? ` (${t.unit})` : ''}</div>
						<Sparkline points={t.points.map((p: any) => p.value)} />
						<div class="font-mono text-xs">{t.points[t.points.length - 1].value} <span class="tron-text-muted">latest · {t.points.length} screens</span></div>
					</div>
				{/each}
			</div>
		{/if}

		{#if data.history.length === 0}
			<p class="tron-text-muted text-sm">No screens yet.</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-xs">
					<thead class="text-[10px] uppercase text-[var(--color-tron-text-secondary)]">
						<tr class="border-b border-[var(--color-tron-border)]">
							<th class="py-1 pr-4 text-left font-medium">Started</th>
							<th class="py-1 pr-4 text-left font-medium">Unit</th>
							<th class="py-1 pr-4 text-left font-medium">fw / run</th>
							<th class="py-1 pr-4 text-left font-medium">Verdict</th>
							<th class="py-1 pr-4 text-left font-medium">Pass / Fail / Warn / Skip</th>
							<th class="py-1 pr-4 text-left font-medium">Levels</th>
							<th class="py-1 text-left font-medium"></th>
						</tr>
					</thead>
					<tbody class="font-mono tron-text-primary">
						{#each data.history as h (h.id)}
							{@const v = verdict(h)}
							<tr class="border-b border-[var(--color-tron-border)]/50">
								<td class="py-1 pr-4">{when(h.startedAt)}</td>
								<td class="py-1 pr-4"><a href={h.spuId ? `/spu/${h.spuId}` : '#'} class="text-[var(--color-tron-cyan)] hover:underline">{h.spuUdi ?? h.particleDeviceId ?? '—'}</a></td>
								<td class="py-1 pr-4">{h.fw ?? '—'} / {h.run ?? '—'}</td>
								<td class="py-1 pr-4"><TronBadge variant={v.v}>{v.text}</TronBadge></td>
								<td class="py-1 pr-4">{h.counts.pass} / <span class={h.counts.fail ? 'text-[var(--color-tron-red)]' : ''}>{h.counts.fail}</span> / {h.counts.warn} / {h.counts.skip}</td>
								<td class="py-1 pr-4">{Object.entries(h.levels).map(([k, l]: any) => `${k}${l.complete ? '' : '…'}`).join(' ')}</td>
								<td class="py-1 whitespace-nowrap">
									<button type="button" class="text-[var(--color-tron-cyan)] hover:underline" onclick={() => (expanded = expanded === h.id ? null : h.id)}>{expanded === h.id ? 'hide' : 'rows'}</button>
									<a href="/validation/screen/{h.id}" class="ml-2 text-[var(--color-tron-cyan)] hover:underline">open →</a>
								</td>
							</tr>
							{#if expanded === h.id}
								<tr class="border-b border-[var(--color-tron-border)]/50">
									<td colspan="7" class="bg-[var(--color-tron-bg-secondary)]/40 px-3 py-3 font-sans">
										<ScreenRowsTable rows={h.rows} levels={h.levels} sessionId={h.id} confirms={h.operatorConfirms} compact />
									</td>
								</tr>
							{/if}
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</TronCard>
</div>
