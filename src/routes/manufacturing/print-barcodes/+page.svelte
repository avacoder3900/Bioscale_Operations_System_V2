<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
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
	let printing = $state(false);
	let showAddPrompt = $state(false);
	let confirming = $state(false);
	let addError = $state<string | null>(null);

	// ── Printed-label layout calibration ─────────────────────────────────
	// Operator-adjustable alignment so the rendered sheet can be nudged to
	// match the physical Avery 94102 stickers without a code change. Defaults
	// are the previously hard-coded values from sheetPng(). Persisted per
	// browser in localStorage so a one-time calibration sticks across reloads.
	// Reset to the original alignment (0.3125 / 15 px), then nudged 0.5 mm up.
	// At 300 DPI, 1 mm = 300/25.4 ≈ 11.811 px → 0.5 mm ≈ 5.91 px.
	//   X: 0.3125 (original, no horizontal change)
	//   Y: 15 − 5.91 = 9.09 px (0.5 mm up)
	const DEFAULT_SHIFT_X = 0.3125; // px @ 300 DPI (− = left, + = right)
	const DEFAULT_SHIFT_Y = 9.09; // px @ 300 DPI (− = up, + = down)
	const DEFAULT_SHRINK_PCT = 85; // QR + text footprint, % of cell geometry
	// Bumped to .v2 alongside the 2 mm-left / 3 mm-up baseline change so a
	// browser that cached the old defaults adopts the new baseline instead of
	// overriding it. Bump again if defaults change and must re-take effect.
	const CALIB_KEY = 'printBarcodeCalib.v4';

	function loadCalib(): { shiftX?: number; shiftY?: number; shrinkPct?: number } | null {
		if (typeof localStorage === 'undefined') return null;
		try {
			return JSON.parse(localStorage.getItem(CALIB_KEY) || 'null');
		} catch {
			return null;
		}
	}
	const _savedCalib = loadCalib();
	let shiftX = $state(_savedCalib?.shiftX ?? DEFAULT_SHIFT_X);
	let shiftY = $state(_savedCalib?.shiftY ?? DEFAULT_SHIFT_Y);
	let shrinkPct = $state(_savedCalib?.shrinkPct ?? DEFAULT_SHRINK_PCT);

	// Persist whenever a value changes.
	$effect(() => {
		if (typeof localStorage === 'undefined') return;
		localStorage.setItem(CALIB_KEY, JSON.stringify({ shiftX, shiftY, shrinkPct }));
	});

	function resetCalib() {
		shiftX = DEFAULT_SHIFT_X;
		shiftY = DEFAULT_SHIFT_Y;
		shrinkPct = DEFAULT_SHRINK_PCT;
	}

	// Print, then prompt "Add to inventory?". afterprint fires when the
	// browser's print dialog closes (Print or Cancel). Showing the prompt
	// here — rather than committing on Generate — means cancelled prints
	// don't waste sheets, and a fresh form is shown only after the operator
	// confirms or discards the batch.
	function printAndReset() {
		if (printing) return;
		printing = true;
		const cleanup = () => {
			window.removeEventListener('afterprint', cleanup);
			printing = false;
			showAddPrompt = true;
		};
		window.addEventListener('afterprint', cleanup);
		window.print();
	}

	async function discardAndReset() {
		showAddPrompt = false;
		await goto($page.url.pathname, { invalidateAll: true, replaceState: true });
	}

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

	// Render an entire sheet as a SINGLE PNG. Each sheet becomes one PDF
	// Image object instead of 80+ — HP printers cap at ~50 images/page and
	// trip "PDL PDF limitcheck" with per-cell rendering (whether canvas,
	// SVG, or img+data-URI).
	//
	// Layout matches Avery 94102 exactly: 8x10 grid of 0.75" cells,
	// 0.125" gutters, 0.23" horizontal page margin, 0.46" vertical.
	const DPI = 300;
	const sheetCache = new Map<string, string>();

	function sheetPng(cells: string[]): string {
		if (typeof document === 'undefined') return '';
		if (!cells.some((c) => c)) return '';

		// Calibration values are part of the key so a nudge re-renders instead
		// of returning a stale cached sheet.
		const cacheKey = `${cells.join('|')}|${shiftX}|${shiftY}|${shrinkPct}`;
		const cached = sheetCache.get(cacheKey);
		if (cached) return cached;

		const W = 8.5 * DPI;
		const H = 11 * DPI;
		const canvas = document.createElement('canvas');
		canvas.width = W;
		canvas.height = H;
		const ctx = canvas.getContext('2d');
		if (!ctx) return '';

		ctx.fillStyle = '#FFFFFF';
		ctx.fillRect(0, 0, W, H);

		const cellMargin = 0.125 * DPI;
		const cellSize = 0.75 * DPI;
		const cellPitch = cellSize + 2 * cellMargin; // 1.0" pitch
		// Operator-tuned alignment shift to match physical Avery 94102
		// stickers. History on a 2550×3300 px sheet:
		//   start →  shiftX = +25.3 px,  shiftY = +22.5 px  (0.1125c, 0.10c)
		//   nudge →  shiftX = +0.3  px,  shiftY = +7.5  px  (−25 left, −15 up)
		//   half-y → shiftY = +15   px                       (only 7.5 up vs start)
		// shiftX / shiftY are now operator-adjustable raw pixels (see the
		// "Print alignment" calibration controls + localStorage persistence).
		const padX = 0.23 * DPI + shiftX;
		const padY = 0.46 * DPI + shiftY;

		ctx.textBaseline = 'top';
		ctx.fillStyle = '#000000';

		// Operator-tuned shrink applied to every drawn element so QR + text
		// occupy `shrinkPct`% of their previous footprint while their visual
		// centers stay exactly where they were before.
		const SHRINK = shrinkPct / 100;

		for (let i = 0; i < cells.length; i++) {
			const code = cells[i];
			if (!code) continue;

			const col = i % 8;
			const row = Math.floor(i / 8);
			const cellLeft = padX + col * cellPitch + cellMargin;
			const cellTop = padY + row * cellPitch + cellMargin;

			// ABC labels (top of cell, on B-column grid). Centers preserved
			// from the un-shrunk geometry; size scaled by SHRINK.
			const abcFullPx = 5 * (DPI / 96);
			const abcPx = abcFullPx * SHRINK;
			const abcCharW = 0.6; // courier monospace char-width as fraction of font size
			ctx.font = `bold ${abcPx}px courier, monospace`;
			ctx.textAlign = 'left';
			const abcLeft = cellLeft + 0.08 * DPI;
			const abcSpacing = 0.22 * DPI;
			// Pre-shrink each char top-left was (abcLeft + n*abcSpacing, cellTop).
			// Center: (abcLeft + n*abcSpacing + abcCharW*abcFullPx/2, cellTop + abcFullPx/2).
			// To preserve those centers with the smaller font, shift the new
			// top-left right + down by half the size delta.
			const abcShiftX = (abcCharW * (abcFullPx - abcPx)) / 2;
			const abcShiftY = (abcFullPx - abcPx) / 2;
			const abcY = cellTop + abcShiftY;
			ctx.fillText('A', abcLeft + abcShiftX, abcY);
			ctx.fillText('B', abcLeft + abcSpacing + abcShiftX, abcY);
			ctx.fillText('C', abcLeft + 2 * abcSpacing + abcShiftX, abcY);

			// QR code. Centered on B-column (cellLeft + 0.347" per existing
			// alignment math). Old footprint top-left was (qrCenterX - qrFull/2, qrTop)
			// → center at (qrCenterX, qrTop + qrFull/2). Shrink in place by
			// keeping the center constant.
			try {
				const qrCanvas = document.createElement('canvas');
				bwipjs.toCanvas(qrCanvas, {
					bcid: 'qrcode',
					text: code,
					scale: 6,
					height: 7,
					width: 7
				});
				const qrFullSize = 0.5 * DPI;
				const qrSize = qrFullSize * SHRINK;
				const qrCenterX = cellLeft + 0.347 * DPI;
				const qrCenterY = cellTop + 0.08 * DPI + qrFullSize / 2;
				ctx.drawImage(qrCanvas, qrCenterX - qrSize / 2, qrCenterY - qrSize / 2, qrSize, qrSize);

				// UUID text below QR — two lines centered on B-column. Old
				// block ran from oldTextTop (= qrTop + qrFullSize + 0.02") to
				// oldTextTop + textFullPx*2.15 (line 2 bottom, with 1.15 line
				// gap). Preserve the block's vertical center; shrink size.
				const textFullPx = 3.5 * (DPI / 72);
				const textPx = textFullPx * SHRINK;
				const oldTextTop = cellTop + 0.08 * DPI + qrFullSize + 0.02 * DPI;
				const textCenterY = oldTextTop + textFullPx * 1.075; // line gap 1.15 → block height = font * 2.15
				const textTop = textCenterY - textPx * 1.075;
				ctx.font = `${textPx}px courier, monospace`;
				ctx.textAlign = 'center';
				const half = Math.ceil(code.length / 2);
				ctx.fillText(code.slice(0, half), qrCenterX, textTop);
				ctx.fillText(code.slice(half), qrCenterX, textTop + textPx * 1.15);
			} catch (e) {
				console.error('bwip-js failed for', code, e);
			}
		}

		const url = canvas.toDataURL('image/png');
		sheetCache.set(cacheKey, url);
		return url;
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

		<!-- Print alignment (calibration). Nudges where labels render on the
		     sheet to match the physical Avery 94102 stickers. Pure client-side
		     render tuning — does NOT touch minting, inventory, or permissions.
		     Persisted per browser; hidden from the printout (parent is
		     print:hidden). -->
		<details class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
			<summary class="cursor-pointer text-sm font-medium" style="color: var(--color-tron-text)">
				Print alignment (calibration)
			</summary>
			<div class="mt-3 space-y-3">
				<p class="text-[11px]" style="color: var(--color-tron-text-secondary)">
					Nudge the printed layout to line up with the physical sticker grid. Offsets are pixels at 300&nbsp;DPI (30&nbsp;px ≈ 0.1&quot;). The preview below updates live; settings are saved in this browser only.
				</p>
				<div class="grid gap-3 sm:grid-cols-3">
					<label class="block">
						<span class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">X offset (px, + = right)</span>
						<input
							type="number"
							step="0.5"
							bind:value={shiftX}
							class="mt-1 w-32 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm font-mono"
							style="color: var(--color-tron-text)"
						/>
					</label>
					<label class="block">
						<span class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Y offset (px, + = down)</span>
						<input
							type="number"
							step="0.5"
							bind:value={shiftY}
							class="mt-1 w-32 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm font-mono"
							style="color: var(--color-tron-text)"
						/>
					</label>
					<label class="block">
						<span class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Label size (%, 50–100)</span>
						<input
							type="number"
							step="1"
							min="50"
							max="100"
							bind:value={shrinkPct}
							class="mt-1 w-32 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm font-mono"
							style="color: var(--color-tron-text)"
						/>
					</label>
				</div>
				<div class="flex items-center gap-3 text-[11px]" style="color: var(--color-tron-text-secondary)">
					<button
						type="button"
						onclick={resetCalib}
						class="rounded border border-[var(--color-tron-border)] px-3 py-1 hover:border-[var(--color-tron-text-secondary)]"
						style="color: var(--color-tron-text-secondary)"
					>
						Reset to defaults
					</button>
					<span class="font-mono">x={shiftX} · y={shiftY} · size={shrinkPct}%</span>
				</div>
			</div>
		</details>

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
					onclick={printAndReset}
					disabled={printing}
					class="rounded border border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-semibold text-black hover:opacity-90 disabled:opacity-50"
				>
					{printing ? 'Printing…' : 'Print Sheet'}
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
	{#key form && 'barcodes' in form && form.barcodes?.length ? form.barcodes[0] : 'empty'}
		<div class="print-area space-y-4 print:space-y-0">
			{#each sheets as sheetCells, sheetIdx (sheetIdx)}
				<div
					class="mx-auto h-[11in] w-[8.5in] bg-white outline outline-1 outline-[var(--color-tron-border)] print:outline-0"
					style={sheetIdx < sheets.length - 1
						? 'break-after: page; page-break-after: always;'
						: ''}
				>
					<img
						src={sheetPng(sheetCells)}
						alt="Barcode sheet {sheetIdx + 1}"
						style="display:block;width:100%;height:100%;image-rendering:pixelated"
					/>
				</div>
			{/each}
		</div>
	{/key}
</div>

<!-- "Add to inventory?" modal — fires after the print dialog closes.
     Yes:  POST /?/addToInventory with the minted barcodes. Records both
           sides of the print against PT-CT-106 "Barcodes" (the existing
           BOM part with full ROG / accessioning / lot wiring): sheet
           input as consumption, printed labels as creation. Net is
           positive so WI-01 cartridge-back's inventory check is never
           starved by a print.
     No:   discards the minted batch (UUIDs are stateless; nothing to
           clean up) and resets the page. -->
{#if showAddPrompt && form && 'barcodes' in form && form.barcodes?.length}
	{@const f = form as { barcodes: string[]; sheetsToPrint?: number; skip?: number; firstSheetCount?: number }}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 print:hidden">
		<div class="w-full max-w-md rounded-lg border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-surface)] p-5 shadow-2xl">
			<h3 class="text-lg font-semibold" style="color: var(--color-tron-cyan)">Add to inventory?</h3>
			<p class="mt-2 text-sm" style="color: var(--color-tron-text)">
				Confirming will record
				<strong class="font-mono">{f.sheetsToPrint ?? 1}</strong>
				sheet{(f.sheetsToPrint ?? 1) === 1 ? '' : 's'} consumed and
				<strong class="font-mono">{f.barcodes.length}</strong>
				printed label{f.barcodes.length === 1 ? '' : 's'} produced against
				<strong>Barcodes (PT-CT-106)</strong> — the part WI-01 cartridge-back consumes.
			</p>
			<p class="mt-2 text-xs" style="color: var(--color-tron-text-secondary)">
				Choose <em>No</em> if the print failed, was cancelled, or you don't want to count this batch.
			</p>

			{#if addError}
				<div class="mt-3 rounded border border-red-500/50 bg-red-900/20 p-2 text-xs text-red-300">
					{addError}
				</div>
			{/if}

			<form
				method="POST"
				action="?/addToInventory"
				class="mt-4 flex justify-end gap-2"
				use:enhance={() => {
					confirming = true;
					addError = null;
					return async ({ result, update }) => {
						if (result.type === 'success') {
							showAddPrompt = false;
							confirming = false;
							await update({ reset: true });
							await goto($page.url.pathname, { invalidateAll: true, replaceState: true });
						} else if (result.type === 'failure') {
							addError = (result.data as any)?.addError ?? 'Failed to add to inventory';
							confirming = false;
						} else {
							confirming = false;
						}
					};
				}}
			>
				<input type="hidden" name="sheetsToPrint" value={f.sheetsToPrint ?? 1} />
				<input type="hidden" name="totalLabels" value={f.barcodes.length} />
				<input type="hidden" name="skip" value={f.skip ?? 0} />
				<input type="hidden" name="firstSheetCount" value={f.firstSheetCount ?? f.barcodes.length} />
				<input type="hidden" name="barcodes" value={f.barcodes.join(',')} />

				<button
					type="button"
					onclick={discardAndReset}
					disabled={confirming}
					class="rounded border border-[var(--color-tron-border)] px-4 py-2 text-sm font-medium hover:border-[var(--color-tron-text-secondary)] disabled:opacity-50"
					style="color: var(--color-tron-text-secondary)"
				>
					No, discard
				</button>
				<button
					type="submit"
					disabled={confirming}
					class="rounded border border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-semibold text-black hover:opacity-90 disabled:opacity-50"
				>
					{confirming ? 'Adding…' : 'Yes, add to inventory'}
				</button>
			</form>
		</div>
	</div>
{/if}

<style>
	@media print {
		@page {
			size: 8.5in 11in;
			margin: 0;
		}
		/* display:none (not visibility:hidden) on chrome so it never enters
		   the print stream — fewer PDF objects for the printer to parse,
		   which matters for "PDL PDF limitcheck"-prone HP firmware. */
		:global(header),
		:global(aside.mfg-sidebar),
		:global(.tron-scanlines) {
			display: none !important;
		}
		:global(html),
		:global(body) {
			margin: 0 !important;
			padding: 0 !important;
			background: white !important;
		}
		:global(main) {
			margin: 0 !important;
			padding: 0 !important;
		}
		:global(.tron-grid-bg) {
			background: white !important;
		}
		:global(.min-w-0.flex-1) {
			padding: 0 !important;
		}
		.print-area {
			margin: 0 !important;
			padding: 0 !important;
		}
	}
</style>
