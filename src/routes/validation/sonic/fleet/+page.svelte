<script lang="ts">
	import { goto } from '$app/navigation';
	import SonicChart, { type ChartSeries } from '$lib/components/validation/sonic/SonicChart.svelte';
	import { sonicColor } from '$lib/components/validation/sonic/palette';

	let { data } = $props();

	// ── controls (seeded from the URL, re-seeded on navigation) ───────────────
	const fromUrl = () => ({
		assay: data.params.assay ?? '',
		metric: data.params.metric as string,
		intervalS: data.params.intervalS,
		k: data.params.k,
		minInsidePct: data.params.minInsidePct,
		picked: Object.fromEntries(data.params.spus.map((u: string) => [u, true])) as Record<string, boolean>
	});
	let ctl = $state(fromUrl());
	$effect.pre(() => {
		ctl = fromUrl();
	});

	const devices = $derived(data.available.filter((a: { assay: string }) => a.assay === ctl.assay));
	const pickedUdis = $derived(devices.filter((d: { spuUdi: string }) => ctl.picked[d.spuUdi]).map((d: { spuUdi: string }) => d.spuUdi));

	function setAll(on: boolean) {
		ctl.picked = Object.fromEntries(devices.map((d: { spuUdi: string }) => [d.spuUdi, on]));
	}
	function run() {
		const q = new URLSearchParams({
			assay: ctl.assay,
			spus: pickedUdis.join(','),
			metric: ctl.metric,
			interval: String(ctl.intervalS),
			k: String(ctl.k),
			min: String(ctl.minInsidePct)
		});
		goto(`/validation/sonic/fleet?${q}`);
	}

	const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '—');
	const fmt = (v: number | null, unit: string) => (v == null ? '—' : unit === 'Hz' ? `${Math.round(v)}` : v.toFixed(1));

	// ── results ───────────────────────────────────────────────────────────────
	const res = $derived(data.result);
	/** Worst first: units that do not fit, then by % inside ascending. */
	const ranked = $derived(
		res ? res.units.map((u: any, i: number) => ({ ...u, i })).sort((a: any, b: any) => (a.insidePct ?? 101) - (b.insidePct ?? 101)) : []
	);
	const outCount = $derived(res ? res.units.filter((u: any) => u.fits === false).length : 0);
	let focus = $state<string | null>(null);
	const chartSeries = $derived<ChartSeries[]>(
		res ? res.units.map((u: any, i: number) => ({ label: u.short, color: sonicColor(i), values: u.series, width: u.fits === false ? 2.5 : 1.25 })) : []
	);
</script>

<div class="space-y-6">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<h1 class="tron-heading text-2xl font-bold">Sonic — Fleet Comparison</h1>
			<p class="tron-text-muted mt-1 max-w-3xl text-sm">
				Pick the devices and what to compare. Each device uses its latest analyzed recording. The run is
				cut into fixed intervals; in each one the fleet's mean and standard deviation are taken, and a
				device fits that interval when it is inside mean ± K·σ. A device fits the fleet when enough of
				its intervals fit.
			</p>
		</div>
		<a href="/validation/sonic/compare" class="text-sm text-[var(--color-tron-cyan)] hover:underline">Detailed section compare →</a>
	</div>

	<!-- Controls -->
	<div class="tron-card space-y-4 p-4">
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
			<label class="block">
				<span class="tron-label">Assay</span>
				<select class="tron-select w-full" bind:value={ctl.assay} style="min-height: 44px;">
					{#each data.assays as a (a)}<option value={a}>{a}</option>{/each}
				</select>
			</label>
			<label class="block">
				<span class="tron-label">Compare</span>
				<select class="tron-select w-full" bind:value={ctl.metric} style="min-height: 44px;">
					{#each data.metrics as m (m.key)}<option value={m.key}>{m.label} ({m.unit})</option>{/each}
				</select>
			</label>
			<label class="block">
				<span class="tron-label">Interval (s)</span>
				<input type="number" min="1" max="120" step="1" class="tron-input w-full" bind:value={ctl.intervalS} style="min-height: 44px;" />
			</label>
			<label class="block">
				<span class="tron-label">Band (K·σ)</span>
				<input type="number" min="0.5" max="4" step="0.5" class="tron-input w-full" bind:value={ctl.k} style="min-height: 44px;" />
			</label>
			<label class="block">
				<span class="tron-label">Fits if ≥ % intervals inside</span>
				<input type="number" min="0" max="100" step="5" class="tron-input w-full" bind:value={ctl.minInsidePct} style="min-height: 44px;" />
			</label>
		</div>

		<div>
			<div class="mb-2 flex flex-wrap items-center gap-3">
				<span class="tron-label mb-0">Devices ({pickedUdis.length} of {devices.length})</span>
				<button type="button" class="text-xs text-[var(--color-tron-cyan)] hover:underline" onclick={() => setAll(true)}>All</button>
				<button type="button" class="text-xs text-[var(--color-tron-cyan)] hover:underline" onclick={() => setAll(false)}>None</button>
			</div>
			{#if devices.length === 0}
				<p class="tron-text-muted text-sm">No analyzed recordings for this assay yet.</p>
			{:else}
				<div class="flex flex-wrap gap-2">
					{#each devices as d (d.spuUdi)}
						<label
							class="flex cursor-pointer items-center gap-2 rounded border px-3 py-2 text-sm {ctl.picked[d.spuUdi] ? 'border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]' : 'border-[var(--color-tron-border)] tron-text-muted'}"
							title="Latest recording {when(d.at)}"
						>
							<input type="checkbox" bind:checked={ctl.picked[d.spuUdi]} class="h-4 w-4" />
							{d.short}
						</label>
					{/each}
				</div>
			{/if}
		</div>

		<button
			type="button"
			onclick={run}
			disabled={pickedUdis.length < 3}
			class="rounded-lg bg-[var(--color-tron-cyan)] px-6 py-2 font-semibold text-[var(--color-tron-bg-primary)] disabled:opacity-40"
			style="min-height: 44px;"
		>
			Compare {pickedUdis.length} device{pickedUdis.length === 1 ? '' : 's'}
		</button>
		{#if pickedUdis.length > 0 && pickedUdis.length < 3}
			<span class="tron-text-muted ml-2 text-xs">Pick at least 3.</span>
		{/if}
	</div>

	{#if data.error}
		<div class="rounded-lg bg-[var(--color-tron-red)]/10 p-4 text-sm text-[var(--color-tron-red)]">{data.error}</div>
	{/if}

	{#if res}
		{@const unit = res.metric.unit}
		<!-- Verdict per device -->
		<div class="tron-card p-4">
			<h2 class="tron-heading mb-1 text-sm font-semibold uppercase tracking-wide">
				{res.metric.label} · {res.intervals.length} intervals of {data.params.intervalS} s · mean ± {data.params.k}σ ·
				<span class={outCount ? 'text-[var(--color-tron-red)]' : 'text-[var(--color-tron-green)]'}>{outCount} outside the fleet</span>
			</h2>
			<p class="tron-text-muted mb-3 text-xs">Worst first. Click a device to highlight it on the chart.</p>
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead class="text-[10px] uppercase text-[var(--color-tron-text-secondary)]">
						<tr class="border-b border-[var(--color-tron-border)] text-left">
							<th class="py-1 pr-4 font-medium">Device</th>
							<th class="py-1 pr-4 font-medium">Result</th>
							<th class="py-1 pr-4 font-medium">Intervals inside</th>
							<th class="py-1 pr-4 font-medium">Furthest out</th>
							<th class="py-1 font-medium">Recording</th>
						</tr>
					</thead>
					<tbody>
						{#each ranked as u (u.id)}
							<tr
								class="cursor-pointer border-b border-[var(--color-tron-border)]/50 hover:bg-[var(--color-tron-bg-secondary)]/40 {focus === u.short ? 'bg-[var(--color-tron-bg-secondary)]/60' : ''}"
								onclick={() => (focus = focus === u.short ? null : u.short)}
							>
								<td class="py-1.5 pr-4 font-mono font-bold"><span class="mr-2 inline-block h-2.5 w-2.5 rounded-full align-middle" style="background: {sonicColor(u.i)}"></span>{u.short}</td>
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
										{@const iv = res.intervals[u.worst.index]}
										{iv.a}–{iv.b} s: {fmt(iv.values[u.i], unit)} {unit} vs {fmt(iv.mean, unit)} ({u.worst.z > 0 ? '+' : ''}{u.worst.z.toFixed(1)}σ)
									{:else}—{/if}
								</td>
								<td class="tron-text-muted py-1.5 text-xs"><a href="/validation/sonic/{u.id}" class="hover:underline" onclick={(e) => e.stopPropagation()}>{when(u.at)}</a></td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>

		<!-- Over time, with the fleet band -->
		<div class="tron-card p-4">
			<SonicChart
				x={res.t}
				series={chartSeries}
				band={res.band}
				focus={focus}
				tooltip
				title="{res.metric.label} over time — grey band = fleet mean ± {data.params.k}σ per {data.params.intervalS} s interval"
				yLabel={unit}
				xLabel="seconds (aligned to {res.units[0]?.short})"
				fmt={(v) => fmt(v, unit)}
			/>
		</div>

		<!-- Interval grid -->
		<div class="tron-card p-4">
			<h2 class="tron-heading mb-1 text-sm font-semibold uppercase tracking-wide">Per interval</h2>
			<p class="tron-text-muted mb-3 text-xs">Each cell is the device's average {res.metric.label.toLowerCase()} in that interval. Red = outside mean ± {data.params.k}σ.</p>
			<div class="overflow-x-auto">
				<table class="text-xs">
					<thead class="text-[10px] text-[var(--color-tron-text-secondary)]">
						<tr>
							<th class="sticky left-0 bg-[var(--color-tron-bg-primary)] py-1 pr-3 text-left font-medium">Interval (s)</th>
							{#each res.intervals as iv, j (j)}<th class="px-1.5 py-1 text-right font-mono font-normal whitespace-nowrap">{iv.a}–{iv.b}</th>{/each}
						</tr>
					</thead>
					<tbody class="font-mono">
						{#each res.units as u, i (u.id)}
							<tr class="border-t border-[var(--color-tron-border)]/40">
								<td class="sticky left-0 bg-[var(--color-tron-bg-primary)] py-0.5 pr-3 font-bold whitespace-nowrap">{u.short}</td>
								{#each res.intervals as iv, j (j)}
									<td
										class="px-1.5 py-0.5 text-right {iv.inside[i] === false ? 'text-[var(--color-tron-red)]' : iv.inside[i] ? 'tron-text-primary' : 'tron-text-muted'}"
										style={iv.inside[i] === false ? 'background: rgba(255,0,0,0.12);' : ''}
										title={iv.z[i] == null ? '' : `${iv.z[i]! > 0 ? '+' : ''}${iv.z[i]}σ`}
									>{fmt(iv.values[i], unit)}</td>
								{/each}
							</tr>
						{/each}
						<tr class="border-t-2 border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]">
							<td class="sticky left-0 bg-[var(--color-tron-bg-primary)] py-0.5 pr-3 whitespace-nowrap">Fleet mean</td>
							{#each res.intervals as iv, j (j)}<td class="px-1.5 py-0.5 text-right">{fmt(iv.mean, unit)}</td>{/each}
						</tr>
						<tr class="text-[var(--color-tron-text-secondary)]">
							<td class="sticky left-0 bg-[var(--color-tron-bg-primary)] py-0.5 pr-3 whitespace-nowrap">σ</td>
							{#each res.intervals as iv, j (j)}<td class="px-1.5 py-0.5 text-right">{iv.sd == null ? '—' : unit === 'Hz' ? Math.round(iv.sd) : iv.sd.toFixed(1)}</td>{/each}
						</tr>
					</tbody>
				</table>
			</div>
		</div>
	{/if}
</div>
