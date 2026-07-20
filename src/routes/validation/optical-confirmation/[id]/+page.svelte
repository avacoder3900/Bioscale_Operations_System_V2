<script lang="ts">
	import JsonTree from '$lib/components/JsonTree.svelte';

	// Mirrors the OpticalAnalysis contract from $lib/server/optical-analysis (kept
	// inline so this client component doesn't import a server-only module).
	interface OpticalChannelAnalysis {
		channel: 'A' | 'B' | 'C';
		n: number;
		sums: { f3: number; f5: number; f7: number };
		ratios: { 'f7/f3': number | null; 'f5/f3': number | null };
	}
	interface OpticalAnalysis {
		profileName: string;
		computedAt: string;
		denominatorColumn: 'f3';
		ratioNumerators: ['f5', 'f7'];
		channels: OpticalChannelAnalysis[];
		ratioByChannel: { A: number | null; B: number | null; C: number | null };
	}
	interface Props {
		data: { cartridge: Record<string, unknown>; analysis: OpticalAnalysis | null };
	}
	let { data }: Props = $props();

	const analysis = $derived(data.analysis);
	const hasReadings = $derived(!!analysis && analysis.channels.length > 0);

	let rawOpen = $state(false);

	function ratio(v: number | null): string {
		return v == null ? '—' : v.toFixed(2);
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div>
		<a
			href="/validation/optical-confirmation"
			class="text-sm text-[var(--color-tron-cyan)] hover:underline"
		>
			← Back to Optical Confirmation
		</a>
		<h1 class="tron-heading mt-1 text-2xl font-bold">Cartridge Data</h1>
	</div>

	<!-- Analysis: per-channel F3/F5/F7 sums + F7/F3, F5/F3 ratios -->
	<div class="tron-card p-4">
		<div class="mb-3 flex items-baseline justify-between">
			<h2 class="tron-heading text-sm font-semibold uppercase tracking-wide">Analysis</h2>
			{#if analysis}
				<span class="text-xs text-[var(--color-tron-text-secondary)]">{analysis.profileName}</span>
			{/if}
		</div>

		{#if !hasReadings}
			<p class="text-sm text-[var(--color-tron-text-secondary)]">
				No optical readings on this cartridge yet — it may not have been run.
			</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full min-w-[36rem] text-left text-sm">
					<thead class="text-xs uppercase tracking-wide text-[var(--color-tron-text-secondary)]">
						<tr class="border-b border-[var(--color-tron-border)]">
							<th class="py-2 pr-4 font-medium">Well</th>
							<th class="py-2 pr-4 font-medium">F3 sum</th>
							<th class="py-2 pr-4 font-medium">F7 sum</th>
							<th class="py-2 pr-4 font-medium">F5 sum</th>
							<th class="py-2 pr-4 font-medium">F7/F3</th>
							<th class="py-2 pr-4 font-medium">F5/F3</th>
							<th class="py-2 font-medium">n</th>
						</tr>
					</thead>
					<tbody class="font-mono">
						{#each analysis!.channels as ch (ch.channel)}
							<tr class="border-b border-[var(--color-tron-border)]/50">
								<td class="py-2 pr-4 text-[var(--color-tron-text-primary)]">{ch.channel}</td>
								<td class="py-2 pr-4 text-[var(--color-tron-cyan)]">{Math.round(ch.sums.f3)}</td>
								<td class="py-2 pr-4 text-[var(--color-tron-cyan)]">{Math.round(ch.sums.f7)}</td>
								<td class="py-2 pr-4 text-[var(--color-tron-cyan)]">{Math.round(ch.sums.f5)}</td>
								<td class="py-2 pr-4 text-[var(--color-tron-green)]">{ratio(ch.ratios['f7/f3'])}</td>
								<td class="py-2 pr-4 text-[var(--color-tron-text-primary)]">{ratio(ch.ratios['f5/f3'])}</td>
								<td class="py-2 text-[var(--color-tron-text-secondary)]">{ch.n}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>

	<!-- Raw data (collapsed by default) -->
	<div class="tron-card p-4">
		<button
			type="button"
			onclick={() => (rawOpen = !rawOpen)}
			class="flex w-full items-center gap-2 text-left"
		>
			<span class="inline-block w-3 text-[var(--color-tron-text-secondary)]">{rawOpen ? '▾' : '▸'}</span>
			<h2 class="tron-heading text-sm font-semibold uppercase tracking-wide">Raw data</h2>
		</button>
		{#if rawOpen}
			<div class="mt-3 overflow-x-auto">
				<JsonTree value={data.cartridge} name={null} defaultOpenDepth={1} />
			</div>
		{/if}
	</div>

	<!-- Footer note -->
	<p class="text-xs text-[var(--color-tron-text-secondary)]">
		F3 = 480 nm reference · F7 = 630 nm signal · Derived, non-destructive — the cartridge record is
		never modified.
	</p>
</div>
