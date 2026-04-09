<script lang="ts">
	import { enhance } from '$app/forms';

	interface Label {
		barcode: string;
		qr: string;
	}

	interface Props {
		data: { labelsPerSheet: number; cols: number; rows: number };
		form: {
			labels?: Label[];
			sheetsNeeded?: number;
			quantity?: number;
			error?: string;
		};
	}

	let { data, form }: Props = $props();
	let quantity = $state(80);
	let prefix = $state('CART');
	let generating = $state(false);

	// Printer settings
	let printerIp = $state(localStorage?.getItem('printerIp') ?? '');
	let printerName = $state(localStorage?.getItem('printerName') ?? '');
	let showPrinterSetup = $state(false);

	function savePrinter() {
		localStorage?.setItem('printerIp', printerIp);
		localStorage?.setItem('printerName', printerName);
		showPrinterSetup = false;
	}

	/**
	 * Open a new window with just the label sheet(s) rendered at exact Avery 94102
	 * dimensions. The browser's native print dialog pops up automatically.
	 */
	function printLabels() {
		if (!form?.labels?.length) return;

		const labels = form.labels;
		const perSheet = data.labelsPerSheet;
		const sheetCount = Math.ceil(labels.length / perSheet);

		let sheetsHtml = '';
		for (let s = 0; s < sheetCount; s++) {
			const slice = labels.slice(s * perSheet, (s + 1) * perSheet);
			let cellsHtml = '';
			for (let c = 0; c < perSheet; c++) {
				const lbl = slice[c];
				if (lbl) {
					cellsHtml += `<div class="cell"><img src="${lbl.qr}"/><div class="code">${lbl.barcode}</div></div>`;
				} else {
					cellsHtml += `<div class="cell"></div>`;
				}
			}
			sheetsHtml += `<div class="sheet">${cellsHtml}</div>`;
		}

		const html = `<!DOCTYPE html>
<html><head><title>Barcode Labels — Avery 94102</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: Arial, sans-serif; }

@page {
	size: letter;
	margin: 0.625in 0.375in;
}

.sheet {
	display: grid;
	grid-template-columns: repeat(10, 0.75in);
	grid-template-rows: repeat(8, 0.75in);
	column-gap: 0.028in;
	row-gap: 0.536in;
	justify-content: center;
	width: 7.75in;
	page-break-after: always;
}
.sheet:last-child { page-break-after: auto; }

.cell {
	width: 0.75in;
	height: 0.75in;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	overflow: hidden;
	padding: 0.02in;
}
.cell img {
	width: 0.52in;
	height: 0.52in;
}
.cell .code {
	font-size: 4pt;
	font-family: 'Courier New', monospace;
	font-weight: bold;
	text-align: center;
	margin-top: 0.01in;
	white-space: nowrap;
}

/* On-screen preview styling */
@media screen {
	body { background: #e5e7eb; padding: 20px; }
	.sheet {
		background: white;
		margin: 0 auto 30px;
		padding: 0.625in 0.375in;
		width: 8.5in;
		box-shadow: 0 2px 8px rgba(0,0,0,0.15);
		border-radius: 4px;
	}
	.cell {
		border: 1px dashed #d1d5db;
		border-radius: 2px;
	}
}
</style>
</head><body>${sheetsHtml}</body></html>`;

		const printWin = window.open('', '_blank');
		if (printWin) {
			printWin.document.write(html);
			printWin.document.close();
			// Auto-trigger print dialog after content loads
			printWin.onload = () => printWin.print();
		}
	}
</script>

<!-- Controls -->
<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">Print Barcode Labels</h1>
			<p class="text-sm text-[var(--color-tron-text-secondary)]">Avery 94102 — {data.labelsPerSheet} labels per sheet ({data.cols} × {data.rows}) — 0.75" square</p>
		</div>

		<div class="flex items-center gap-2">
			{#if printerIp}
				<div class="flex items-center gap-1.5 rounded border border-green-500/30 bg-green-500/10 px-3 py-1.5 text-xs">
					<span class="h-2 w-2 rounded-full bg-green-400"></span>
					<span class="text-green-400">{printerName || printerIp}</span>
				</div>
			{/if}
			<button
				type="button"
				onclick={() => { showPrinterSetup = !showPrinterSetup; }}
				class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]"
			>
				{printerIp ? 'Change Printer' : 'Setup Printer'}
			</button>
		</div>
	</div>

	<!-- Printer Setup -->
	{#if showPrinterSetup}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
			<h3 class="text-sm font-semibold text-[var(--color-tron-text)]">Network Printer</h3>
			<div class="mt-3 flex items-end gap-3">
				<div>
					<label class="block text-xs text-[var(--color-tron-text-secondary)]">Printer IP</label>
					<input type="text" bind:value={printerIp} placeholder="192.168.1.100"
						class="mt-1 w-44 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text)]" />
				</div>
				<div>
					<label class="block text-xs text-[var(--color-tron-text-secondary)]">Name</label>
					<input type="text" bind:value={printerName} placeholder="Brother QL-810W"
						class="mt-1 w-44 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text)]" />
				</div>
				<button type="button" onclick={savePrinter}
					class="rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-semibold text-[var(--color-tron-bg-primary)]">Save</button>
				<button type="button" onclick={() => { showPrinterSetup = false; }}
					class="rounded border border-[var(--color-tron-border)] px-3 py-2 text-sm text-[var(--color-tron-text-secondary)]">Cancel</button>
			</div>
			<p class="mt-2 text-xs text-[var(--color-tron-text-secondary)]">Select this printer in the print dialog when printing labels.</p>
		</div>
	{/if}

	<!-- Generate -->
	<form method="POST" action="?/generate" use:enhance={() => {
		generating = true;
		return async ({ update }) => { generating = false; await update(); };
	}}>
		<div class="flex items-end gap-4">
			<div>
				<label class="block text-xs font-medium text-[var(--color-tron-text-secondary)]">Prefix</label>
				<input type="text" name="prefix" bind:value={prefix}
					class="mt-1 w-24 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text)]" />
			</div>
			<div>
				<label class="block text-xs font-medium text-[var(--color-tron-text-secondary)]">Quantity</label>
				<input type="number" name="quantity" bind:value={quantity} min="1" max="800"
					class="mt-1 w-24 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text)]" />
			</div>
			<button type="submit" disabled={generating}
				class="rounded-lg bg-[var(--color-tron-cyan)] px-6 py-2 font-semibold text-[var(--color-tron-bg-primary)] hover:opacity-90 disabled:opacity-30">
				{generating ? 'Generating...' : 'Generate Barcodes'}
			</button>
		</div>
		<p class="mt-2 text-xs text-[var(--color-tron-text-secondary)]">
			{quantity} labels = {Math.ceil(quantity / data.labelsPerSheet)} sheet{Math.ceil(quantity / data.labelsPerSheet) !== 1 ? 's' : ''}
		</p>
	</form>

	{#if form?.error}
		<p class="text-sm text-[var(--color-tron-error)]">{form.error}</p>
	{/if}

	<!-- Results + Preview -->
	{#if form?.labels && form.labels.length > 0}
		{@const sheets = Array.from({ length: Math.ceil(form.labels.length / data.labelsPerSheet) }, (_, i) =>
			form.labels.slice(i * data.labelsPerSheet, (i + 1) * data.labelsPerSheet)
		)}

		<div class="flex items-center justify-between border-t border-[var(--color-tron-border)] pt-4">
			<p class="text-sm text-[var(--color-tron-text)]">
				<span class="font-bold text-[var(--color-tron-cyan)]">{form.quantity}</span> labels
				({form.sheetsNeeded} sheet{form.sheetsNeeded !== 1 ? 's' : ''})
				&mdash; {form.labels[0].barcode} to {form.labels[form.labels.length - 1].barcode}
			</p>
			<button type="button" onclick={printLabels}
				class="rounded-lg bg-green-600 px-6 py-3 font-bold text-white hover:bg-green-500 transition-colors flex items-center gap-2">
				<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
				</svg>
				Print Labels
			</button>
		</div>

		<!-- Full-size label sheet preview -->
		{#each sheets as sheet, sheetIdx}
			<div class="mt-4">
				<p class="text-xs text-[var(--color-tron-text-secondary)] mb-2">Sheet {sheetIdx + 1} of {sheets.length} — {sheet.length} labels</p>
				<div class="rounded border border-[var(--color-tron-border)] bg-white p-6 overflow-auto">
					<div class="mx-auto" style="width: 680px;">
						<div class="grid gap-x-0.5" style="grid-template-columns: repeat(10, 1fr); grid-template-rows: repeat(8, 68px);">
							{#each { length: data.labelsPerSheet } as _, cellIdx}
								{@const label = sheet[cellIdx]}
								<div class="flex flex-col items-center justify-center border border-dashed border-gray-300 rounded-sm bg-white" style="height: 68px;">
									{#if label}
										<img src={label.qr} alt={label.barcode} class="w-11 h-11" />
										<p class="text-[7px] font-bold font-mono text-black mt-0.5 leading-none">{label.barcode}</p>
									{/if}
								</div>
							{/each}
						</div>
					</div>
				</div>
			</div>
		{/each}
	{/if}
</div>
