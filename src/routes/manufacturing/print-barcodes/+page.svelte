<script lang="ts">
	import { browser } from '$app/environment';

	let quantity = $state(80);
	let prefix = $state('CART');
	let generating = $state(false);
	let pdfUrl = $state('');
	let generatedInfo = $state('');
	let error = $state('');

	// Printer settings
	let printerIp = $state(browser ? localStorage.getItem('printerIp') ?? '' : '');
	let printerName = $state(browser ? localStorage.getItem('printerName') ?? '' : '');
	let showPrinterSetup = $state(false);

	function savePrinter() {
		if (browser) {
			localStorage.setItem('printerIp', printerIp);
			localStorage.setItem('printerName', printerName);
		}
		showPrinterSetup = false;
	}

	async function generatePdf() {
		generating = true;
		error = '';
		pdfUrl = '';
		generatedInfo = '';

		try {
			const resp = await fetch('/api/barcodes/generate-pdf', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ quantity, prefix })
			});

			if (!resp.ok) {
				const data = await resp.json();
				error = data.error || 'Failed to generate barcodes';
				return;
			}

			const blob = await resp.blob();
			pdfUrl = URL.createObjectURL(blob);

			const sheets = Math.ceil(quantity / 80);
			generatedInfo = `${quantity} labels on ${sheets} sheet${sheets !== 1 ? 's' : ''}`;
		} catch (e) {
			error = 'Failed to connect to server';
		} finally {
			generating = false;
		}
	}

	function printPdf() {
		if (!pdfUrl) return;
		const printWin = window.open(pdfUrl, '_blank');
		if (printWin) {
			printWin.onload = () => printWin.print();
		}
	}

	function downloadPdf() {
		if (!pdfUrl) return;
		const a = document.createElement('a');
		a.href = pdfUrl;
		a.download = `barcodes-${prefix}.pdf`;
		a.click();
	}
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">Print Barcode Labels</h1>
			<p class="text-sm text-[var(--color-tron-text-secondary)]">Avery 94102 — 80 labels per sheet (10 × 8) — 0.75" square — PDF output</p>
		</div>

		<div class="flex items-center gap-2">
			{#if printerIp}
				<div class="flex items-center gap-1.5 rounded border border-green-500/30 bg-green-500/10 px-3 py-1.5 text-xs">
					<span class="h-2 w-2 rounded-full bg-green-400"></span>
					<span class="text-green-400">{printerName || printerIp}</span>
				</div>
			{/if}
			<button type="button" onclick={() => { showPrinterSetup = !showPrinterSetup; }}
				class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]">
				{printerIp ? 'Change Printer' : 'Setup Printer'}
			</button>
		</div>
	</div>

	<!-- Printer Setup -->
	{#if showPrinterSetup}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
			<h3 class="text-sm font-semibold text-[var(--color-tron-text)]">Network Printer</h3>
			<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">Save your printer info — select it in the print dialog when printing the PDF.</p>
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
		</div>
	{/if}

	<!-- Generate -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-6">
		<div class="flex items-end gap-4">
			<div>
				<label class="block text-xs font-medium text-[var(--color-tron-text-secondary)]">Prefix</label>
				<input type="text" bind:value={prefix}
					class="mt-1 w-24 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text)]" />
			</div>
			<div>
				<label class="block text-xs font-medium text-[var(--color-tron-text-secondary)]">Quantity</label>
				<input type="number" bind:value={quantity} min="1" max="800"
					class="mt-1 w-24 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text)]" />
			</div>
			<button type="button" onclick={generatePdf} disabled={generating}
				class="rounded-lg bg-[var(--color-tron-cyan)] px-6 py-2 font-semibold text-[var(--color-tron-bg-primary)] hover:opacity-90 transition-opacity disabled:opacity-30">
				{generating ? 'Generating PDF...' : 'Generate Barcodes'}
			</button>
		</div>
		<p class="mt-2 text-xs text-[var(--color-tron-text-secondary)]">
			{quantity} labels = {Math.ceil(quantity / 80)} sheet{Math.ceil(quantity / 80) !== 1 ? 's' : ''}
		</p>
	</div>

	{#if error}
		<p class="text-sm text-[var(--color-tron-error)]">{error}</p>
	{/if}

	<!-- PDF Result -->
	{#if pdfUrl}
		<div class="space-y-4">
			<div class="flex items-center justify-between">
				<p class="text-sm text-[var(--color-tron-text)]">
					Generated <span class="font-bold text-[var(--color-tron-cyan)]">{generatedInfo}</span>
				</p>
				<div class="flex gap-2">
					<button type="button" onclick={printPdf}
						class="rounded-lg bg-green-600 px-6 py-3 font-bold text-white hover:bg-green-500 transition-colors flex items-center gap-2">
						<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
						</svg>
						Print
					</button>
					<button type="button" onclick={downloadPdf}
						class="rounded-lg border border-[var(--color-tron-border)] px-4 py-3 text-sm text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)] flex items-center gap-2">
						<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
						</svg>
						Download PDF
					</button>
				</div>
			</div>

			<!-- PDF Preview -->
			<div class="rounded border border-[var(--color-tron-border)] overflow-hidden" style="height: 700px;">
				<iframe src={pdfUrl} title="Barcode Labels Preview" class="w-full h-full" style="border: none;"></iframe>
			</div>
		</div>
	{/if}
</div>
