<script lang="ts">
	interface ChannelRow {
		channel: string;
		n: number;
		f3Sum: number;
		f5Sum: number;
		f7Sum: number;
		f7f3: number | null;
		f5f3: number | null;
	}

	interface Props {
		data: {
			barcode: string;
			assayName: string | null;
			status: string;
			spuUdi: string | null;
			completedAt: string | null;
			analysis: {
				readingCount: number;
				baselineScans: number | null;
				testScans: number | null;
				scanGroup: 'test' | 'all';
				channels: ChannelRow[];
				allChannels: ChannelRow[];
				ratioByChannel: Record<string, number | null>;
			} | null;
			readings: any[];
			rawData: any;
		};
	}

	let { data }: Props = $props();

	let showAllReadings = $state(false);

	const READING_COLS = ['number', 'channel', 'position', 'temperature', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'clear', 'nir'] as const;

	let visibleReadings = $derived(showAllReadings ? data.readings : data.readings.slice(0, 30));

	function fmt(v: unknown): string {
		if (v == null) return '—';
		if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
		return String(v);
	}

	function fmtDate(d: string | null): string {
		return d ? new Date(d).toLocaleString() : '—';
	}
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

	{#if !data.analysis}
		<div class="tron-card p-6">
			<p class="tron-text-muted">No run data yet — this cartridge has no readings. The analysis appears here automatically once the device completes the run.</p>
		</div>
	{:else}
		<!-- Headline ratios -->
		<div class="tron-card p-6">
			<h2 class="tron-heading mb-1 text-lg font-semibold">Analysis — F7/F3 per channel</h2>
			<p class="tron-text-muted mb-4 text-xs">
				Ratio of summed bands over the
				{data.analysis.scanGroup === 'test'
					? `test scans (readings after the first ${data.analysis.baselineScans} baseline scans)`
					: 'full run (no baseline split recorded)'}
				· {data.analysis.readingCount} readings total
			</p>
			<div class="flex flex-wrap gap-4">
				{#each Object.entries(data.analysis.ratioByChannel) as [ch, ratio] (ch)}
					<div class="min-w-28 rounded-lg bg-[var(--color-tron-bg-tertiary)] p-4 text-center">
						<span class="tron-text-muted block text-xs uppercase">Well {ch}</span>
						<span class="tron-heading text-3xl font-bold">{ratio != null ? ratio.toFixed(1) : '—'}</span>
						<span class="tron-text-muted block text-xs">F7/F3</span>
					</div>
				{/each}
			</div>
		</div>

		<!-- Per-channel table -->
		<div class="tron-card">
			<div class="border-b border-[var(--color-tron-border)] p-4">
				<h2 class="tron-heading text-lg font-semibold">Per-channel sums ({data.analysis.scanGroup === 'test' ? 'test scans' : 'all readings'})</h2>
			</div>
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead class="text-left text-[var(--color-tron-text-secondary)]">
						<tr class="border-b border-[var(--color-tron-border)]">
							<th class="p-3 font-medium">Well</th>
							<th class="p-3 font-medium">F3 sum</th>
							<th class="p-3 font-medium">F5 sum</th>
							<th class="p-3 font-medium">F7 sum</th>
							<th class="p-3 font-medium">F5/F3</th>
							<th class="p-3 font-medium">F7/F3</th>
							<th class="p-3 font-medium">n</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-[var(--color-tron-border)]">
						{#each data.analysis.channels as row (row.channel)}
							<tr>
								<td class="tron-heading p-3 font-medium">{row.channel}</td>
								<td class="p-3">{Math.round(row.f3Sum).toLocaleString()}</td>
								<td class="p-3">{Math.round(row.f5Sum).toLocaleString()}</td>
								<td class="p-3">{Math.round(row.f7Sum).toLocaleString()}</td>
								<td class="p-3">{row.f5f3 != null ? row.f5f3.toFixed(2) : '—'}</td>
								<td class="tron-heading p-3 font-medium">{row.f7f3 != null ? row.f7f3.toFixed(2) : '—'}</td>
								<td class="tron-text-muted p-3">{row.n}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#if data.analysis.scanGroup === 'test'}
				<div class="border-t border-[var(--color-tron-border)] p-4">
					<h3 class="tron-text-muted mb-2 text-xs font-medium uppercase">Whole run (baseline + test), for reference</h3>
					<div class="flex flex-wrap gap-4">
						{#each data.analysis.allChannels as row (row.channel)}
							<span class="text-xs">
								<span class="tron-text-muted">{row.channel}:</span>
								<span class="tron-heading font-medium">{row.f7f3 != null ? row.f7f3.toFixed(2) : '—'}</span>
							</span>
						{/each}
					</div>
				</div>
			{/if}
			<p class="tron-text-muted border-t border-[var(--color-tron-border)] px-4 py-2 text-xs">
				F3 = 480 nm reference · F7 = 630 nm signal · Derived, non-destructive — the cartridge record is never modified.
			</p>
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
									<td class="p-2 {col === 'f3' || col === 'f7' ? 'tron-heading font-medium' : 'text-[var(--color-tron-text-secondary)]'}">{fmt(r[col])}</td>
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
