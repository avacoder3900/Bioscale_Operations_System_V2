<script lang="ts">
	import JsonTree from '$lib/components/JsonTree.svelte';

	// Mirrors the CartridgeAnalysis contract from $lib/server/optical-analysis
	// (kept inline so this client component doesn't import a server-only module).
	interface BandStat {
		n: number;
		mean: number;
		sd: number;
		cv: number | null;
	}
	interface ChannelAnalysis {
		channel: 'A' | 'B' | 'C';
		n: number;
		windowK: number;
		f3: BandStat;
		f7: BandStat;
		ratio: number | null;
		ratioMode: number | null;
		ratioSd: number | null;
		ratioCv: number | null;
		bandLow: number | null;
		bandHigh: number | null;
		flags: string[];
	}
	interface CartridgeAnalysis {
		profileName: string;
		computedAt: string;
		windowK: number;
		channels: ChannelAnalysis[];
		ratioByChannel: { A: number | null; B: number | null; C: number | null };
		crossWellCv: number | null;
		rogueChannel: 'A' | 'B' | 'C' | null;
		warning: boolean;
		reasons: string[];
	}
	interface Props {
		data: { cartridge: Record<string, unknown>; analysis: CartridgeAnalysis | null };
	}
	let { data }: Props = $props();

	const analysis = $derived(data.analysis);
	const hasReadings = $derived(!!analysis && analysis.channels.length > 0);
	const windowK = $derived(analysis?.windowK ?? 10);

	let rawOpen = $state(false);

	function fmt(v: number | null | undefined, digits: number): string {
		return v == null || !Number.isFinite(v) ? '—' : v.toFixed(digits);
	}
	function band(low: number | null, high: number | null): string {
		if (low == null || high == null) return '—';
		return `${low.toFixed(2)}–${high.toFixed(2)}`;
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

	<!-- Warning banner -->
	{#if analysis?.warning}
		<div
			class="rounded border border-amber-500/60 bg-amber-500/10 p-4"
			role="alert"
		>
			<div class="flex items-center gap-2">
				<span class="text-lg text-amber-400">⚠</span>
				<h2 class="text-sm font-semibold uppercase tracking-wide text-amber-300">
					Data flags
				</h2>
			</div>
			<ul class="mt-2 space-y-1 pl-7 text-sm text-amber-200 list-disc">
				{#each analysis.reasons as reason (reason)}
					<li>{reason}</li>
				{/each}
			</ul>
		</div>
	{/if}

	<!-- Critical values: per-channel F7/F3 + band + precision -->
	<div class="tron-card p-4">
		<div class="mb-3 flex items-baseline justify-between">
			<h2 class="tron-heading text-sm font-semibold uppercase tracking-wide">Critical values</h2>
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
				<table class="w-full min-w-[48rem] text-left text-sm">
					<thead
						class="text-xs uppercase tracking-wide text-[var(--color-tron-text-secondary)]"
					>
						<tr class="border-b border-[var(--color-tron-border)]">
							<th class="py-2 pr-4 font-medium">Well</th>
							<th class="py-2 pr-4 font-medium">F7/F3</th>
							<th class="py-2 pr-4 font-medium">Mode</th>
							<th class="py-2 pr-4 font-medium">SD</th>
							<th class="py-2 pr-4 font-medium">In-range</th>
							<th class="py-2 pr-4 font-medium">F3 avg</th>
							<th class="py-2 pr-4 font-medium">F7 avg</th>
							<th class="py-2 pr-4 font-medium">Ratio CV</th>
							<th class="py-2 font-medium">n</th>
						</tr>
					</thead>
					<tbody class="font-mono">
						{#each analysis!.channels as ch (ch.channel)}
							{@const flagged = ch.flags.length > 0}
							{@const rogue = analysis!.rogueChannel === ch.channel}
							<tr
								class="border-b border-[var(--color-tron-border)]/50 {flagged
									? 'bg-amber-500/10'
									: ''}"
							>
								<td class="py-2 pr-4 text-[var(--color-tron-text-primary)]">
									<span class="inline-flex items-center gap-1.5">
										{ch.channel}
										{#if flagged}<span class="text-amber-400" title={ch.flags.join('\n')}>⚠</span>{/if}
										{#if rogue}
											<span
												class="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300"
											>
												outlier
											</span>
										{/if}
									</span>
								</td>
								<td class="py-2 pr-4 font-bold text-[var(--color-tron-green)]">
									{fmt(ch.ratio, 2)}
								</td>
								<td class="py-2 pr-4 text-[var(--color-tron-text-primary)]">
									{fmt(ch.ratioMode, 2)}
								</td>
								<td class="py-2 pr-4 text-[var(--color-tron-text-secondary)]">
									{fmt(ch.ratioSd, 3)}
								</td>
								<td class="py-2 pr-4 text-[var(--color-tron-cyan)]">
									{band(ch.bandLow, ch.bandHigh)}
								</td>
								<td class="py-2 pr-4 text-[var(--color-tron-text-primary)]">
									{fmt(ch.f3.mean, 0)}
								</td>
								<td class="py-2 pr-4 text-[var(--color-tron-text-primary)]">
									{fmt(ch.f7.mean, 0)}
								</td>
								<td
									class="py-2 pr-4 {ch.ratioCv != null && ch.ratioCv > 15
										? 'font-semibold text-amber-400'
										: 'text-[var(--color-tron-text-secondary)]'}"
								>
									{ch.ratioCv == null ? '—' : `${ch.ratioCv.toFixed(1)}%`}
								</td>
								<td class="py-2 text-[var(--color-tron-text-secondary)]">{ch.n}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			<!-- Summary -->
			<p class="mt-3 text-xs text-[var(--color-tron-text-secondary)]">
				Cross-channel F7/F3 CV =
				<span class="text-[var(--color-tron-text-primary)]">
					{analysis!.crossWellCv == null ? '—' : `${analysis!.crossWellCv.toFixed(1)}%`}
				</span>
				· stats over the last {windowK} readings (endpoint window)
			</p>
		{/if}
	</div>

	<!-- Raw data (collapsed by default) -->
	<div class="tron-card p-4">
		<button
			type="button"
			onclick={() => (rawOpen = !rawOpen)}
			class="flex w-full items-center gap-2 text-left"
		>
			<span class="inline-block w-3 text-[var(--color-tron-text-secondary)]"
				>{rawOpen ? '▾' : '▸'}</span
			>
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
		F3 = 480 nm reference · F7 = 630 nm signal · stats over the last {windowK} readings (endpoint
		window) · in-range band = mean ± 1σ · flags: CV>15%, point z>2σ, cross-channel CV>15% ·
		Derived, non-destructive — the record is never modified.
	</p>
</div>
