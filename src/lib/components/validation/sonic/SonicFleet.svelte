<!--
	Sonic Fleet check (2026-10-06): the quick view on the compare page. The run is
	cut into fixed intervals; per interval the fleet mean ± K·σ is a band, and
	each unit fits or falls outside it. Worst first, then the chart and the grid.
	Everything is computed on the server (sonic/fleet.ts fleetView).
-->
<script lang="ts">
	import SonicChart, { type ChartSeries } from './SonicChart.svelte';
	import { sonicColor } from './palette';

	interface FleetUnit {
		scored: number;
		inside: number;
		insidePct: number | null;
		fits: boolean | null;
		worst: { index: number; z: number } | null;
	}
	interface Props {
		fleet: {
			metric: { key: string; label: string; unit: string };
			shapeOnly: boolean;
			intervalS: number;
			k: number;
			minInsidePct: number;
			series: (number | null)[][];
			units: FleetUnit[];
			band: { mu: (number | null)[]; sd: (number | null)[]; k: number };
			intervals: { a: number; b: number; mean: number | null; sd: number | null; values: (number | null)[]; inside: (boolean | null)[]; z: (number | null)[] }[];
		};
		items: { id: string; label: string; offset: number }[];
		t: number[];
		window: [number, number];
		tickS: number;
	}
	let { fleet, items, t, window, tickS }: Props = $props();

	const unit = $derived(fleet.metric.unit);
	const fmt = (v: number | null) => (v == null ? '—' : unit === 'Hz' ? `${Math.round(v)}` : v.toFixed(1));
	/** Worst first: lowest % of intervals inside. */
	const ranked = $derived(
		fleet.units.map((u, i) => ({ ...u, i })).sort((a, b) => (a.insidePct ?? 101) - (b.insidePct ?? 101))
	);
	const outCount = $derived(fleet.units.filter((u) => u.fits === false).length);
	let focus = $state<string | null>(null);
	const series = $derived<ChartSeries[]>(
		items.map((it, i) => ({ label: it.label, color: sonicColor(i), values: fleet.series[i], width: fleet.units[i]?.fits === false ? 2.5 : 1.25 }))
	);
	/** Interval a–b in the unit's own recording time, for listening. */
	const own = (sec: number, i: number) => Math.max(0, Math.round(sec + (items[i]?.offset ?? 0)));
</script>

<div class="tron-card p-4">
	<h2 class="tron-heading mb-1 text-sm font-semibold uppercase tracking-wide">
		{fleet.metric.label}{fleet.shapeOnly ? ' shape' : ''} · {fleet.intervals.length} intervals of {fleet.intervalS} s · mean ± {fleet.k}σ ·
		<span class={outCount ? 'text-[var(--color-tron-red)]' : 'text-[var(--color-tron-green)]'}>{outCount} outside the fleet</span>
	</h2>
	<p class="tron-text-muted mb-3 text-xs">
		A unit fits when at least {fleet.minInsidePct}% of its intervals are inside the band.
		{#if fleet.shapeOnly}Each recording's overall level was removed first, so phone distance does not count — only how the loudness rises and falls.{/if}
		Worst first; click a unit to highlight it on the chart. "Furthest out" times are in that unit's own recording.
	</p>
	<div class="overflow-x-auto">
		<table class="w-full text-sm">
			<thead class="text-[10px] uppercase text-[var(--color-tron-text-secondary)]">
				<tr class="border-b border-[var(--color-tron-border)] text-left">
					<th class="py-1 pr-4 font-medium">Unit</th>
					<th class="py-1 pr-4 font-medium">Result</th>
					<th class="py-1 pr-4 font-medium">Intervals inside</th>
					<th class="py-1 pr-4 font-medium">Furthest out</th>
					<th class="py-1 font-medium">Recording</th>
				</tr>
			</thead>
			<tbody>
				{#each ranked as u (items[u.i].id)}
					{@const it = items[u.i]}
					<tr
						class="cursor-pointer border-b border-[var(--color-tron-border)]/50 hover:bg-[var(--color-tron-bg-secondary)]/40 {focus === it.label ? 'bg-[var(--color-tron-bg-secondary)]/60' : ''}"
						onclick={() => (focus = focus === it.label ? null : it.label)}
					>
						<td class="py-1.5 pr-4 font-mono font-bold"><span class="mr-2 inline-block h-2.5 w-2.5 rounded-full align-middle" style="background: {sonicColor(u.i)}"></span>{it.label}</td>
						<td class="py-1.5 pr-4">
							{#if u.fits == null}
								<span class="tron-text-muted text-xs">no data</span>
							{:else}
								<span
									class="rounded-full px-2 py-0.5 text-xs font-bold uppercase"
									style={u.fits ? 'color: var(--color-tron-green); background: rgba(0,255,100,0.12);' : 'color: var(--color-tron-red); background: rgba(255,0,0,0.12);'}
								>{u.fits ? 'fits' : 'outside'}</span>
							{/if}
						</td>
						<td class="py-1.5 pr-4 font-mono">{u.inside}/{u.scored}{u.insidePct != null ? ` (${u.insidePct}%)` : ''}</td>
						<td class="py-1.5 pr-4 font-mono text-xs">
							{#if u.worst}
								{@const iv = fleet.intervals[u.worst.index]}
								{own(iv.a, u.i)}–{own(iv.b, u.i)} s: {fmt(iv.values[u.i])} {unit} vs {fmt(iv.mean)} ({u.worst.z > 0 ? '+' : ''}{u.worst.z.toFixed(1)}σ)
							{:else}—{/if}
						</td>
						<td class="py-1.5 text-xs"><a href="/validation/sonic/{it.id}" class="text-[var(--color-tron-cyan)] hover:underline" onclick={(e) => e.stopPropagation()}>Listen →</a></td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>

<div class="tron-card p-4">
	<SonicChart
		x={t}
		xDomain={window}
		{tickS}
		{series}
		band={fleet.band}
		{focus}
		tooltip
		title="{fleet.metric.label}{fleet.shapeOnly ? ' shape' : ''} over time — grey band = fleet mean ± {fleet.k}σ per {fleet.intervalS} s interval"
		yLabel={unit}
		fmt={(v) => fmt(v)}
	/>
</div>

<div class="tron-card p-4">
	<h2 class="tron-heading mb-1 text-sm font-semibold uppercase tracking-wide">Per interval</h2>
	<p class="tron-text-muted mb-3 text-xs">Each cell is the unit's average in that interval. Red = outside mean ± {fleet.k}σ. Times are in the first recording's clock.</p>
	<div class="overflow-x-auto">
		<table class="text-xs">
			<thead class="text-[10px] text-[var(--color-tron-text-secondary)]">
				<tr>
					<th class="sticky left-0 bg-[var(--color-tron-bg-primary)] py-1 pr-3 text-left font-medium">Interval (s)</th>
					{#each fleet.intervals as iv, j (j)}<th class="px-1.5 py-1 text-right font-mono font-normal whitespace-nowrap">{iv.a}–{iv.b}</th>{/each}
				</tr>
			</thead>
			<tbody class="font-mono">
				{#each items as it, i (it.id)}
					<tr class="border-t border-[var(--color-tron-border)]/40">
						<td class="sticky left-0 bg-[var(--color-tron-bg-primary)] py-0.5 pr-3 font-bold whitespace-nowrap">{it.label}</td>
						{#each fleet.intervals as iv, j (j)}
							<td
								class="px-1.5 py-0.5 text-right {iv.inside[i] === false ? 'text-[var(--color-tron-red)]' : iv.inside[i] ? 'tron-text-primary' : 'tron-text-muted'}"
								style={iv.inside[i] === false ? 'background: rgba(255,0,0,0.12);' : ''}
								title={iv.z[i] == null ? '' : `${iv.z[i]! > 0 ? '+' : ''}${iv.z[i]}σ`}
							>{fmt(iv.values[i])}</td>
						{/each}
					</tr>
				{/each}
				<tr class="border-t-2 border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]">
					<td class="sticky left-0 bg-[var(--color-tron-bg-primary)] py-0.5 pr-3 whitespace-nowrap">Fleet mean</td>
					{#each fleet.intervals as iv, j (j)}<td class="px-1.5 py-0.5 text-right">{fmt(iv.mean)}</td>{/each}
				</tr>
				<tr class="text-[var(--color-tron-text-secondary)]">
					<td class="sticky left-0 bg-[var(--color-tron-bg-primary)] py-0.5 pr-3 whitespace-nowrap">σ</td>
					{#each fleet.intervals as iv, j (j)}<td class="px-1.5 py-0.5 text-right">{iv.sd == null ? '—' : unit === 'Hz' ? Math.round(iv.sd) : iv.sd.toFixed(1)}</td>{/each}
				</tr>
			</tbody>
		</table>
	</div>
</div>
