<script lang="ts">
	import { enhance } from '$app/forms';
	import ThermocoupleChart from '$lib/components/validation/thermocouple/ThermocoupleChart.svelte';
	import * as XLSX from 'xlsx';

	interface Props {
		data: {
			spus: Array<{ id: string; udi: string; status: string; thermoStatus: string | null }>;
			recentSessions: Array<{
				id: string;
				status: string;
				barcode: string | null;
				createdAt: string;
				spuUdi: string | null;
				stats: { min: number; max: number; average: number } | null;
			}>;
		};
		form: {
			success?: boolean;
			error?: string;
			sessionId?: string;
			results?: {
				passed: boolean;
				stats: {
					min: number; max: number; average: number; stdDev: number;
					cv: number; range: number; drift: number;
					readingCount: number; durationMs: number;
				};
				failureReasons: string[];
			};
		} | null;
	}

	let { data, form }: Props = $props();

	// State
	let selectedSpuId = $state('');
	let minTemp = $state(20);
	let maxTemp = $state(40);
	let readings = $state<Array<{ timestamp: number; temperature: number }>>([]);
	let fileName = $state('');
	let parseError = $state('');
	let isDragging = $state(false);
	let showFahrenheit = $state(false);
	let isSubmitting = $state(false);
	let readingsJson = $state('');

	// Computed
	let hasReadings = $derived(readings.length > 0);
	let selectedSpu = $derived(data.spus.find(s => s.id === selectedSpuId));

	// Stats (client-side preview)
	let stats = $derived.by(() => {
		if (readings.length === 0) return null;
		const temps = readings.map(r => r.temperature);
		const min = Math.min(...temps);
		const max = Math.max(...temps);
		const sum = temps.reduce((a, b) => a + b, 0);
		const avg = sum / temps.length;
		const variance = temps.reduce((acc, t) => acc + (t - avg) ** 2, 0) / temps.length;
		const stdDev = Math.sqrt(variance);
		const cv = avg !== 0 ? (stdDev / avg) * 100 : 0;
		const range = max - min;
		const drift = temps.length >= 2 ? temps[temps.length - 1] - temps[0] : 0;
		const durationMs = readings.length >= 2
			? readings[readings.length - 1].timestamp - readings[0].timestamp
			: 0;
		return {
			min, max, average: avg, stdDev, cv, range, drift,
			readingCount: temps.length, durationMs
		};
	});

	// C to F conversion
	function toF(c: number): number { return c * 9 / 5 + 32; }
	function fmtTemp(c: number): string {
		if (showFahrenheit) return toF(c).toFixed(2) + '°F';
		return c.toFixed(2) + '°C';
	}
	function formatDuration(ms: number): string {
		const totalSec = Math.floor(ms / 1000);
		const min = Math.floor(totalSec / 60);
		const sec = totalSec % 60;
		if (min > 0) return `${min}m ${sec}s`;
		return `${sec}s`;
	}
	function formatDate(d: string): string { return new Date(d).toLocaleString(); }

	// File parsing
	function handleFile(file: File) {
		parseError = '';
		fileName = file.name;

		const reader = new FileReader();
		reader.onload = (e) => {
			try {
				const data = new Uint8Array(e.target!.result as ArrayBuffer);
				const wb = XLSX.read(data, { type: 'array' });
				const ws = wb.Sheets[wb.SheetNames[0]];
				const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });

				if (rows.length < 2) {
					parseError = 'File has no data rows';
					return;
				}

				// Find temperature and time columns
				const header = rows[0].map((h: any) => String(h).toLowerCase().trim());
				let tempCol = header.findIndex(h =>
					h.includes('temp') || h.includes('°c') || h.includes('celsius') || h === 'c' || h === 't'
				);
				let timeCol = header.findIndex(h =>
					h.includes('time') || h.includes('timestamp') || h.includes('date') || h.includes('elapsed')
				);

				// Fallback: if no header match, assume col 0 = time, col 1 = temp
				if (tempCol === -1 && rows[0].length >= 2) {
					// Check if first data row has numbers
					const firstDataRow = rows[1];
					if (typeof firstDataRow[1] === 'number' || !isNaN(Number(firstDataRow[1]))) {
						timeCol = 0;
						tempCol = 1;
					} else if (typeof firstDataRow[0] === 'number' || !isNaN(Number(firstDataRow[0]))) {
						tempCol = 0;
						timeCol = -1;
					}
				}
				if (tempCol === -1 && rows[0].length === 1) {
					tempCol = 0;
				}

				if (tempCol === -1) {
					parseError = 'Could not find temperature column. Expected header containing "temp", "°C", "celsius", or "T"';
					return;
				}

				// Parse data rows (skip header)
				const parsed: Array<{ timestamp: number; temperature: number }> = [];
				const startTime = Date.now();

				for (let i = 1; i < rows.length; i++) {
					const row = rows[i];
					if (!row || row.length === 0) continue;

					const tempVal = Number(row[tempCol]);
					if (isNaN(tempVal)) continue;

					let ts: number;
					if (timeCol >= 0 && row[timeCol] != null) {
						const timeVal = row[timeCol];
						// Check if it's an Excel date serial number
						if (typeof timeVal === 'number' && timeVal > 25000 && timeVal < 60000) {
							// Excel date serial
							const excelEpoch = new Date(1899, 11, 30).getTime();
							ts = excelEpoch + timeVal * 86400000;
						} else if (typeof timeVal === 'number' && timeVal > 1000000000000) {
							ts = timeVal; // already ms timestamp
						} else if (typeof timeVal === 'number' && timeVal > 1000000000) {
							ts = timeVal * 1000; // seconds timestamp
						} else if (typeof timeVal === 'number') {
							// Elapsed seconds
							ts = startTime + timeVal * 1000;
						} else if (typeof timeVal === 'string') {
							const d = new Date(timeVal);
							ts = isNaN(d.getTime()) ? startTime + (i - 1) * 1000 : d.getTime();
						} else {
							ts = startTime + (i - 1) * 1000;
						}
					} else {
						// No time column — assume 1 reading per second
						ts = startTime + (i - 1) * 1000;
					}

					parsed.push({ timestamp: ts, temperature: tempVal });
				}

				if (parsed.length === 0) {
					parseError = 'No valid temperature readings found in file';
					return;
				}

				// Sort by timestamp
				parsed.sort((a, b) => a.timestamp - b.timestamp);
				readings = parsed;
				readingsJson = JSON.stringify(parsed);
			} catch (err) {
				parseError = `Failed to parse file: ${err instanceof Error ? err.message : String(err)}`;
			}
		};
		reader.readAsArrayBuffer(file);
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		isDragging = false;
		const file = e.dataTransfer?.files[0];
		if (file) handleFile(file);
	}

	function handleDragOver(e: DragEvent) {
		e.preventDefault();
		isDragging = true;
	}

	function handleFileInput(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (file) handleFile(file);
	}

	function clearFile() {
		readings = [];
		readingsJson = '';
		fileName = '';
		parseError = '';
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="tron-heading text-2xl font-bold">Thermocouple Validation</h1>
			<p class="tron-text-muted mt-1">Upload temperature data from your thermocouple software</p>
		</div>
		<a
			href="/spu/validation/thermocouple/history"
			class="text-sm text-[var(--color-tron-orange)] hover:underline"
		>
			View History →
		</a>
	</div>

	<!-- Success Banner -->
	{#if form?.success && form?.results}
		<div class="rounded-lg border p-4
			{form.results.passed
				? 'border-[var(--color-tron-green)]/30 bg-[var(--color-tron-green)]/10'
				: 'border-[var(--color-tron-red)]/30 bg-[var(--color-tron-red)]/10'}">
			<div class="flex items-center gap-3">
				{#if form.results.passed}
					<svg class="h-8 w-8 text-[var(--color-tron-green)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
					</svg>
					<div>
						<span class="text-lg font-bold text-[var(--color-tron-green)]">Test Passed</span>
						<p class="tron-text-muted text-sm">All readings within acceptable range. SPU updated.</p>
					</div>
				{:else}
					<svg class="h-8 w-8 text-[var(--color-tron-red)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
					</svg>
					<div>
						<span class="text-lg font-bold text-[var(--color-tron-red)]">Test Failed</span>
						<p class="tron-text-muted text-sm">{form.results.failureReasons.join('; ')}</p>
					</div>
				{/if}
			</div>
			{#if form.sessionId}
				<a href="/spu/validation/thermocouple/{form.sessionId}" class="mt-2 inline-block text-sm text-[var(--color-tron-cyan)] hover:underline">
					View full results →
				</a>
			{/if}
		</div>
	{/if}

	{#if form?.error}
		<div class="rounded-lg bg-[var(--color-tron-red)]/10 p-4 text-[var(--color-tron-red)]">
			{form.error}
		</div>
	{/if}

	<form
		method="POST"
		action="?/upload"
		use:enhance={() => {
			isSubmitting = true;
			return async ({ update }) => {
				await update();
				isSubmitting = false;
			};
		}}
	>
		<!-- SPU Selection -->
		<div class="tron-card p-6">
			<h2 class="tron-heading mb-4 text-lg font-semibold">Select SPU</h2>
			<select
				name="spuId"
				bind:value={selectedSpuId}
				class="tron-input w-full rounded-lg px-4 py-3 text-lg"
				required
			>
				<option value="" disabled>Choose an SPU...</option>
				{#each data.spus as spu (spu.id)}
					<option value={spu.id}>
						{spu.udi} — {spu.status}
						{#if spu.thermoStatus}
							(thermo: {spu.thermoStatus})
						{/if}
					</option>
				{/each}
			</select>
			{#if selectedSpu}
				<p class="tron-text-muted mt-2 text-sm">
					Current thermocouple status: <span class="font-medium capitalize">{selectedSpu.thermoStatus ?? 'not tested'}</span>
				</p>
			{/if}
		</div>

		<!-- Temperature Range -->
		<div class="tron-card mt-4 p-6">
			<h2 class="tron-heading mb-4 text-lg font-semibold">Acceptance Criteria</h2>
			<div class="flex items-center gap-4">
				<div class="flex-1">
					<label for="minTemp" class="tron-text-muted mb-1 block text-sm">Min Temp (°C)</label>
					<input
						type="number" id="minTemp" name="minTemp" step="0.1"
						bind:value={minTemp}
						class="tron-input w-full rounded-lg px-4 py-3 text-lg"
					/>
				</div>
				<span class="tron-text-muted mt-6 text-xl">—</span>
				<div class="flex-1">
					<label for="maxTemp" class="tron-text-muted mb-1 block text-sm">Max Temp (°C)</label>
					<input
						type="number" id="maxTemp" name="maxTemp" step="0.1"
						bind:value={maxTemp}
						class="tron-input w-full rounded-lg px-4 py-3 text-lg"
					/>
				</div>
			</div>
		</div>

		<!-- File Upload -->
		<div class="tron-card mt-4 p-6">
			<h2 class="tron-heading mb-4 text-lg font-semibold">Upload Temperature Data</h2>

			{#if !hasReadings}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-12 transition-colors
						{isDragging
							? 'border-[var(--color-tron-orange)] bg-[var(--color-tron-orange)]/10'
							: 'border-[var(--color-tron-border)] hover:border-[var(--color-tron-cyan)]'}"
					ondrop={handleDrop}
					ondragover={handleDragOver}
					ondragleave={() => isDragging = false}
				>
					<svg class="mb-4 h-12 w-12 text-[var(--color-tron-text-secondary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
					</svg>
					<p class="tron-heading mb-2 text-lg">Drop .xlsx file here</p>
					<p class="tron-text-muted mb-4 text-sm">or click to browse</p>
					<label class="cursor-pointer rounded-lg bg-[var(--color-tron-orange)] px-6 py-3 font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:bg-[var(--color-tron-orange)]/90" style="min-height: 44px">
						Choose File
						<input type="file" accept=".xlsx,.xls,.csv" class="hidden" onchange={handleFileInput} />
					</label>
				</div>
			{:else}
				<!-- File loaded -->
				<div class="flex items-center justify-between rounded-lg bg-[var(--color-tron-bg-tertiary)] p-4">
					<div class="flex items-center gap-3">
						<svg class="h-8 w-8 text-[var(--color-tron-green)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
						</svg>
						<div>
							<p class="tron-heading font-medium">{fileName}</p>
							<p class="tron-text-muted text-sm">{readings.length} readings loaded</p>
						</div>
					</div>
					<button type="button" onclick={clearFile} class="tron-text-muted text-sm hover:text-[var(--color-tron-red)]">
						Clear
					</button>
				</div>
			{/if}

			{#if parseError}
				<p class="mt-2 text-sm text-[var(--color-tron-red)]">{parseError}</p>
			{/if}
		</div>

		<!-- Hidden fields for form submission -->
		<input type="hidden" name="readings" value={readingsJson} />

		<!-- Stats Preview + Chart -->
		{#if hasReadings && stats}
			<!-- Unit Toggle -->
			<div class="mt-4 flex justify-end">
				<button
					type="button"
					onclick={() => showFahrenheit = !showFahrenheit}
					class="rounded-lg bg-[var(--color-tron-bg-tertiary)] px-4 py-2 text-sm font-medium text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-cyan)]"
				>
					Show in {showFahrenheit ? '°C' : '°F'}
				</button>
			</div>

			<!-- Stats Grid -->
			<div class="tron-card mt-4 p-6">
				<h2 class="tron-heading mb-4 text-lg font-semibold">Statistics Preview</h2>
				<div class="grid grid-cols-2 gap-4 md:grid-cols-4">
					<div class="rounded-lg bg-[var(--color-tron-bg-tertiary)] p-4 text-center">
						<span class="tron-text-muted block text-xs uppercase">Min</span>
						<span class="tron-heading text-2xl font-bold">{fmtTemp(stats.min)}</span>
					</div>
					<div class="rounded-lg bg-[var(--color-tron-bg-tertiary)] p-4 text-center">
						<span class="tron-text-muted block text-xs uppercase">Max</span>
						<span class="tron-heading text-2xl font-bold">{fmtTemp(stats.max)}</span>
					</div>
					<div class="rounded-lg bg-[var(--color-tron-bg-tertiary)] p-4 text-center">
						<span class="tron-text-muted block text-xs uppercase">Average</span>
						<span class="tron-heading text-2xl font-bold">{fmtTemp(stats.average)}</span>
					</div>
					<div class="rounded-lg bg-[var(--color-tron-bg-tertiary)] p-4 text-center">
						<span class="tron-text-muted block text-xs uppercase">Std Dev</span>
						<span class="tron-heading text-2xl font-bold">{stats.stdDev.toFixed(3)}</span>
					</div>
					<div class="rounded-lg bg-[var(--color-tron-bg-tertiary)] p-4 text-center">
						<span class="tron-text-muted block text-xs uppercase">CV %</span>
						<span class="tron-heading text-2xl font-bold">{stats.cv.toFixed(2)}%</span>
					</div>
					<div class="rounded-lg bg-[var(--color-tron-bg-tertiary)] p-4 text-center">
						<span class="tron-text-muted block text-xs uppercase">Range</span>
						<span class="tron-heading text-2xl font-bold">{fmtTemp(stats.range)}</span>
					</div>
					<div class="rounded-lg bg-[var(--color-tron-bg-tertiary)] p-4 text-center">
						<span class="tron-text-muted block text-xs uppercase">Drift</span>
						<span class="tron-heading text-2xl font-bold">{stats.drift >= 0 ? '+' : ''}{fmtTemp(stats.drift)}</span>
					</div>
					<div class="rounded-lg bg-[var(--color-tron-bg-tertiary)] p-4 text-center">
						<span class="tron-text-muted block text-xs uppercase">Duration</span>
						<span class="tron-heading text-2xl font-bold">{formatDuration(stats.durationMs)}</span>
					</div>
				</div>
			</div>

			<!-- Chart -->
			<div class="mt-4">
				<ThermocoupleChart {readings} {minTemp} {maxTemp} showBands={true} />
			</div>

			<!-- Submit -->
			<div class="mt-6">
				<button
					type="submit"
					disabled={!selectedSpuId || isSubmitting}
					class="flex w-full items-center justify-center gap-3 rounded-lg bg-[var(--color-tron-orange)] px-6 py-4 text-lg font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:bg-[var(--color-tron-orange)]/90 disabled:cursor-not-allowed disabled:opacity-50"
					style="min-height: 44px"
				>
					{#if isSubmitting}
						<svg class="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none">
							<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
							<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
						</svg>
						Saving...
					{:else}
						Save Results to {selectedSpu?.udi ?? 'SPU'}
					{/if}
				</button>
				{#if !selectedSpuId}
					<p class="mt-2 text-center text-sm text-[var(--color-tron-red)]">Select an SPU above before saving</p>
				{/if}
			</div>
		{/if}
	</form>

	<!-- Recent Tests -->
	{#if data.recentSessions.length > 0}
		<div class="tron-card">
			<div class="border-b border-[var(--color-tron-border)] p-4">
				<h2 class="tron-heading text-lg font-semibold">Recent Uploads</h2>
			</div>
			<div class="divide-y divide-[var(--color-tron-border)]">
				{#each data.recentSessions as session (session.id)}
					<a
						href="/spu/validation/thermocouple/{session.id}"
						class="flex items-center justify-between p-4 transition-colors hover:bg-[var(--color-tron-bg-tertiary)]"
					>
						<div>
							<span class="tron-heading font-medium">{session.barcode ?? session.id.slice(0, 8)}</span>
							{#if session.spuUdi}
								<span class="tron-text-muted ml-2 text-sm">({session.spuUdi})</span>
							{/if}
							{#if session.stats}
								<span class="tron-text-muted ml-2 text-sm">
									{session.stats.min.toFixed(1)}°C – {session.stats.max.toFixed(1)}°C (avg {session.stats.average.toFixed(1)}°C)
								</span>
							{/if}
						</div>
						<div class="flex items-center gap-3">
							<span class="tron-text-muted text-sm">{formatDate(session.createdAt)}</span>
							<span class="rounded-full px-2 py-1 text-xs font-medium
								{session.status === 'completed'
									? 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]'
									: session.status === 'failed'
										? 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]'
										: 'bg-[var(--color-tron-text-secondary)]/20 text-[var(--color-tron-text-secondary)]'}">
								{session.status === 'completed' ? 'Passed' : session.status === 'failed' ? 'Failed' : 'Pending'}
							</span>
						</div>
					</a>
				{/each}
			</div>
		</div>
	{/if}
</div>
