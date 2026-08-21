<script lang="ts">
	import * as XLSX from 'xlsx';
	import { parseThermoRows } from './parse-thermo';

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
	let columnsNote = $state('');
	let isDragging = $state(false);
	let hasReadings = $derived(readingCount > 0);

	function handleFile(file: File) {
		parseError = '';
		columnsNote = '';
		fileName = file.name;

		const reader = new FileReader();
		reader.onload = (e) => {
			try {
				const data = new Uint8Array(e.target!.result as ArrayBuffer);
				const wb = XLSX.read(data, { type: 'array' });
				const ws = wb.Sheets[wb.SheetNames[0]];
				const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });

				// Column detection + parsing (columns A–C only) lives in
				// parse-thermo.ts so it can be unit-tested against real exports.
				const result = parseThermoRows(rows);
				if (result.error) {
					parseError = result.error;
					return;
				}

				readingCount = result.readings.length;
				columnsNote = result.columnsNote;
				onparsed({ readings: result.readings, readingsJson: JSON.stringify(result.readings), fileName: file.name });
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
		columnsNote = '';
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
				<p class="tron-text-muted text-sm">{readingCount} readings loaded{#if columnsNote}&nbsp;· {columnsNote}{/if}</p>
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
