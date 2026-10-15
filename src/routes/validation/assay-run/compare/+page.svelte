<script lang="ts">
	import { TronCard } from '$lib/components/ui';
	let { data } = $props();
	const n = (v: number | null | undefined, d = 2) => (v == null ? '—' : Number(v).toFixed(d));
	const delta = (x: number | null | undefined, y: number | null | undefined) => (x == null || y == null ? '—' : (y - x).toFixed(3));
	const ROWS: Array<[string, (e: any) => number | null]> = [
		['Valid cartridges', (e) => e?.nValid ?? null],
		['Bead index mean (sample lanes)', (e) => e?.beadIndexMean ?? null],
		['Bead index CV %', (e) => e?.beadIndexCv ?? null],
		['Result mean', (e) => e?.resultMean ?? null],
		['Result CV %', (e) => e?.resultCv ?? null],
		['Lane A bead index', (e) => e?.lanes?.A?.beadIndexMean ?? null],
		['Lane B bead index', (e) => e?.lanes?.B?.beadIndexMean ?? null],
		['Lane C bead index', (e) => e?.lanes?.C?.beadIndexMean ?? null],
		['Stage max |error| µm', (e) => e?.stage?.maxAbsErrorUm ?? null],
		['Limit hits (total)', (e) => e?.stage?.totalHits ?? null]
	];
</script>

<div class="space-y-6">
	<div>
		<h1 class="tron-heading text-2xl font-bold">Assay run — compare</h1>
		<p class="tron-text-muted mt-1 text-sm">Two groups side by side: the same lot on two units, or one unit across time.</p>
	</div>
	{#if data.problem}
		<div class="rounded-lg bg-[var(--color-tron-orange)]/10 p-4 text-sm text-[var(--color-tron-orange)]">{data.problem}</div>
	{:else if data.sides}
		{@const a = data.sides.a}
		{@const b = data.sides.b}
		<TronCard>
			<table class="w-full text-sm">
				<thead class="text-[10px] uppercase text-[var(--color-tron-text-secondary)]">
					<tr class="border-b border-[var(--color-tron-border)]"><th class="py-1 pr-4 text-left">Metric</th><th class="py-1 pr-4 text-left"><a href="/validation/assay-run/{a.id}" class="text-[var(--color-tron-cyan)] hover:underline">A · {a.name}</a><div class="normal-case tron-text-muted">{a.spuUdi ?? ''}{a.lot ? ` · ${a.lot}` : ''}</div></th><th class="py-1 pr-4 text-left"><a href="/validation/assay-run/{b.id}" class="text-[var(--color-tron-cyan)] hover:underline">B · {b.name}</a><div class="normal-case tron-text-muted">{b.spuUdi ?? ''}{b.lot ? ` · ${b.lot}` : ''}</div></th><th class="py-1 text-left">B − A</th></tr>
				</thead>
				<tbody class="font-mono">
					{#each ROWS as [label, f] (label)}
						<tr class="border-b border-[var(--color-tron-border)]/50"><td class="py-1 pr-4 font-sans">{label}</td><td class="py-1 pr-4">{n(f(a.evaluation))}</td><td class="py-1 pr-4">{n(f(b.evaluation))}</td><td class="py-1">{delta(f(a.evaluation), f(b.evaluation))}</td></tr>
					{/each}
				</tbody>
			</table>
		</TronCard>
	{/if}
</div>
