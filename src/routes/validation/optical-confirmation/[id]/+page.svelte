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
		data: {
			cartridge: Record<string, unknown>;
			analysis: CartridgeAnalysis | null;
			kind: 'scan' | 'photobleach' | null;
			photobleach: {
				sweeps: number;
				chunkedFallback: boolean;
				channels: Array<{
					channel: 'A' | 'B' | 'C';
					points: Array<{ sweep: number; ratio: number | null; sd: number | null; n: number; tSec: number | null }>;
					first: number | null; last: number | null; dropPct: number | null;
					slopePctPerSweep: number | null; residualCv: number | null; maxStepPct: number | null;
				}>;
			} | null;
		};
	}
	let { data }: Props = $props();

	const analysis = $derived(data.analysis);
	const pb = $derived(data.photobleach);
	const PB_COLOR: Record<'A' | 'B' | 'C', string> = {
		A: 'var(--color-tron-cyan)',
		B: 'var(--color-tron-orange)',
		C: 'var(--color-tron-purple)'
	};
	// Inline SVG trace: ratio vs sweep, one line per channel.
	const PBW = 720, PBH = 240, PBP = { l: 48, r: 16, t: 16, b: 32 };
	const pbChart = $derived.by(() => {
		if (!pb) return null;
		const vals = pb.channels.flatMap((c) => c.points.map((p) => p.ratio)).filter((v): v is number => v != null);
		if (vals.length < 2) return null;
		const lo = Math.min(...vals), hi = Math.max(...vals);
		const pad = (hi - lo || 1) * 0.1;
		const y0 = lo - pad, y1 = hi + pad;
		const n = pb.sweeps;
		const x = (s: number) => PBP.l + ((s - 1) / Math.max(1, n - 1)) * (PBW - PBP.l - PBP.r);
		const y = (v: number) => PBP.t + (1 - (v - y0) / (y1 - y0)) * (PBH - PBP.t - PBP.b);
		const ticks = Array.from({ length: 5 }, (_, i) => y0 + ((y1 - y0) * i) / 4);
		return {
			n, x, y, ticks,
			lines: pb.channels.map((c) => ({
				channel: c.channel,
				d: c.points.filter((p) => p.ratio != null).map((p, i) => `${i ? 'L' : 'M'}${x(p.sweep).toFixed(1)},${y(p.ratio!).toFixed(1)}`).join(' '),
				dots: c.points.filter((p) => p.ratio != null).map((p) => ({ cx: x(p.sweep), cy: y(p.ratio!), sweep: p.sweep, ratio: p.ratio!, sd: p.sd, t: p.tSec }))
			}))
		};
	});
	function pct(v: number | null | undefined, dp = 1): string { return v == null ? '—' : `${v.toFixed(dp)}%`; }
	const hasReadings = $derived(!!analysis && analysis.channels.length > 0);
	const windowK = $derived(analysis?.windowK ?? 0);
	const windowLabel = $derived(windowK > 0 ? `the last ${windowK} readings (endpoint window)` : 'every reading per channel (all scan positions)');

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

	{#if pb}
		<!-- Photobleach: one point per channel per sweep -->
		<div class="tron-card p-4">
			<div class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
				<h2 class="tron-heading text-sm font-semibold uppercase tracking-wide">Optical degradation trace — {pb.sweeps} sweeps</h2>
				<span class="text-xs text-[var(--color-tron-text-secondary)]">
					Same cartridge, same position, ~30 s apart. Each point = mean F7/F3 over that sweep's positions.
					{#if pb.chunkedFallback}Sweep boundaries could not be read from the stage position — readings chunked by 10.{/if}
				</span>
			</div>
			<div class="overflow-x-auto">
				<table class="w-full text-xs">
					<thead class="text-[10px] uppercase text-[var(--color-tron-text-secondary)]">
						<tr class="border-b border-[var(--color-tron-border)]">
							<th class="py-1 pr-3 text-left font-medium">Channel</th>
							<th class="py-1 pr-3 text-left font-medium">First</th>
							<th class="py-1 pr-3 text-left font-medium">Last</th>
							<th class="py-1 pr-3 text-left font-medium" title="(last − first) / first">Drop</th>
							<th class="py-1 pr-3 text-left font-medium" title="Least-squares slope, % of the first sweep per sweep">Slope / sweep</th>
							<th class="py-1 pr-3 text-left font-medium" title="CV of residuals around the fitted line — the noise. A smooth bleach is low; jumps point at the instrument.">Noise (resid. CV)</th>
							<th class="py-1 text-left font-medium" title="Largest jump between consecutive sweeps, % of the mean">Max step</th>
						</tr>
					</thead>
					<tbody class="font-mono tron-text-primary">
						{#each pb.channels as c (c.channel)}
							<tr class="border-b border-[var(--color-tron-border)]/50">
								<td class="py-1 pr-3"><span class="mr-1 inline-block h-2 w-2 rounded-full align-middle" style="background: {PB_COLOR[c.channel]}"></span>{c.channel}</td>
								<td class="py-1 pr-3">{c.first?.toFixed(3) ?? '—'}</td>
								<td class="py-1 pr-3">{c.last?.toFixed(3) ?? '—'}</td>
								<td class="py-1 pr-3 {c.dropPct != null && c.dropPct > 0 ? 'text-amber-400' : ''}">{pct(c.dropPct)}</td>
								<td class="py-1 pr-3">{pct(c.slopePctPerSweep, 2)}</td>
								<td class="py-1 pr-3 {c.residualCv != null && c.residualCv > 5 ? 'text-amber-400' : ''}">{pct(c.residualCv)}</td>
								<td class="py-1">{pct(c.maxStepPct)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#if pbChart}
				<div class="mt-3 overflow-x-auto">
					<svg viewBox="0 0 {PBW} {PBH}" class="w-full min-w-[36rem]" role="img" aria-label="F7/F3 per sweep, one line per channel">
						{#each pbChart.ticks as t}
							<line x1={PBP.l} x2={PBW - PBP.r} y1={pbChart.y(t)} y2={pbChart.y(t)} stroke="var(--color-tron-border)" />
							<text x={PBP.l - 6} y={pbChart.y(t) + 3} text-anchor="end" font-size="10" font-family="monospace" fill="var(--color-tron-text-secondary)">{t.toFixed(2)}</text>
						{/each}
						{#each Array.from({ length: pbChart.n }, (_, i) => i + 1) as s}
							<text x={pbChart.x(s)} y={PBH - 12} text-anchor="middle" font-size="10" font-family="monospace" fill="var(--color-tron-text-secondary)">{s}</text>
						{/each}
						<text x={(PBP.l + PBW - PBP.r) / 2} y={PBH - 1} text-anchor="middle" font-size="10" fill="var(--color-tron-text-secondary)">sweep</text>
						{#each pbChart.lines as l (l.channel)}
							<path d={l.d} fill="none" stroke={PB_COLOR[l.channel]} stroke-width="2" />
							{#each l.dots as d (d.sweep)}
								<circle cx={d.cx} cy={d.cy} r="4" fill={PB_COLOR[l.channel]} stroke="var(--color-tron-bg-card)" stroke-width="1.5">
									<title>{l.channel} · sweep {d.sweep} · {d.ratio.toFixed(3)}{d.sd != null ? ` ± ${d.sd.toFixed(3)}` : ''}{d.t != null ? ` · t = ${d.t.toFixed(0)} s` : ''}</title>
								</circle>
							{/each}
						{/each}
					</svg>
				</div>
				<div class="mt-1 flex gap-4 text-xs text-[var(--color-tron-text-secondary)]">
					{#each pb.channels as c (c.channel)}
						<span><span class="mr-1 inline-block h-2.5 w-2.5 rounded-full align-middle" style="background: {PB_COLOR[c.channel]}"></span>{c.channel}</span>
					{/each}
				</div>
			{/if}
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
				· stats over {windowLabel}
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
		F3 = 480 nm reference · F7 = 630 nm signal · stats over {windowLabel} · in-range band = mean ±
		1σ · flags: CV>15%, point z>2σ, cross-channel CV>15% ·
		Derived, non-destructive — the record is never modified.
	</p>
</div>
