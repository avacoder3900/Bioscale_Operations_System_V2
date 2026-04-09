<script lang="ts">
	import { enhance } from '$app/forms';

	interface Label {
		barcode: string;
		qr: string;
	}

	interface Props {
		data: { labelsPerSheet: number };
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

	function printLabels() {
		window.print();
	}
</script>

<svelte:head>
	<style>
		/* ── Avery 5167: 80 labels/sheet, 4 cols × 20 rows ──
		   Label: 1.75" wide × 0.5" tall
		   Sheet: 8.5" × 11"
		   Top margin: 0.5"
		   Side margin: 0.3125" (5/16")
		   Horizontal gap: 0.3125" between columns
		   No vertical gap between rows
		*/
		@media print {
			.no-print { display: none !important; }

			@page {
				size: letter;
				margin: 0.5in 0.3125in 0.5in 0.3125in;
			}

			body {
				margin: 0 !important;
				padding: 0 !important;
				-webkit-print-color-adjust: exact;
				print-color-adjust: exact;
			}

			.label-sheet {
				display: grid !important;
				grid-template-columns: repeat(4, 1.75in);
				grid-template-rows: repeat(20, 0.5in);
				column-gap: 0.3125in;
				row-gap: 0;
				width: 7.875in;
				page-break-after: always;
			}

			.label-sheet:last-child {
				page-break-after: auto;
			}

			.label-cell {
				width: 1.75in;
				height: 0.5in;
				overflow: hidden;
				display: flex;
				align-items: center;
				padding: 0.02in 0.04in;
				box-sizing: border-box;
			}

			.label-cell img {
				width: 0.4in !important;
				height: 0.4in !important;
				flex-shrink: 0;
			}

			.label-info {
				margin-left: 0.06in;
				overflow: hidden;
			}

			.label-info .barcode-text {
				font-size: 6pt !important;
				font-family: 'Courier New', monospace !important;
				font-weight: bold !important;
				white-space: nowrap;
			}

			.label-info .sub-text {
				font-size: 4.5pt !important;
				color: #666 !important;
				white-space: nowrap;
			}
		}
	</style>
</svelte:head>

<!-- Controls — hidden when printing -->
<div class="no-print space-y-6">
	<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">Print Barcode Labels</h1>
	<p class="text-sm text-[var(--color-tron-text-secondary)]">Avery 5167 — {data.labelsPerSheet} labels per sheet (4 × 20)</p>

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

		<!-- Preview (screen only) -->
		<div class="mt-4 rounded border border-[var(--color-tron-border)] bg-white p-4 overflow-auto">
			<p class="text-xs text-gray-400 mb-2">Preview — {form.labels.length} labels across {form.sheetsNeeded} sheet{form.sheetsNeeded !== 1 ? 's' : ''}</p>
			<div class="grid grid-cols-4 gap-px">
				{#each form.labels as label (label.barcode)}
					<div class="flex items-center gap-1 border border-gray-200 p-0.5">
						<img src={label.qr} alt={label.barcode} class="w-8 h-8" />
						<div>
							<p class="text-[8px] font-bold font-mono leading-tight">{label.barcode}</p>
							<p class="text-[6px] text-gray-500 leading-tight">Bioscale</p>
						</div>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>

<!-- Print layout — Avery 5167 sheets (only visible when printing) -->
{#if form?.labels && form.labels.length > 0}
	{@const sheets = Array.from({ length: Math.ceil(form.labels.length / data.labelsPerSheet) }, (_, i) =>
		form.labels.slice(i * data.labelsPerSheet, (i + 1) * data.labelsPerSheet)
	)}
	{#each sheets as sheet, sheetIdx}
		<div class="label-sheet hidden print:!grid" style="display: none;">
			{#each { length: data.labelsPerSheet } as _, cellIdx}
				{@const label = sheet[cellIdx]}
				<div class="label-cell">
					{#if label}
						<img src={label.qr} alt={label.barcode} />
						<div class="label-info">
							<div class="barcode-text">{label.barcode}</div>
							<div class="sub-text">Bioscale</div>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/each}
{/if}
