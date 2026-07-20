<script lang="ts">
	import * as XLSX from 'xlsx';

	interface Reading {
		timestamp: number;
		temperature: number;
	}

	interface Props {
		accept?: string;
		compact?: boolean;
		onparsed: (payload: { readings: Reading[]; readingsJson: string; fileName: string }) => void;
		onclear?: () => void;
	}

	let { accept = '.csv,.xlsx', compact = false, onparsed, onclear }: Props = $props();

	let fileName = $state('');
	let readingCount = $state(0);
	let parseError = $state('');
	let isDragging = $state(false);
	let hasReadings = $derived(readingCount > 0);

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
				const parsed: Reading[] = [];
				const startTime = Date.now();

				for (let i = 1; i < rows.length; i++) {
					const row = rows[i];
					if (!row || row.length === 0) continue;

					const tempVal = Number(row[tempCol]);
					if (isNaN(tempVal)) continue;

					let ts: number;
					if (timeCol >= 0 && row[timeCol] != null) {
						const timeVal = row[timeCol];
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

				parsed.sort((a, b) => a.timestamp - b.timestamp);
				readingCount = parsed.length;
				onparsed({ readings: parsed, readingsJson: JSON.stringify(parsed), fileName: file.name });
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
		readingCount = 0;
		fileName = '';
		parseError = '';
		onclear?.();
	}
</script>

{#if !hasReadings}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="flex flex-col items-center justify-center rounded-lg border-2 border-dashed transition-colors
			{compact ? 'p-4' : 'p-12'}
			{isDragging
				? 'border-[var(--color-tron-orange)] bg-[var(--color-tron-orange)]/10'
				: 'border-[var(--color-tron-border)] hover:border-[var(--color-tron-cyan)]'}"
		ondrop={handleDrop}
		ondragover={handleDragOver}
		ondragleave={() => isDragging = false}
	>
		{#if !compact}
			<svg class="mb-4 h-12 w-12 text-[var(--color-tron-text-secondary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
			</svg>
		{/if}
		<p class="tron-heading mb-2 {compact ? 'text-sm' : 'text-lg'}">Drop .csv or .xlsx file here</p>
		<p class="tron-text-muted mb-4 text-sm">or click to browse</p>
		<label class="cursor-pointer rounded-lg bg-[var(--color-tron-orange)] font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:bg-[var(--color-tron-orange)]/90 {compact ? 'px-4 py-2 text-sm' : 'px-6 py-3'}" style="min-height: {compact ? '36px' : '44px'}">
			Choose File
			<input type="file" {accept} class="hidden" onchange={handleFileInput} />
		</label>
	</div>
{:else}
	<!-- File loaded -->
	<div class="flex items-center justify-between rounded-lg bg-[var(--color-tron-bg-tertiary)] {compact ? 'p-3' : 'p-4'}">
		<div class="flex items-center gap-3">
			<svg class="{compact ? 'h-6 w-6' : 'h-8 w-8'} text-[var(--color-tron-green)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
			</svg>
			<div>
				<p class="tron-heading font-medium {compact ? 'text-sm' : ''}">{fileName}</p>
				<p class="tron-text-muted text-sm">{readingCount} readings loaded</p>
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
