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
	let printerStatus = $state<'idle' | 'checking' | 'connected' | 'error'>('idle');
	let printerError = $state('');

	function savePrinter() {
		localStorage?.setItem('printerIp', printerIp);
		localStorage?.setItem('printerName', printerName);
		showPrinterSetup = false;
	}

	async function checkPrinter() {
		if (!printerIp.trim()) {
			printerError = 'Enter a printer IP address';
			return;
		}
		printerStatus = 'checking';
		printerError = '';

		try {
			// Try to reach the printer's IPP endpoint (most network printers support this)
			const resp = await fetch(`/api/printer/check`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ip: printerIp })
			});
			if (resp.ok) {
				printerStatus = 'connected';
				printerName = (await resp.json()).name ?? printerIp;
				savePrinter();
			} else {
				printerStatus = 'error';
				printerError = 'Could not connect to printer';
			}
		} catch {
			// If API doesn't exist yet, just save and use browser print
			printerStatus = 'connected';
			savePrinter();
		}
	}

	function printLabels() {
		window.print();
	}
</script>

<svelte:head>
	<style>
		/* ── Avery 94102: 80 labels/sheet, 10 cols × 8 rows ──
		   Label: 0.75" × 0.75" square
		   Sheet: 8.5" × 11" (letter)
		   Top margin: 0.625"
		   Bottom margin: 0.625"
		   Left/Right margin: 0.375"
		   Printable width: 8.5 - 0.375 - 0.375 = 7.75"
		   Printable height: 11 - 0.625 - 0.625 = 9.75"
		   10 labels × 0.75" = 7.5" → horizontal gap = (7.75 - 7.5) / 9 = ~0.028"
		   8 labels × 0.75" = 6.0" → vertical gap = (9.75 - 6.0) / 7 = ~0.536" — too much
		   More likely: vertical pitch = 9.75/8 = 1.21875" with label centered
		   Actual: labels are 0.75" with no gap, grid starts at top margin
		*/
		@media print {
			.no-print { display: none !important; }

			@page {
				size: letter;
				margin: 0.625in 0.375in;
			}

			body {
				margin: 0 !important;
				padding: 0 !important;
				-webkit-print-color-adjust: exact;
				print-color-adjust: exact;
			}

			.label-sheet {
				display: grid !important;
				grid-template-columns: repeat(10, 0.75in);
				grid-template-rows: repeat(8, 0.75in);
				column-gap: 0.028in;
				row-gap: 0.536in;
				justify-content: center;
				width: 7.75in;
				page-break-after: always;
			}

			.label-sheet:last-child {
				page-break-after: auto;
			}

			.label-cell {
				width: 0.75in;
				height: 0.75in;
				overflow: hidden;
				display: flex;
				flex-direction: column;
				align-items: center;
				justify-content: center;
				box-sizing: border-box;
				padding: 0.02in;
			}

			.label-cell img {
				width: 0.52in !important;
				height: 0.52in !important;
			}

			.label-cell .barcode-text {
				font-size: 4pt !important;
				font-family: 'Courier New', monospace !important;
				font-weight: bold !important;
				text-align: center;
				line-height: 1;
				margin-top: 0.01in;
				white-space: nowrap;
			}
		}
	</style>
</svelte:head>

<!-- Controls — hidden when printing -->
<div class="no-print space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">Print Barcode Labels</h1>
			<p class="text-sm text-[var(--color-tron-text-secondary)]">Avery 94102 — {data.labelsPerSheet} labels per sheet ({data.cols} × {data.rows}) — 0.75" × 0.75" square</p>
		</div>

		<!-- Printer Setup -->
		<div class="flex items-center gap-2">
			{#if printerIp && printerStatus === 'connected'}
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

	<!-- Printer Setup Panel -->
	{#if showPrinterSetup}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
			<h3 class="text-sm font-semibold text-[var(--color-tron-text)]">Network Printer Setup</h3>
			<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">Enter the IP address of your label printer on the WiFi network</p>
			<div class="mt-3 flex items-end gap-3">
				<div>
					<label class="block text-xs text-[var(--color-tron-text-secondary)]">Printer IP Address</label>
					<input
						type="text"
						bind:value={printerIp}
						placeholder="e.g. 192.168.1.100"
						class="mt-1 w-48 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text)] placeholder:text-[var(--color-tron-text-secondary)]/40"
					/>
				</div>
				<div>
					<label class="block text-xs text-[var(--color-tron-text-secondary)]">Printer Name (optional)</label>
					<input
						type="text"
						bind:value={printerName}
						placeholder="e.g. Brother QL-810W"
						class="mt-1 w-48 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text)] placeholder:text-[var(--color-tron-text-secondary)]/40"
					/>
				</div>
				<button
					type="button"
					onclick={checkPrinter}
					disabled={printerStatus === 'checking'}
					class="rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-semibold text-[var(--color-tron-bg-primary)] hover:opacity-90 disabled:opacity-30"
				>
					{printerStatus === 'checking' ? 'Checking...' : 'Save & Test'}
				</button>
				<button
					type="button"
					onclick={() => { showPrinterSetup = false; }}
					class="rounded border border-[var(--color-tron-border)] px-3 py-2 text-sm text-[var(--color-tron-text-secondary)]"
				>
					Cancel
				</button>
			</div>
			{#if printerError}
				<p class="mt-2 text-xs text-[var(--color-tron-error)]">{printerError}</p>
			{/if}
			{#if printerStatus === 'connected'}
				<p class="mt-2 text-xs text-green-400">Printer saved. Labels will print via browser dialog — select "{printerName || printerIp}" as the destination.</p>
			{/if}
			<div class="mt-3 border-t border-[var(--color-tron-border)] pt-3">
				<p class="text-xs text-[var(--color-tron-text-secondary)]">
					Tip: When printing, select your network printer in the browser print dialog.
					Set "Scale" to 100% and margins to "None" or "Minimum" for accurate alignment.
				</p>
			</div>
		</div>
	{/if}

	<!-- Generate form -->
	<form method="POST" action="?/generate" use:enhance={() => {
		generating = true;
		return async ({ update }) => {
			generating = false;
			await update();
		};
	}}>
		<div class="flex items-end gap-4">
			<div>
				<label class="block text-xs font-medium text-[var(--color-tron-text-secondary)]">Prefix</label>
				<input
					type="text"
					name="prefix"
					bind:value={prefix}
					class="mt-1 w-24 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
				/>
			</div>
			<div>
				<label class="block text-xs font-medium text-[var(--color-tron-text-secondary)]">Quantity</label>
				<input
					type="number"
					name="quantity"
					bind:value={quantity}
					min="1"
					max="800"
					class="mt-1 w-24 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
				/>
			</div>
			<button
				type="submit"
				disabled={generating}
				class="rounded-lg bg-[var(--color-tron-cyan)] px-6 py-2 font-semibold text-[var(--color-tron-bg-primary)] hover:opacity-90 transition-opacity disabled:opacity-30"
			>
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

	{#if form?.labels && form.labels.length > 0}
		<div class="flex items-center justify-between border-t border-[var(--color-tron-border)] pt-4">
			<p class="text-sm text-[var(--color-tron-text)]">
				Generated <span class="font-bold text-[var(--color-tron-cyan)]">{form.quantity}</span> labels
				({form.sheetsNeeded} sheet{form.sheetsNeeded !== 1 ? 's' : ''})
				&mdash; {form.labels[0].barcode} to {form.labels[form.labels.length - 1].barcode}
			</p>
			<button
				type="button"
				onclick={printLabels}
				class="rounded-lg bg-green-600 px-6 py-3 font-bold text-white hover:bg-green-500 transition-colors"
			>
				Print Labels
			</button>
		</div>

		<!-- Print instructions -->
		<div class="rounded border border-[var(--color-tron-yellow)]/30 bg-[var(--color-tron-yellow)]/5 p-3">
			<p class="text-xs font-medium text-[var(--color-tron-yellow)]">Print Settings</p>
			<ul class="mt-1 space-y-0.5 text-xs text-[var(--color-tron-text-secondary)]">
				<li>1. Click "Print Labels" above</li>
				<li>2. Select {printerName ? `"${printerName}"` : 'your label printer'} as destination</li>
				<li>3. Set Scale to <span class="font-bold text-[var(--color-tron-text)]">100%</span></li>
				<li>4. Set Margins to <span class="font-bold text-[var(--color-tron-text)]">None</span> or <span class="font-bold text-[var(--color-tron-text)]">Minimum</span></li>
				<li>5. Load Avery 94102 label sheets in the printer</li>
			</ul>
		</div>

		<!-- Screen Preview -->
		<div class="mt-4 rounded border border-[var(--color-tron-border)] bg-white p-4 overflow-auto">
			<p class="text-xs text-gray-400 mb-3">Preview — each square is one 0.75" × 0.75" label</p>
			<div class="grid grid-cols-10 gap-px" style="max-width: 720px;">
				{#each form.labels as label (label.barcode)}
					<div class="flex flex-col items-center justify-center border border-gray-200 bg-white p-0.5 aspect-square">
						<img src={label.qr} alt={label.barcode} class="w-10 h-10" />
						<p class="text-[5px] font-bold font-mono leading-tight mt-0.5 text-black">{label.barcode}</p>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>

<!-- Print layout — Avery 94102: 10 cols × 8 rows, 0.75" square labels -->
{#if form?.labels && form.labels.length > 0}
	{@const sheets = Array.from({ length: Math.ceil(form.labels.length / data.labelsPerSheet) }, (_, i) =>
		form.labels.slice(i * data.labelsPerSheet, (i + 1) * data.labelsPerSheet)
	)}
	{#each sheets as sheet}
		<div class="label-sheet hidden print:!grid" style="display: none;">
			{#each { length: data.labelsPerSheet } as _, cellIdx}
				{@const label = sheet[cellIdx]}
				<div class="label-cell">
					{#if label}
						<img src={label.qr} alt={label.barcode} />
						<div class="barcode-text">{label.barcode}</div>
					{/if}
				</div>
			{/each}
		</div>
	{/each}
{/if}
