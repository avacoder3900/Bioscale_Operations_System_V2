<script lang="ts">
	import JsonTree from '$lib/components/JsonTree.svelte';

	interface Group {
		key: string;
		n: number;
		f3Sum: number;
		f7Sum: number;
		ratio: number | null;
	}
	interface Metrics {
		readingCount: number;
		f3Sum: number | null;
		f7Sum: number | null;
		ratio: number | null;
		baselineScans: number | null;
		testScans: number | null;
		byChannel: Group[];
		byPosition: Group[];
		baselineVsTest: Group[];
	}
	interface Props {
		data: { barcode: string; metrics: Metrics; cartridge: Record<string, unknown> };
	}
	let { data }: Props = $props();

	// Surface the run-result fields first (the "analyze" data), then the full
	// document — same idea as the research app's cartridge JSON view.
	const highlights = ['analysis', 'rawData', 'testResult', 'checkpoints'] as const;
	const present = $derived(highlights.filter((k) => data.cartridge[k] != null));

	function fmt(n: number | null, digits = 0): string {
		return n == null ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: digits });
	}

	const groupings = $derived(
		[
			{ label: 'By channel', groups: data.metrics.byChannel },
			{ label: 'By position', groups: data.metrics.byPosition },
			{ label: 'Baseline vs test', groups: data.metrics.baselineVsTest }
		].filter((g) => g.groups.length > 0)
	);
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-start justify-between gap-4">
		<div>
			<a href="/validation/optical-confirmation" class="text-sm text-[var(--color-tron-cyan)] hover:underline">
				← Back to Optical Confirmation
			</a>
			<h1 class="tron-heading mt-1 text-2xl font-bold">Cartridge Data</h1>
			<p class="tron-text-muted mt-1 font-mono text-sm">{data.barcode}</p>
		</div>
	</div>

	<!-- Computed analysis: F3/F7 sums + F7/F3 ratio (the research "analyze" calc) -->
	<div class="tron-card p-4">
		<div class="mb-3 flex items-baseline justify-between">
			<h2 class="tron-heading text-sm font-semibold uppercase tracking-wide">Analysis</h2>
			<span class="text-xs text-[var(--color-tron-text-secondary)]">
				{data.metrics.readingCount} reading{data.metrics.readingCount === 1 ? '' : 's'}
			</span>
		</div>
		{#if data.metrics.readingCount === 0}
			<p class="text-sm text-[var(--color-tron-text-secondary)]">
				No optical readings on this cartridge yet — it may not have been run.
			</p>
		{:else}
			<div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
				<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] p-4">
					<div class="text-xs uppercase tracking-wide text-[var(--color-tron-text-secondary)]">F3 sum</div>
					<div class="mt-1 font-mono text-2xl text-[var(--color-tron-cyan)]">{fmt(data.metrics.f3Sum)}</div>
				</div>
				<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] p-4">
					<div class="text-xs uppercase tracking-wide text-[var(--color-tron-text-secondary)]">F7 sum</div>
					<div class="mt-1 font-mono text-2xl text-[var(--color-tron-cyan)]">{fmt(data.metrics.f7Sum)}</div>
				</div>
				<div class="rounded-lg border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-cyan)]/10 p-4">
					<div class="text-xs uppercase tracking-wide text-[var(--color-tron-text-secondary)]">F7 / F3 ratio</div>
					<div class="mt-1 font-mono text-2xl text-[var(--color-tron-green)]">{fmt(data.metrics.ratio, 4)}</div>
				</div>
			</div>

			<!-- TEMPORARY diagnostic: which subset of readings should F3 sum over? -->
			<div class="mt-4 rounded-lg border border-dashed border-[var(--color-tron-orange)]/50 bg-[var(--color-tron-orange)]/5 p-4">
				<div class="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-tron-orange)]">
					Diagnostic — F3/F7 by grouping (temporary)
				</div>
				<p class="mb-3 text-xs text-[var(--color-tron-text-secondary)]">
					baselineScans: {data.metrics.baselineScans ?? '—'} · testScans: {data.metrics.testScans ?? '—'}.
					Tell me which row's <span class="font-mono">F3 sum</span> matches the research Excel and I'll lock the calc to that subset.
				</p>
				{#each groupings as grouping (grouping.label)}
					<div class="mb-3">
						<div class="mb-1 text-xs font-medium text-[var(--color-tron-text-primary)]">{grouping.label}</div>
						<table class="w-full font-mono text-xs">
							<thead class="text-left text-[var(--color-tron-text-secondary)]">
								<tr><th class="py-1 pr-4 font-medium">group</th><th class="py-1 pr-4 font-medium">n</th><th class="py-1 pr-4 font-medium">F3 sum</th><th class="py-1 pr-4 font-medium">F7 sum</th><th class="py-1 font-medium">F7/F3</th></tr>
							</thead>
							<tbody>
								{#each grouping.groups as g (g.key)}
									<tr class="border-t border-[var(--color-tron-border)]/50">
										<td class="py-1 pr-4 text-[var(--color-tron-text-primary)]">{g.key}</td>
										<td class="py-1 pr-4 text-[var(--color-tron-text-secondary)]">{g.n}</td>
										<td class="py-1 pr-4 text-[var(--color-tron-cyan)]">{fmt(g.f3Sum)}</td>
										<td class="py-1 pr-4 text-[var(--color-tron-cyan)]">{fmt(g.f7Sum)}</td>
										<td class="py-1 text-[var(--color-tron-green)]">{fmt(g.ratio, 4)}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/each}
			</div>
		{/if}
	</div>

	<!-- Run-result highlights (the analyze data), each expanded by default -->
	{#if present.length > 0}
		<div class="grid gap-4 md:grid-cols-2">
			{#each present as key (key)}
				<div class="tron-card p-4">
					<h2 class="tron-heading mb-2 text-sm font-semibold uppercase tracking-wide">{key}</h2>
					<div class="overflow-x-auto">
						<JsonTree value={data.cartridge[key]} defaultOpenDepth={2} />
					</div>
				</div>
			{/each}
		</div>
	{:else}
		<div class="tron-card p-4 text-sm text-[var(--color-tron-text-secondary)]">
			No run/analysis data on this cartridge yet — it may not have been run. The full
			document is below.
		</div>
	{/if}

	<!-- Full document -->
	<div class="tron-card p-4">
		<h2 class="tron-heading mb-3 text-sm font-semibold uppercase tracking-wide">Full Document</h2>
		<div class="overflow-x-auto">
			<JsonTree value={data.cartridge} name={null} defaultOpenDepth={1} />
		</div>
	</div>
</div>
