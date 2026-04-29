<script lang="ts">
	import { enhance } from '$app/forms';
	import bwipjs from 'bwip-js/browser';
	import type { ActionData, PageData } from './$types';

	interface Props {
		data: PageData;
		form: ActionData;
	}
	let { data, form }: Props = $props();

	let sheetsToPrint = $state(1);
	let count = $state(80);
	let skip = $state(0);
	let submitting = $state(false);

	const LABELS_PER_SHEET = 80;
	const totalLabels = $derived(count + (sheetsToPrint - 1) * LABELS_PER_SHEET);

	// Build N sheets (one cells[80] array per sheet) from the minted barcodes.
	// First sheet honours the operator's `skip` + `firstSheetCount`; sheets 2..N
	// are always full 80. Before a batch is minted, returns a single empty
	// sheet so the operator sees the layout template.
	const sheets = $derived.by<string[][]>(() => {
		if (!form || !('success' in form) || !form.success || !form.barcodes?.length) {
			return [Array.from({ length: LABELS_PER_SHEET }, () => '')];
		}
		const barcodes: string[] = form.barcodes;
		const sheetCount = form.sheetsToPrint ?? 1;
		const firstCount = form.firstSheetCount ?? barcodes.length;
		const startSkip = form.skip ?? 0;
		const result: string[][] = [];
		let idx = 0;
		for (let s = 0; s < sheetCount; s++) {
			const cells = Array.from({ length: LABELS_PER_SHEET }, () => '');
			if (s === 0) {
				for (let i = 0; i < firstCount && startSkip + i < LABELS_PER_SHEET; i++) {
					cells[startSkip + i] = barcodes[idx++];
				}
			} else {
				for (let i = 0; i < LABELS_PER_SHEET && idx < barcodes.length; i++) {
					cells[i] = barcodes[idx++];
				}
			}
			result.push(cells);
		}
		return result;
	});

	const hasBatch = $derived(!!(form && 'success' in form && form.success && form.barcodes?.length));
	const spotCheck = $derived(form && 'success' in form && form.success ? form.spotCheck : null);

	function datamatrix(node: HTMLCanvasElement, code: string) {
		const draw = (text: string) => {
			if (!text) return;
			try {
				bwipjs.toCanvas(node, {
					bcid: 'qrcode',
					text,
					scale: 3,
					height: 7,
					width: 7
				});
			} catch (e) {
				console.error('bwip-js failed for', text, e);
			}
		};
		draw(code);
		return {
			update(next: string) {
				draw(next);
			}
		};
	}
</script>

<div class="space-y-5 p-4 print:p-0">
	<!-- Form + status — hidden when printing -->
	<div class="print:hidden space-y-4">
		<div>
			<h1 class="text-xl font-semibold" style="color: var(--color-tron-cyan)">Print Cartridge Barcodes</h1>
			<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
				Avery 94102 — 8&times;10 grid, 80 labels per sheet (¾&quot; square). Each print mints fresh
				<code class="font-mono text-[11px]" style="color: var(--color-tron-cyan)">CART-NNNNNN</code>
				barcodes; uniqueness is enforced atomically against existing cartridges.
			</p>
		</div>

		<!-- Inventory chip -->
		<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3 text-sm">
			<div class="flex items-center justify-between">
				<span style="color: var(--color-tron-text)">
					Sheets on hand: <strong class="font-mono" style="color: var(--color-tron-cyan)">{data.sheetsOnHand}</strong>
				</span>
				{#if data.sheetsOnHand <= data.alertThreshold}
					<span class="font-semibold text-red-400">Below alert threshold ({data.alertThreshold})</span>
				{/if}
			</div>
		</div>

		<!-- Mint form -->
		<form
			method="POST"
			action="?/print"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update();
					submitting = false;
				};
			}}
			class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 space-y-3"
		>
			<div class="grid gap-3 sm:grid-cols-3">
				<label class="block">
					<span class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Sheets to print (1–10)</span>
					<input
						type="number"
						name="sheetsToPrint"
						bind:value={sheetsToPrint}
						min="1"
						max="10"
						required
						class="mt-1 w-32 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm font-mono"
						style="color: var(--color-tron-text)"
					/>
				</label>
				<label class="block">
					<span class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Labels on first sheet (1–80)</span>
					<input
						type="number"
						name="count"
						bind:value={count}
						min="1"
						max="80"
						required
						class="mt-1 w-32 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm font-mono"
						style="color: var(--color-tron-text)"
					/>
				</label>
				<label class="block">
					<span class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Skip first N positions (partial sheet)</span>
					<input
						type="number"
						name="skip"
						bind:value={skip}
						min="0"
						max="79"
						required
						class="mt-1 w-32 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm font-mono"
						style="color: var(--color-tron-text)"
					/>
				</label>
			</div>
			<p class="text-[11px]" style="color: var(--color-tron-text-secondary)">
				Skip + first-sheet labels must be ≤ 80. Sheets 2–{sheetsToPrint} (if any) print full 80 each. Total: <strong class="font-mono" style="color: var(--color-tron-cyan)">{totalLabels}</strong> labels.
			</p>

			<button
				type="submit"
				disabled={submitting || skip + count > LABELS_PER_SHEET}
				class="rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-4 py-2 text-sm font-medium hover:bg-[var(--color-tron-cyan)]/20 disabled:opacity-50"
				style="color: var(--color-tron-cyan)"
			>
				{submitting ? 'Generating…' : `Generate ${totalLabels} & Preview`}
			</button>
		</form>

		<!-- Error -->
		{#if form && 'error' in form && form.error}
			<div class="rounded border border-red-500/50 bg-red-900/20 p-3 text-sm text-red-300">
				{form.error}
			</div>
		{/if}

		<!-- Success header + spot-check + Print button -->
		{#if form && 'success' in form && form.success && form.barcodes?.length}
			{@const barcodes = form.barcodes}
			{@const skipPos = form.skip ?? 0}
			<div class="rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 p-3 space-y-2">
				<div class="text-sm" style="color: var(--color-tron-cyan)">
					<strong>Minted {barcodes.length} barcode{barcodes.length === 1 ? '' : 's'}</strong>
					&nbsp;<span class="font-mono text-xs">({barcodes[0]}</span>
					&hellip;
					<span class="font-mono text-xs">{barcodes[barcodes.length - 1]})</span>
				</div>

				{#if spotCheck}
					{@const ok = spotCheck.collisions.length === 0}
					<div class="text-xs" style="color: {ok ? 'var(--color-tron-text-secondary)' : '#fca5a5'}">
						{#if ok}
							✓ Spot-check passed: {spotCheck.sampleSize}/{spotCheck.sampleSize} random
							barcode{spotCheck.sampleSize === 1 ? '' : 's'} verified unique against
							<code class="font-mono">cartridge_records</code>.
							The full batch was also exhaustively checked at mint time.
						{:else}
							✗ Spot-check FAILED: {spotCheck.collisions.length}/{spotCheck.sampleSize}
							sampled barcodes already exist in <code class="font-mono">cartridge_records</code>:
							<span class="font-mono">{spotCheck.collisions.join(', ')}</span>.
							This should never happen — investigate before printing.
						{/if}
					</div>
				{/if}

				<div class="text-[11px]" style="color: var(--color-tron-text-secondary)">
					Sheets remaining: <strong class="font-mono" style="color: var(--color-tron-text)">{form.sheetsRemainingAfter}</strong>.
					Review the {form.sheetsToPrint ?? 1}-sheet simulation below — clicking Print Sheet will print all {form.sheetsToPrint ?? 1} pages in one job.
				</div>

				<button
					type="button"
					onclick={() => window.print()}
					class="rounded border border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-semibold text-black hover:opacity-90"
				>
					Print Sheet
				</button>
			</div>
		{/if}

		<!-- Recent batches -->
		{#if data.recent.length > 0}
			<details class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
				<summary class="cursor-pointer text-sm font-medium" style="color: var(--color-tron-text)">
					Recent batches ({data.recent.length})
				</summary>
				<table class="mt-3 w-full text-xs">
					<thead>
						<tr class="border-b border-[var(--color-tron-border)] text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
							<th class="px-2 py-1 text-left">When</th>
							<th class="px-2 py-1 text-left">Range</th>
							<th class="px-2 py-1 text-left">Count</th>
							<th class="px-2 py-1 text-left">By</th>
						</tr>
					</thead>
					<tbody>
						{#each data.recent as r}
							<tr class="border-b border-[var(--color-tron-border)]/40">
								<td class="px-2 py-1" style="color: var(--color-tron-text-secondary)">{new Date(r.printedAt).toLocaleString()}</td>
								<td class="px-2 py-1 font-mono" style="color: var(--color-tron-text)">{r.firstBarcodeId} – {r.lastBarcodeId}</td>
								<td class="px-2 py-1" style="color: var(--color-tron-text)">{r.totalLabels}</td>
								<td class="px-2 py-1" style="color: var(--color-tron-text-secondary)">{r.printedBy?.username ?? '—'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</details>
		{/if}

		<!-- Preview header (only on screen) -->
		<div class="pt-2" style="color: var(--color-tron-text-secondary)">
			<p class="text-[10px] uppercase tracking-wider">
				{hasBatch
					? `Preview — exact simulation of ${sheets.length} sheet${sheets.length === 1 ? '' : 's'} that will print`
					: 'Empty sheet layout (will fill once you mint)'}
			</p>
		</div>
	</div>

	<!-- The actual sheets — visible on screen as a preview AND used as the
	     print render. Keyed on batchId so re-mints get a fresh canvas.
	     `print:break-after-page` on every sheet ensures the browser starts
	     a new page after each (last sheet's break is a no-op). -->
	{#key form && 'batchId' in form ? form.batchId : 'empty'}
		<div class="space-y-4 print:space-y-0">
			{#each sheets as sheetCells, sheetIdx (sheetIdx)}
				<div class="mx-auto h-[11in] w-[8.5in] outline outline-1 outline-[var(--color-tron-border)] bg-white print:bg-white print:outline-0" style="break-after: page; page-break-after: always;">
					<div class="grid grid-cols-8 grid-rows-10 px-[0.23in] py-[0.46in]">
						{#each sheetCells as code, index (index)}
							<div class="m-[0.125in] h-[0.75in] w-[0.75in] border border-[var(--color-tron-border)]/30 bg-white pt-1 text-black print:border-0">
								{#if code}
									<div
										style="margin:0 0.05in -0.07in 0.08in;font-weight:bold;font-family:courier;font-size:5px;"
									>
										<span class="m-0">A</span>
										<span class="ml-[0.22in]">B</span>
										<span class="ml-[0.22in]">C</span>
									</div>
									<div style="padding:0.05in 0.15in 0 0.18in">
										<div style="transform:scale(0.85)">
											<canvas use:datamatrix={code}></canvas>
										</div>
									</div>
									<div>
										<div class="break-words px-1 text-center font-mono text-[3.5pt] leading-[1.1em]">
											{code}
										</div>
									</div>
								{/if}
							</div>
						{/each}
					</div>
				</div>
			{/each}
		</div>
	{/key}
</div>

<style>
	@media print {
		@page {
			size: 8.5in 11in;
			margin: 0;
		}
	}
</style>
