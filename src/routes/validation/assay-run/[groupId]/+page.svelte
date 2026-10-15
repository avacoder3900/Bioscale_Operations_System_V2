<script lang="ts">
	import { TronCard, TronBadge } from '$lib/components/ui';
	let { data } = $props();
	const g = $derived(data.group);
	const ev = $derived(data.evaluation);
	const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
	const n = (v: number | null | undefined, d = 2) => (v == null ? '—' : Number(v).toFixed(d));
	const verdict = $derived.by((): { text: string; v: 'success' | 'error' | 'warning' } => {
		if (g.override?.status === 'overridden') return { text: 'OVERRIDDEN → pass', v: 'success' };
		if (g.override?.status === 'failed') return { text: 'OVERRIDDEN → fail', v: 'error' };
		if (!ev || ev.passed == null) return { text: 'pending', v: 'warning' };
		return ev.passed ? { text: 'PASS', v: 'success' } : { text: 'FAIL', v: 'error' };
	});
	const CH_COLOR: Record<string, string> = { A: 'var(--color-tron-cyan)', B: 'var(--color-tron-orange)', C: 'var(--color-tron-purple)' };
</script>

<div class="space-y-6">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<h1 class="tron-heading text-2xl font-bold">Assay run — {g.name}</h1>
			<p class="tron-text-muted mt-1 text-sm">{g.spuUdi ?? '—'} · {g.cartridgeIds.length} cartridge{g.cartridgeIds.length === 1 ? '' : 's'}{g.lot ? ` · lot ${g.lot}` : ''}{g.assayId ? ` · assay ${g.assayId}` : ''}{g.intendedConcentration != null ? ` · ${g.intendedConcentration} ${g.intendedConcentrationUnit ?? ''}` : ''} · created {when(g.createdAt)} by {g.createdBy ?? '—'}</p>
			{#if g.override}<p class="mt-1 text-xs text-[var(--color-tron-orange)]">Override by {g.override.by?.username} at {when(g.override.at)}: {g.override.reason}</p>{/if}
		</div>
		<div class="flex items-center gap-3">
			<TronBadge variant={verdict.v}>{verdict.text}</TronBadge>
			<a href="/validation/assay-run?udi={encodeURIComponent(g.spuUdi ?? '')}" class="text-sm text-[var(--color-tron-cyan)] hover:underline">groups on this unit →</a>
			{#if g.spuId}<a href="/spu/{g.spuId}" class="text-sm text-[var(--color-tron-cyan)] hover:underline">unit →</a>{/if}
		</div>
	</div>

	{#if ev}
		<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
			<TronCard><div class="tron-text-muted text-[10px] uppercase">Valid / N</div><div class="text-2xl font-bold text-[var(--color-tron-cyan)]">{ev.nValid} / {ev.n}</div></TronCard>
			<TronCard><div class="tron-text-muted text-[10px] uppercase">Bead index (sample lanes)</div><div class="text-2xl font-bold text-[var(--color-tron-cyan)]">{n(ev.beadIndexMean)}</div><div class="tron-text-muted text-xs">CV {n(ev.beadIndexCv, 1)} %</div></TronCard>
			<TronCard><div class="tron-text-muted text-[10px] uppercase">Result</div><div class="text-2xl font-bold text-[var(--color-tron-cyan)]">{n(ev.resultMean, 3)}</div><div class="tron-text-muted text-xs">CV {n(ev.resultCv, 1)} %</div></TronCard>
			<TronCard><div class="tron-text-muted text-[10px] uppercase">Stage max |error|</div><div class="text-2xl font-bold {ev.stage.totalHits ? 'text-[var(--color-tron-red)]' : 'text-[var(--color-tron-cyan)]'}">{ev.stage.maxAbsErrorUm ?? '—'} µm</div><div class="tron-text-muted text-xs">{ev.stage.totalHits} hits · {ev.stage.runsWithStageCheck}/{ev.n} with stage check</div></TronCard>
			<TronCard><div class="tron-text-muted text-[10px] uppercase">Evaluated</div><div class="text-sm font-bold text-[var(--color-tron-cyan)]">{when(ev.evaluatedAt)}</div><div class="tron-text-muted text-xs">needs {ev.criteriaUsed.minRuns} runs</div></TronCard>
		</div>

		{#if ev.failureReasons.length}
			<div class="rounded-lg bg-[var(--color-tron-red)]/10 p-4 text-sm text-[var(--color-tron-red)]"><ul class="list-disc pl-5">{#each ev.failureReasons as r}<li>{r}</li>{/each}</ul></div>
		{/if}

		<TronCard>
			<h3 class="tron-text-primary mb-2 text-lg font-medium">Per lane</h3>
			<table class="text-xs">
				<thead class="text-[10px] uppercase text-[var(--color-tron-text-secondary)]"><tr><th class="pr-4 text-left">Lane</th><th class="pr-4 text-left">n</th><th class="pr-4 text-left">Bead index mean</th><th class="pr-4 text-left">BI CV %</th><th class="pr-4 text-left">Result mean</th><th class="pr-4 text-left">Result CV %</th></tr></thead>
				<tbody class="font-mono">
					{#each ['A', 'B', 'C'] as ch (ch)}
						{@const l = ev.lanes[ch]}
						<tr><td class="pr-4"><span class="mr-1 inline-block h-2 w-2 rounded-full" style="background: {CH_COLOR[ch]}"></span>{ch}{ev.criteriaUsed.sampleLanes.includes(ch) ? '' : ' (control)'}</td><td class="pr-4">{l?.n ?? 0}</td><td class="pr-4">{n(l?.beadIndexMean)}</td><td class="pr-4">{n(l?.beadIndexCv, 1)}</td><td class="pr-4">{n(l?.resultMean, 3)}</td><td class="pr-4">{n(l?.resultCv, 1)}</td></tr>
					{/each}
				</tbody>
			</table>
		</TronCard>

		<TronCard>
			<h3 class="tron-text-primary mb-2 text-lg font-medium">Members</h3>
			<div class="overflow-x-auto">
				<table class="w-full text-xs">
					<thead class="text-[10px] uppercase text-[var(--color-tron-text-secondary)]"><tr class="border-b border-[var(--color-tron-border)]"><th class="py-1 pr-3 text-left">Cartridge</th><th class="py-1 pr-3 text-left">Run</th><th class="py-1 pr-3 text-left">Source</th><th class="py-1 pr-3 text-left">BI A / B / C</th><th class="py-1 pr-3 text-left">Result A / B / C</th><th class="py-1 pr-3 text-left">Quant</th><th class="py-1 pr-3 text-left">Stage err / hits / first</th><th class="py-1 text-left">Valid</th></tr></thead>
					<tbody class="font-mono">
						{#each ev.members as m (m.cartridgeId)}
							<tr class="border-b border-[var(--color-tron-border)]/50">
								<td class="py-1 pr-3"><a href="/cartridges/{m.cartridgeId}" class="text-[var(--color-tron-cyan)] hover:underline">{m.cartridgeId}</a></td>
								<td class="py-1 pr-3">{m.complete ? when(m.runAt) : 'not run'}</td>
								<td class="py-1 pr-3 tron-text-muted">{m.lanes?.A?.source ?? '—'}</td>
								<td class="py-1 pr-3">{n(m.lanes?.A?.beadIndex)} / {n(m.lanes?.B?.beadIndex)} / {n(m.lanes?.C?.beadIndex)}</td>
								<td class="py-1 pr-3">{n(m.lanes?.A?.result, 3)} / {n(m.lanes?.B?.result, 3)} / {n(m.lanes?.C?.result, 3)}</td>
								<td class="py-1 pr-3">{m.quantValue != null ? `${m.quantValue} ${m.quantUnit ?? ''}` : '—'}</td>
								<td class="py-1 pr-3">{m.stageCheck ? `${m.stageCheck.endErrorUm} / ${m.stageCheck.limitHits} / ${m.stageCheck.firstHitUm}` : '—'}</td>
								<td class="py-1 {m.valid ? 'text-[var(--color-tron-green)]' : 'text-[var(--color-tron-red)]'}">{m.valid ? 'yes' : m.invalidReasons.join('; ')}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</TronCard>
	{/if}
</div>
