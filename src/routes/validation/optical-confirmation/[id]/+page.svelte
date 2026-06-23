<script lang="ts">
	import JsonTree from '$lib/components/JsonTree.svelte';

	interface Metrics {
		readingCount: number;
		f3Sum: number | null;
		f7Sum: number | null;
		ratio: number | null;
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
