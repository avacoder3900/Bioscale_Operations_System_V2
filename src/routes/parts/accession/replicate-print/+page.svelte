<script lang="ts">
	import bwipjs from 'bwip-js/browser';
	import type { PageData } from './$types';

	interface Props {
		data: PageData;
	}
	let { data }: Props = $props();

	const LABELS_PER_SHEET = 80;

	let replicates = $state(8);
	let selectedIds = $state<string[]>([]);
	let generated = $state(false);
	let printing = $state(false);
	let search = $state('');

	const fitsParts = $derived(Math.max(1, Math.floor(LABELS_PER_SHEET / Math.max(1, replicates))));
	const filtered = $derived(
		search.trim()
			? data.registered.filter(
					(p) =>
						p.partNumber.toLowerCase().includes(search.toLowerCase()) ||
						p.name.toLowerCase().includes(search.toLowerCase()) ||
						p.barcode.toLowerCase().includes(search.toLowerCase())
				)
			: data.registered
	);

	function toggle(id: string) {
		const idx = selectedIds.indexOf(id);
		if (idx >= 0) {
			selectedIds = selectedIds.filter((x) => x !== id);
		} else if (selectedIds.length < fitsParts) {
			selectedIds = [...selectedIds, id];
		}
	}

	function selectFirstN() {
		selectedIds = filtered.slice(0, fitsParts).map((p) => p.id);
	}

	function clearSelection() {
		selectedIds = [];
	}

	const orderedSelected = $derived(
		selectedIds
			.map((id) => data.registered.find((p) => p.id === id))
			.filter((p): p is (typeof data.registered)[number] => Boolean(p))
	);

	// Each cell carries the barcode plus the part identity, so the renderer
	// can print "what part is this label" under the QR (instead of a
	// redundant UUID like the cartridge sheet).
	type Cell = { barcode: string; partNumber: string; partName: string } | null;

	// Build the 80-cell array: each selected part gets `replicates` consecutive cells.
	const cells = $derived.by<Cell[]>(() => {
		const out: Cell[] = Array.from({ length: LABELS_PER_SHEET }, () => null);
		let i = 0;
		for (const part of orderedSelected) {
			for (let r = 0; r < replicates && i < LABELS_PER_SHEET; r++) {
				out[i++] = { barcode: part.barcode, partNumber: part.partNumber, partName: part.name };
			}
		}
		return out;
	});

	const totalLabels = $derived(cells.filter((c) => c !== null).length);

	function generate() {
		if (selectedIds.length === 0) return;
		generated = true;
		// $derived will recompute the PNG via sheetPng() on render.
	}

	function reset() {
		generated = false;
		selectedIds = [];
		search = '';
	}

	function printAndReset() {
		if (printing) return;
		printing = true;
		const cleanup = () => {
			window.removeEventListener('afterprint', cleanup);
			printing = false;
		};
		window.addEventListener('afterprint', cleanup);
		window.print();
	}

	function truncateForCell(s: string, maxChars: number): string {
		if (s.length <= maxChars) return s;
		return s.slice(0, Math.max(1, maxChars - 1)) + '…';
	}

	// ─── Avery 94102 sheet renderer ────────────────────────────────────────────
	// Ported verbatim from /manufacturing/print-barcodes/+page.svelte so the
	// physical alignment + shrink + ABC labels + QR + UUID typography are
	// identical to the operator-tuned cartridge sheet.
	const DPI = 300;
	const sheetCache = new Map<string, string>();

	function sheetPng(c: Cell[]): string {
		if (typeof document === 'undefined') return '';
		if (!c.some((x) => x !== null)) return '';

		const cacheKey = c.map((x) => (x ? `${x.barcode}#${x.partNumber}` : '')).join('|');
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
		const cellPitch = cellSize + 2 * cellMargin;
		const shiftX = 0.1125 * cellSize;
		const shiftY = 0.1 * cellSize;
		const padX = 0.23 * DPI + shiftX;
		const padY = 0.46 * DPI + shiftY;

		ctx.textBaseline = 'top';
		ctx.fillStyle = '#000000';

		const SHRINK = 0.85;

		for (let i = 0; i < c.length; i++) {
			const cell = c[i];
			if (!cell) continue;
			const code = cell.barcode;

			const col = i % 8;
			const row = Math.floor(i / 8);
			const cellLeft = padX + col * cellPitch + cellMargin;
			const cellTop = padY + row * cellPitch + cellMargin;

			const abcFullPx = 5 * (DPI / 96);
			const abcPx = abcFullPx * SHRINK;
			const abcCharW = 0.6;
			ctx.font = `bold ${abcPx}px courier, monospace`;
			ctx.textAlign = 'left';
			const abcLeft = cellLeft + 0.08 * DPI;
			const abcSpacing = 0.22 * DPI;
			const abcShiftX = (abcCharW * (abcFullPx - abcPx)) / 2;
			const abcShiftY = (abcFullPx - abcPx) / 2;
			const abcY = cellTop + abcShiftY;
			ctx.fillText('A', abcLeft + abcShiftX, abcY);
			ctx.fillText('B', abcLeft + abcSpacing + abcShiftX, abcY);
			ctx.fillText('C', abcLeft + 2 * abcSpacing + abcShiftX, abcY);

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

				// Two-line label below QR identifying which PART this sticker is for
				// (replaces the cartridge sheet's redundant split-UUID text). Same
				// vertical block geometry — preserves alignment with the rest of the
				// stickers on the sheet.
				const textFullPx = 3.5 * (DPI / 72);
				const textPx = textFullPx * SHRINK;
				const oldTextTop = cellTop + 0.08 * DPI + qrFullSize + 0.02 * DPI;
				const textCenterY = oldTextTop + textFullPx * 1.075;
				const textTop = textCenterY - textPx * 1.075;
				ctx.textAlign = 'center';

				// Line 1: Part number (bold, fits comfortably — typical PT-XXX
				// codes are well under the ~26-char monospace budget at this size).
				ctx.font = `bold ${textPx}px courier, monospace`;
				const partNumberLine = cell.partNumber || code;
				ctx.fillText(truncateForCell(partNumberLine, 26), qrCenterX, textTop);

				// Line 2: Part name (slightly smaller so longer names fit; truncated).
				const namePx = textPx * 0.9;
				ctx.font = `${namePx}px Arial, sans-serif`;
				const nameLine = cell.partName ?? '';
				if (nameLine) {
					ctx.fillText(truncateForCell(nameLine, 30), qrCenterX, textTop + textPx * 1.15);
				}
			} catch (e) {
				console.error('bwip-js failed for', code, e);
			}
		}

		const url = canvas.toDataURL('image/png');
		sheetCache.set(cacheKey, url);
		return url;
	}

	const previewUrl = $derived(generated ? sheetPng(cells) : '');
</script>

<svelte:head>
	<title>ROG — Replicate Print Sheet</title>
</svelte:head>

<div class="space-y-5 p-4 print:p-0">
	<!-- Form + selection — hidden when printing -->
	<div class="print:hidden space-y-4 max-w-5xl mx-auto">
		<div class="flex items-start justify-between gap-4">
			<div>
				<h1 class="text-xl font-semibold" style="color: var(--color-tron-cyan)">Replicate Print Sheet</h1>
				<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
					Avery 94102 — 8&times;10 grid, 80 labels per sheet (¾&quot; square). Reuses the cartridge-print
					alignment exactly. Each row of N labels shows the same part's barcode; the next row uses
					the next part. No inventory mutation.
				</p>
			</div>
			<a
				href="/parts/accession#registered"
				class="text-sm hover:underline shrink-0"
				style="color: var(--color-tron-cyan)"
			>
				&larr; Back to ROG
			</a>
		</div>

		<!-- Inputs -->
		<div
			class="rounded border p-4 space-y-4"
			style="background: var(--color-tron-bg-card); border-color: var(--color-tron-border)"
		>
			<div class="grid gap-4 sm:grid-cols-3">
				<label class="block">
					<span class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
						Replicates per part (1–80)
					</span>
					<input
						type="number"
						bind:value={replicates}
						min="1"
						max="80"
						oninput={() => {
							generated = false;
							if (selectedIds.length > fitsParts) selectedIds = selectedIds.slice(0, fitsParts);
						}}
						class="mt-1 w-32 rounded border px-2 py-1 text-sm font-mono outline-none"
						style="background: var(--color-tron-bg-secondary); border-color: var(--color-tron-border); color: var(--color-tron-text)"
					/>
				</label>
				<div class="block sm:col-span-2 self-end">
					<p class="text-sm" style="color: var(--color-tron-text)">
						Fits up to <strong class="font-mono" style="color: var(--color-tron-cyan)">{fitsParts}</strong> different
						part{fitsParts === 1 ? '' : 's'} per sheet
						<span class="text-xs" style="color: var(--color-tron-text-secondary)">
							({fitsParts} × {replicates} = {fitsParts * replicates} labels{fitsParts * replicates < LABELS_PER_SHEET ? `, ${LABELS_PER_SHEET - fitsParts * replicates} blank` : ''})
						</span>
					</p>
				</div>
			</div>

			<!-- Search + actions -->
			<div class="flex flex-wrap items-center gap-3">
				<input
					type="text"
					bind:value={search}
					placeholder="Filter parts (number, name, barcode)…"
					class="flex-1 min-w-[220px] rounded border px-3 py-1.5 text-sm outline-none"
					style="background: var(--color-tron-bg-secondary); border-color: var(--color-tron-border); color: var(--color-tron-text)"
				/>
				<button
					type="button"
					onclick={selectFirstN}
					class="rounded border px-3 py-1.5 text-xs font-medium hover:opacity-90"
					style="background: var(--color-tron-bg-secondary); border-color: var(--color-tron-border); color: var(--color-tron-text)"
				>
					Auto-pick first {fitsParts}
				</button>
				<button
					type="button"
					onclick={clearSelection}
					class="rounded border px-3 py-1.5 text-xs font-medium hover:opacity-90"
					style="background: var(--color-tron-bg-secondary); border-color: var(--color-tron-border); color: var(--color-tron-text-secondary)"
				>
					Clear
				</button>
				<span class="text-xs" style="color: var(--color-tron-text-secondary)">
					Selected: <strong style="color: var(--color-tron-cyan)">{selectedIds.length}</strong> / {fitsParts}
				</span>
			</div>

			<!-- Parts checkbox list -->
			<div
				class="max-h-72 overflow-y-auto rounded border"
				style="border-color: var(--color-tron-border)"
			>
				{#if filtered.length === 0}
					<div class="p-4 text-center text-sm" style="color: var(--color-tron-text-secondary)">
						{data.registered.length === 0 ? 'No registered parts yet — assign barcodes on the ROG page first.' : 'No parts match this filter.'}
					</div>
				{:else}
					<table class="w-full text-sm">
						<thead style="background: var(--color-tron-bg-secondary)">
							<tr>
								<th class="text-left p-2 text-[10px] uppercase tracking-wider w-10" style="color: var(--color-tron-text-secondary)">Pick</th>
								<th class="text-left p-2 text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Order</th>
								<th class="text-left p-2 text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Part #</th>
								<th class="text-left p-2 text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Name</th>
								<th class="text-left p-2 text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Barcode</th>
							</tr>
						</thead>
						<tbody>
							{#each filtered as part (part.id)}
								{@const checked = selectedIds.includes(part.id)}
								{@const orderIdx = checked ? selectedIds.indexOf(part.id) + 1 : 0}
								{@const disabled = !checked && selectedIds.length >= fitsParts}
								<tr
									class="border-t cursor-pointer {disabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-cyan-500/5'}"
									style="border-color: var(--color-tron-border); color: var(--color-tron-text)"
									onclick={() => !disabled && toggle(part.id)}
								>
									<td class="p-2">
										<input
											type="checkbox"
											{checked}
											{disabled}
											onclick={(e) => e.stopPropagation()}
											onchange={() => toggle(part.id)}
											class="accent-cyan-400"
										/>
									</td>
									<td class="p-2 font-mono text-xs" style="color: {orderIdx ? 'var(--color-tron-cyan)' : 'var(--color-tron-text-secondary)'}">
										{orderIdx || '—'}
									</td>
									<td class="p-2 font-mono text-xs">{part.partNumber}</td>
									<td class="p-2">{part.name}</td>
									<td class="p-2 font-mono text-xs" style="color: var(--color-tron-text-secondary)">{part.barcode}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{/if}
			</div>

			<!-- Action row -->
			<div class="flex flex-wrap items-center gap-3">
				<button
					type="button"
					onclick={generate}
					disabled={selectedIds.length === 0}
					class="rounded px-4 py-2 text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
					style="background: var(--color-tron-cyan); color: black; box-shadow: 0 0 10px rgba(0, 212, 255, 0.4);"
				>
					Generate Preview
				</button>
				{#if generated}
					<button
						type="button"
						onclick={printAndReset}
						disabled={printing}
						class="rounded px-4 py-2 text-sm font-semibold disabled:opacity-50"
						style="background: var(--color-tron-green); color: black; box-shadow: 0 0 12px rgba(0, 255, 136, 0.35);"
					>
						{printing ? 'Printing…' : 'Print Sheet'}
					</button>
					<button
						type="button"
						onclick={reset}
						class="rounded border px-3 py-1.5 text-xs"
						style="border-color: var(--color-tron-border); color: var(--color-tron-text-secondary)"
					>
						Reset
					</button>
				{/if}
				<span class="text-xs ml-auto" style="color: var(--color-tron-text-secondary)">
					{#if generated}
						Sheet: <strong style="color: var(--color-tron-cyan)">{totalLabels}</strong> / {LABELS_PER_SHEET} labels
					{:else if selectedIds.length > 0}
						Will fill <strong style="color: var(--color-tron-cyan)">{selectedIds.length * replicates}</strong> / {LABELS_PER_SHEET} cells
					{/if}
				</span>
			</div>
		</div>

		<!-- Preview header (only on screen) -->
		<div class="pt-2" style="color: var(--color-tron-text-secondary)">
			<p class="text-[10px] uppercase tracking-wider">
				{generated ? 'Preview — exact simulation of the sheet that will print' : 'Pick parts and generate to preview the sheet'}
			</p>
		</div>
	</div>

	<!-- The actual sheet — visible on screen and used as the print render. -->
	{#if generated}
		<div class="print-area">
			<div
				class="mx-auto h-[11in] w-[8.5in] bg-white outline outline-1 print:outline-0"
				style="outline-color: var(--color-tron-border)"
			>
				<img
					src={previewUrl}
					alt="Replicate barcode sheet"
					style="display:block;width:100%;height:100%;image-rendering:pixelated"
				/>
			</div>
		</div>
	{/if}
</div>

<style>
	@media print {
		@page {
			size: 8.5in 11in;
			margin: 0;
		}
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
