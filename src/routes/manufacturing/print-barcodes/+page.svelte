<script lang="ts">
	import { enhance } from '$app/forms';
	import bwipjs from 'bwip-js/browser';
	import type { ActionData, PageData } from './$types';

	interface Props {
		data: PageData;
		form: ActionData;
	}
	let { data, form }: Props = $props();

	let count = $state(80);
	let skip = $state(0);
	let submitting = $state(false);

	const LABELS_PER_SHEET = 80;

	const cells = $derived.by<string[]>(() => {
		const out = Array.from({ length: LABELS_PER_SHEET }, () => '');
		if (form && 'success' in form && form.success && form.barcodes) {
			const start = form.skip ?? 0;
			form.barcodes.forEach((b, i) => {
				if (start + i < LABELS_PER_SHEET) out[start + i] = b;
			});
		}
		return out;
	});

	function datamatrix(node: HTMLCanvasElement, code: string) {
		const draw = (text: string) => {
			if (!text) return;
			try {
				bwipjs.toCanvas(node, {
					bcid: 'datamatrix',
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

	$effect(() => {
		if (form && 'success' in form && form.success && form.barcodes?.length) {
			const id = setTimeout(() => window.print(), 500);
			return () => clearTimeout(id);
		}
	});
</script>

<div class="p-6 print:p-0">
	<div class="print:hidden mb-6 max-w-2xl">
		<h1 class="text-2xl font-bold mb-2">Print Cartridge Barcodes</h1>
		<p class="text-gray-600 mb-4 text-sm">
			Avery 94102 — 8×10 grid, 80 labels per sheet (¾" square). Each print mints fresh
			<code>CART-NNNNNN</code> barcodes; uniqueness is enforced atomically against existing cartridges.
		</p>

		<div class="bg-gray-50 border rounded p-4 mb-4 text-sm">
			<div class="flex justify-between">
				<span>Sheets on hand: <strong>{data.sheetsOnHand}</strong></span>
				{#if data.sheetsOnHand <= data.alertThreshold}
					<span class="text-red-600 font-semibold">Below alert threshold ({data.alertThreshold})</span>
				{/if}
			</div>
		</div>

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
			class="space-y-4"
		>
			<label class="block">
				<span class="text-sm font-medium">Labels to print (1–80)</span>
				<input
					type="number"
					name="count"
					bind:value={count}
					min="1"
					max="80"
					required
					class="block mt-1 border rounded px-2 py-1 w-32"
				/>
			</label>
			<label class="block">
				<span class="text-sm font-medium">Skip first N positions (partial sheet)</span>
				<input
					type="number"
					name="skip"
					bind:value={skip}
					min="0"
					max="79"
					required
					class="block mt-1 border rounded px-2 py-1 w-32"
				/>
			</label>
			<p class="text-xs text-gray-500">Skip + count must be ≤ 80.</p>

			<button
				type="submit"
				disabled={submitting || skip + count > LABELS_PER_SHEET}
				class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
			>
				{submitting ? 'Generating…' : `Generate ${count} & Print`}
			</button>
		</form>

		{#if form && 'error' in form && form.error}
			<div class="mt-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
				{form.error}
			</div>
		{/if}

		{#if form && 'success' in form && form.success}
			<div class="mt-4 p-3 bg-green-50 border border-green-200 rounded text-green-700 text-sm">
				Minted {form.barcodes?.length} barcodes
				(<code>{form.barcodes?.[0]}</code> … <code>{form.barcodes?.[form.barcodes.length - 1]}</code>).
				Sheets remaining: {form.sheetsRemainingAfter}.
				<button type="button" onclick={() => window.print()} class="ml-2 underline">Reprint sheet</button>
			</div>
		{/if}

		{#if data.recent.length > 0}
			<details class="mt-6">
				<summary class="cursor-pointer text-sm font-medium">Recent batches ({data.recent.length})</summary>
				<table class="mt-2 text-xs w-full">
					<thead class="text-left bg-gray-100">
						<tr>
							<th class="p-2">When</th>
							<th class="p-2">Range</th>
							<th class="p-2">Count</th>
							<th class="p-2">By</th>
						</tr>
					</thead>
					<tbody>
						{#each data.recent as r}
							<tr class="border-t">
								<td class="p-2">{new Date(r.printedAt).toLocaleString()}</td>
								<td class="p-2 font-mono">{r.firstBarcodeId} – {r.lastBarcodeId}</td>
								<td class="p-2">{r.totalLabels}</td>
								<td class="p-2">{r.printedBy?.username ?? '—'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</details>
		{/if}
	</div>

	{#if form && 'success' in form && form.success}
		{#key form.batchId}
			<div class="w-[8.5in] h-[11in] bg-gray-50 print:bg-white mx-auto outline print:outline-0">
				<div class="py-[0.46in] px-[0.23in] grid grid-cols-8 grid-rows-10">
					{#each cells as code, index (index)}
						<div class="m-[0.125in] w-[0.75in] h-[0.75in] bg-white text-black pt-1 border print:border-0">
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
									<div class="px-1 text-[3.5pt] leading-[1.1em] text-center font-mono">
										{code}
									</div>
								</div>
							{/if}
						</div>
					{/each}
				</div>
			</div>
		{/key}
	{/if}
</div>

<style>
	@media print {
		@page {
			size: 8.5in 11in;
			margin: 0;
		}
	}
</style>
