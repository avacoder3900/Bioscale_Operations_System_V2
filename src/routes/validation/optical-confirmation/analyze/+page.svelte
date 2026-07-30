<script lang="ts">
	// Mirrors the GroupAnalysis contract from $lib/server/optical-analysis (kept inline
	// so this client component doesn't import a server-only module).
	interface GroupChannelStat {
		channel: 'A' | 'B' | 'C';
		n: number;
		mean: number | null;
		mode: number | null;
		sd: number | null;
		cv: number | null;
		bandLow: number | null;
		bandHigh: number | null;
	}
	interface GroupCartridgeRow {
		id: string;
		label: string;
		ratioByChannel: { A: number | null; B: number | null; C: number | null };
		outlierChannels: Array<'A' | 'B' | 'C'>;
		warning: boolean;
	}
	interface GroupAnalysis {
		n: number;
		windowK: number;
		channels: GroupChannelStat[];
		cartridges: GroupCartridgeRow[];
		crossCartridgeFlags: string[];
	}
	interface Props {
		data: { group: GroupAnalysis | null; ids: string[] };
	}
	let { data }: Props = $props();

	const group = $derived(data.group);
	const hasData = $derived(!!group && group.n > 0);
	const CHANNELS: Array<'A' | 'B' | 'C'> = ['A', 'B', 'C'];

	function fmt(v: number | null | undefined): string {
		return v == null ? '—' : v.toFixed(2);
	}
	function band(lo: number | null, hi: number | null): string {
		if (lo == null || hi == null) return '—';
		return `${lo.toFixed(2)}–${hi.toFixed(2)}`;
	}
	function cvClass(cv: number | null): string {
		// Tailwind's built-in amber, matching the [id] detail page. The
		// --color-tron-amber custom property does NOT exist in layout.css, so
		// styling on it renders as plain body text (this table's warnings were
		// invisible until 2026-07-30).
		return cv != null && cv > 15 ? 'text-amber-400' : 'text-[var(--color-tron-text-primary)]';
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
		<h1 class="tron-heading mt-1 text-2xl font-bold">
			Group Analysis — {group?.n ?? 0} cartridge{(group?.n ?? 0) === 1 ? '' : 's'}
		</h1>
	</div>

	{#if !hasData}
		<div class="tron-card p-4">
			<p class="text-sm text-[var(--color-tron-text-secondary)]">
				No cartridges selected for group analysis, or none of the selected cartridges have optical
				readings yet. Select cartridges from the optical log and analyze them together.
			</p>
		</div>
	{:else}
		<!-- Cross-cartridge flags -->
		{#if group!.crossCartridgeFlags.length > 0}
			<div class="space-y-1">
				{#each group!.crossCartridgeFlags as flag}
					<p class="text-sm text-amber-400">⚠ {flag}</p>
				{/each}
			</div>
		{/if}

		<!-- Per-channel group stats -->
		<div class="tron-card p-4">
			<h2 class="tron-heading mb-3 text-sm font-semibold uppercase tracking-wide">
				Per-channel group stats
			</h2>
			<div class="overflow-x-auto">
				<table class="w-full min-w-[42rem] text-left text-sm">
					<thead
						class="text-xs uppercase tracking-wide text-[var(--color-tron-text-secondary)]"
					>
						<tr class="border-b border-[var(--color-tron-border)]">
							<th class="py-2 pr-4 font-medium">Well</th>
							<th class="py-2 pr-4 font-medium">Mean F7/F3</th>
							<th class="py-2 pr-4 font-medium">Mode</th>
							<th class="py-2 pr-4 font-medium">SD</th>
							<th class="py-2 pr-4 font-medium">In-range</th>
							<th class="py-2 pr-4 font-medium">CV</th>
							<th class="py-2 font-medium">n</th>
						</tr>
					</thead>
					<tbody class="font-mono">
						{#each group!.channels as ch (ch.channel)}
							<tr class="border-b border-[var(--color-tron-border)]/50">
								<td class="py-2 pr-4 text-[var(--color-tron-text-primary)]">{ch.channel}</td>
								<td class="py-2 pr-4 text-[var(--color-tron-green)]">{fmt(ch.mean)}</td>
								<td class="py-2 pr-4 text-[var(--color-tron-text-primary)]">{fmt(ch.mode)}</td>
								<td class="py-2 pr-4 text-[var(--color-tron-text-secondary)]">{fmt(ch.sd)}</td>
								<td class="py-2 pr-4 text-[var(--color-tron-cyan)]">{band(ch.bandLow, ch.bandHigh)}</td>
								<td class="py-2 pr-4 {cvClass(ch.cv)}"
									>{ch.cv == null ? '—' : `${ch.cv.toFixed(0)}%`}</td
								>
								<td class="py-2 text-[var(--color-tron-text-secondary)]">{ch.n}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>

		<!-- Per-cartridge ratios -->
		<div class="tron-card p-4">
			<h2 class="tron-heading mb-3 text-sm font-semibold uppercase tracking-wide">
				Per-cartridge F7/F3
			</h2>
			<div class="overflow-x-auto">
				<table class="w-full min-w-[36rem] text-left text-sm">
					<thead
						class="text-xs uppercase tracking-wide text-[var(--color-tron-text-secondary)]"
					>
						<tr class="border-b border-[var(--color-tron-border)]">
							<th class="py-2 pr-4 font-medium">Barcode</th>
							<th class="py-2 pr-4 font-medium">A</th>
							<th class="py-2 pr-4 font-medium">B</th>
							<th class="py-2 font-medium">C</th>
						</tr>
					</thead>
					<tbody class="font-mono">
						{#each group!.cartridges as cart (cart.id)}
							<tr
								class="border-b border-[var(--color-tron-border)]/50 {cart.warning
									? 'bg-amber-500/10'
									: ''}"
							>
								<td class="py-2 pr-4">
									<a
										href="../{cart.id}"
										class="text-[var(--color-tron-cyan)] hover:underline">{cart.label}</a
									>
								</td>
								{#each CHANNELS as c}
									{@const outlier = cart.outlierChannels.includes(c)}
									<td
										class="py-2 pr-4 {outlier
											? 'text-amber-400'
											: 'text-[var(--color-tron-text-primary)]'}"
									>
										{fmt(cart.ratioByChannel[c])}{outlier ? ' ⚠' : ''}
									</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>

		<!-- Footer note -->
		<p class="text-xs text-[var(--color-tron-text-secondary)]">
			Stats use the endpoint window (last {group!.windowK} readings per channel). In-range band =
			mean ± 1σ across cartridges. Derived, non-destructive — cartridge records are never modified.
		</p>
	{/if}
</div>
