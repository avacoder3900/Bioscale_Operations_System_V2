<script lang="ts">
	import { goto } from '$app/navigation';

	interface Output {
		channel: string;
		scanGroupLabel: string;
		scanGroupIndex: number;
		column: string;
		value: number;
	}

	interface ScanGroup {
		label: string;
		scanRange: string;
		scanCount: number;
		channels: Record<string, { sums: Record<string, number>; ratios: Record<string, number> }>;
	}

	interface Analysis {
		profileId: string;
		profileName: string;
		computedAt: string;
		computedBy: string;
		scanGroups: ScanGroup[];
		outputs: Output[];
	}

	interface Props {
		data: {
			barcode: string;
			assayName: string | null;
			status: string;
			spuUdi: string | null;
			completedAt: string | null;
			liveAnalysis: Analysis | null;
			storedAnalysis: Analysis | null;
			profiles: { id: string; name: string; description: string }[];
			selectedProfileId: string | null;
			readings: any[];
			rawData: any;
		};
	}

	let { data }: Props = $props();

	let showAllReadings = $state(false);

	const READING_COLS = ['number', 'channel', 'position', 'temperature', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'clear', 'nir'] as const;

	let visibleReadings = $derived(showAllReadings ? data.readings : data.readings.slice(0, 30));

	// Output grid: rows = channel (× scan group when a profile outputs several),
	// columns = the profile's configured output columns.
	let outputs = $derived(data.liveAnalysis?.outputs ?? []);
	let outCols = $derived([...new Set(outputs.map(o => o.column))]);
	let outRows = $derived.by(() => {
		const seen = new Map<string, { channel: string; group: string; gi: number }>();
		for (const o of outputs) {
			const k = `${o.channel}|${o.scanGroupIndex}`;
			if (!seen.has(k)) seen.set(k, { channel: o.channel, group: o.scanGroupLabel, gi: o.scanGroupIndex });
		}
		return [...seen.values()];
	});
	let multiGroup = $derived(new Set(outRows.map(r => r.gi)).size > 1);

	function outVal(row: { channel: string; gi: number }, col: string): number | null {
		return outputs.find(o => o.channel === row.channel && o.scanGroupIndex === row.gi && o.column === col)?.value ?? null;
	}

	function fmtVal(col: string, v: number | null): string {
		if (v == null) return '—';
		return col.includes('/') ? v.toFixed(3) : Math.round(v).toLocaleString();
	}

	// Headline: the profile's first ratio column (e.g. f7/f3) per channel
	let headlineCol = $derived(outCols.find(c => c.includes('/')) ?? null);

	function fmtDate(d: string | null): string {
		return d ? new Date(d).toLocaleString() : '—';
	}

	function onProfileChange(e: Event) {
		const id = (e.currentTarget as HTMLSelectElement).value;
		goto(`?profile=${encodeURIComponent(id)}`, { noScroll: true, keepFocus: true });
	}

	let storedRatios = $derived(
		(data.storedAnalysis?.outputs ?? []).filter(o => o.column.includes('/'))
	);
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-start justify-between">
		<div>
			<h1 class="tron-heading font-mono text-2xl font-bold">{data.barcode}</h1>
			<p class="tron-text-muted mt-1">
				{data.assayName ?? 'Optical test cartridge'}
				{#if data.spuUdi}&nbsp;· ran on {data.spuUdi}{/if}
				{#if data.completedAt}&nbsp;· completed {fmtDate(data.completedAt)}{/if}
			</p>
		</div>
		<span class="rounded-full bg-[var(--color-tron-bg-tertiary)] px-3 py-1 text-xs font-medium capitalize">{data.status}</span>
	</div>

	{#if data.readings.length === 0}
		<div class="tron-card p-6">
			<p class="tron-text-muted">No run data yet — this cartridge has no readings. The analysis appears here automatically once the device completes the run.</p>
		</div>
	{:else if data.liveAnalysis}
		<!-- Research-engine analysis -->
		<div class="tron-card">
			<div class="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-tron-border)] p-4">
				<div>
					<h2 class="tron-heading text-lg font-semibold">Analysis — {data.liveAnalysis.profileName}</h2>
					<p class="tron-text-muted mt-0.5 text-xs">
						Research-app engine, computed live ·
						{#each data.liveAnalysis.scanGroups as g, i (i)}
							{i > 0 ? ' · ' : ''}{g.label}: scans {g.scanRange}
						{/each}
						· {data.readings.length} readings
					</p>
				</div>
				<label class="flex items-center gap-2 text-sm">
					<span class="tron-text-muted text-xs">Profile</span>
					<select class="tron-input rounded-lg px-3 py-1.5 text-sm" onchange={onProfileChange}>
						{#each data.profiles as p (p.id)}
							<option value={p.id} selected={p.id === data.selectedProfileId}>{p.name}</option>
						{/each}
					</select>
				</label>
			</div>

			{#if headlineCol}
				<div class="flex flex-wrap gap-4 p-4">
					{#each outRows as row (`${row.channel}|${row.gi}`)}
						<div class="min-w-28 rounded-lg bg-[var(--color-tron-bg-tertiary)] p-4 text-center">
							<span class="tron-text-muted block text-xs uppercase">Well {row.channel}{#if multiGroup}&nbsp;· {row.group}{/if}</span>
							<span class="tron-heading text-3xl font-bold">{fmtVal(headlineCol, outVal(row, headlineCol))}</span>
							<span class="tron-text-muted block text-xs uppercase">{headlineCol}</span>
						</div>
					{/each}
				</div>
			{/if}

			<div class="overflow-x-auto border-t border-[var(--color-tron-border)]">
				<table class="w-full text-sm">
					<thead class="text-left text-[var(--color-tron-text-secondary)]">
						<tr class="border-b border-[var(--color-tron-border)]">
							<th class="p-3 font-medium">Well</th>
							{#if multiGroup}<th class="p-3 font-medium">Scan group</th>{/if}
							{#each outCols as col (col)}
								<th class="p-3 font-medium uppercase">{col}</th>
							{/each}
						</tr>
					</thead>
					<tbody class="divide-y divide-[var(--color-tron-border)]">
						{#each outRows as row (`${row.channel}|${row.gi}`)}
							<tr>
								<td class="tron-heading p-3 font-medium">{row.channel}</td>
								{#if multiGroup}<td class="tron-text-muted p-3">{row.group}</td>{/if}
								{#each outCols as col (col)}
									<td class="p-3 {col === headlineCol ? 'tron-heading font-medium' : ''}">{fmtVal(col, outVal(row, col))}</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			{#if data.storedAnalysis}
				<div class="border-t border-[var(--color-tron-border)] px-4 py-3">
					<p class="tron-text-muted text-xs">
						Stored research-app result: <span class="tron-heading font-medium">{data.storedAnalysis.profileName}</span>
						· computed {fmtDate(data.storedAnalysis.computedAt)} by {data.storedAnalysis.computedBy}
						{#if storedRatios.length > 0}
							·
							{#each storedRatios as o, i (i)}
								{i > 0 ? ' · ' : ''}{o.channel} {o.column}={o.value.toFixed(3)}
							{/each}
						{/if}
					</p>
				</div>
			{/if}
			<p class="tron-text-muted border-t border-[var(--color-tron-border)] px-4 py-2 text-xs">
				F3 = 480 nm reference · F7 = 630 nm signal · Same engine + profiles as the research app · Derived, non-destructive — the cartridge record is never modified.
			</p>
		</div>

		<!-- Per-scan-group sums (full engine detail) -->
		<div class="tron-card">
			<div class="border-b border-[var(--color-tron-border)] p-4">
				<h2 class="tron-heading text-lg font-semibold">Scan-group detail</h2>
			</div>
			{#each data.liveAnalysis.scanGroups as group (group.label)}
				{@const chans = Object.entries(group.channels)}
				{@const sumCols = chans.length > 0 ? Object.keys(chans[0][1].sums) : []}
				{@const ratioCols = [...new Set(chans.flatMap(([, c]) => Object.keys(c.ratios)))]}
				<div class="border-b border-[var(--color-tron-border)] last:border-b-0">
					<p class="tron-text-muted px-4 pt-3 text-xs font-medium uppercase">{group.label} — scans {group.scanRange} ({group.scanCount} per channel)</p>
					<div class="overflow-x-auto">
						<table class="w-full text-sm">
							<thead class="text-left text-[var(--color-tron-text-secondary)]">
								<tr class="border-b border-[var(--color-tron-border)]">
									<th class="p-3 font-medium">Well</th>
									{#each sumCols as col (col)}
										<th class="p-3 font-medium uppercase">Σ{col}</th>
									{/each}
									{#each ratioCols as col (col)}
										<th class="p-3 font-medium uppercase">{col}</th>
									{/each}
								</tr>
							</thead>
							<tbody class="divide-y divide-[var(--color-tron-border)]">
								{#each chans as [ch, c] (ch)}
									<tr>
										<td class="tron-heading p-3 font-medium">{ch}</td>
										{#each sumCols as col (col)}
											<td class="p-3">{Math.round(c.sums[col] ?? 0).toLocaleString()}</td>
										{/each}
										{#each ratioCols as col (col)}
											<td class="tron-heading p-3 font-medium">{c.ratios[col] != null ? c.ratios[col].toFixed(3) : '—'}</td>
										{/each}
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</div>
			{/each}
		</div>

		<!-- Raw readings -->
		<div class="tron-card">
			<div class="flex items-center justify-between border-b border-[var(--color-tron-border)] p-4">
				<h2 class="tron-heading text-lg font-semibold">Raw readings ({data.readings.length})</h2>
				{#if data.readings.length > 30}
					<button
						type="button"
						onclick={() => showAllReadings = !showAllReadings}
						class="rounded-lg bg-[var(--color-tron-bg-tertiary)] px-3 py-1.5 text-xs font-medium text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]"
					>
						{showAllReadings ? 'Show first 30' : `Show all ${data.readings.length}`}
					</button>
				{/if}
			</div>
			<div class="max-h-[32rem] overflow-auto">
				<table class="w-full text-xs">
					<thead class="sticky top-0 bg-[var(--color-tron-bg-secondary)] text-left text-[var(--color-tron-text-secondary)]">
						<tr class="border-b border-[var(--color-tron-border)]">
							{#each READING_COLS as col (col)}
								<th class="p-2 font-medium">{col}</th>
							{/each}
						</tr>
					</thead>
					<tbody class="divide-y divide-[var(--color-tron-border)]">
						{#each visibleReadings as r, i (i)}
							<tr>
								{#each READING_COLS as col (col)}
									<td class="p-2 {col === 'f3' || col === 'f7' ? 'tron-heading font-medium' : 'text-[var(--color-tron-text-secondary)]'}">{r[col] ?? '—'}</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{/if}

	<!-- Full raw document -->
	<details class="tron-card p-4">
		<summary class="tron-text-muted cursor-pointer text-sm hover:text-[var(--color-tron-cyan)]">Full raw data (JSON)</summary>
		<pre class="mt-3 max-h-96 overflow-auto rounded-lg bg-[var(--color-tron-bg-tertiary)] p-4 text-xs">{JSON.stringify(data.rawData, null, 2)}</pre>
	</details>

	<a href="/validation/optical-confirmation" class="inline-block text-sm text-[var(--color-tron-cyan)] hover:underline">← Optical Test Cartridge Log</a>
</div>
