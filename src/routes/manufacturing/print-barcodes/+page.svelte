<script lang="ts">
	let { data, form } = $props();

	function downloadCsv(barcodeIds: string[]) {
		const csv = 'barcode_id\n' + barcodeIds.join('\n');
		const blob = new Blob([csv], { type: 'text/csv' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `barcodes-${new Date().toISOString().slice(0, 10)}.csv`;
		a.click();
		URL.revokeObjectURL(url);
	}

	$effect(() => {
		if (form?.barcodeIds?.length) {
			downloadCsv(form.barcodeIds);
		}
	});
</script>

<div class="min-h-screen bg-gray-100 p-4 lg:p-6">
	<div class="mb-6">
		<h1 class="text-2xl font-bold text-gray-900">Print Barcodes</h1>
		<p class="text-sm text-gray-500">Avery 94102 barcode sheet tracking and printing</p>
		<a href="/manufacturing/cart-mfg-dev" class="mt-1 inline-block text-xs text-blue-600 hover:underline">← Back to Dashboard</a>
	</div>

	{#if form?.error}
		<div class="mb-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">{form.error}</div>
	{/if}
	{#if form?.success && form?.totalLabels}
		<div class="mb-4 rounded border border-green-300 bg-green-50 p-3 text-sm text-green-700">
			Batch printed: {form.totalLabels} labels generated. CSV download started.
		</div>
	{/if}
	{#if form?.success && !form?.totalLabels}
		<div class="mb-4 rounded border border-green-300 bg-green-50 p-3 text-sm text-green-700">Inventory count updated.</div>
	{/if}

	<div class="grid gap-6 lg:grid-cols-2">
		<!-- Section A: Sheet Inventory -->
		<div class="rounded-lg border bg-white p-5 shadow-sm">
			<h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">Avery 94102 Sheet Inventory</h2>
			<div class="mb-3 text-3xl font-bold text-gray-900">{data.inventory.sheetsOnHand} <span class="text-base font-normal text-gray-500">sheets on hand</span></div>
			<div class="mb-3 text-sm text-gray-600">
				30 labels/sheet × {data.inventory.sheetsOnHand} sheets = <strong>{data.inventory.labelsAvailable}</strong> labels available
			</div>
			{#if data.inventory.sheetsOnHand < data.inventory.alertThreshold}
				<div class="mb-3 rounded bg-orange-100 px-3 py-2 text-sm font-medium text-orange-700">
					⚠ Below alert threshold ({data.inventory.alertThreshold} sheets)
				</div>
			{/if}
			{#if data.inventory.lastCountedAt}
				<div class="mb-4 text-xs text-gray-400">
					Last counted: {new Date(data.inventory.lastCountedAt).toLocaleString()} by {data.inventory.lastCountedBy ?? 'Unknown'}
				</div>
			{/if}

			<form method="POST" action="?/updateInventoryCount" class="space-y-3 border-t pt-4">
				<div>
					<label for="sheetsOnHand" class="block text-xs font-medium text-gray-600">Update Sheets on Hand</label>
					<input type="number" name="sheetsOnHand" id="sheetsOnHand" min="0" value={data.inventory.sheetsOnHand}
						class="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
				</div>
				<div>
					<label for="alertThreshold" class="block text-xs font-medium text-gray-600">Alert Threshold</label>
					<input type="number" name="alertThreshold" id="alertThreshold" min="0" value={data.inventory.alertThreshold}
						class="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
				</div>
				<button type="submit" class="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">Update Count</button>
			</form>
		</div>

		<!-- Section B: Print New Batch -->
		<div class="rounded-lg border bg-white p-5 shadow-sm">
			<h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">Print New Barcode Batch</h2>
			<form method="POST" action="?/printBatch" class="space-y-3">
				<div>
					<label for="sheetsUsed" class="block text-xs font-medium text-gray-600">Sheets to Print</label>
					<input type="number" name="sheetsUsed" id="sheetsUsed" min="1" max={data.inventory.sheetsOnHand} value="1"
						class="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
					<div class="mt-1 text-xs text-gray-400">= 30 labels per sheet</div>
				</div>
				<div>
					<label for="printerName" class="block text-xs font-medium text-gray-600">Printer (optional)</label>
					<input type="text" name="printerName" id="printerName" placeholder="e.g., Dymo LabelWriter 450"
						class="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
				</div>
				<div>
					<label for="notes" class="block text-xs font-medium text-gray-600">Notes (optional)</label>
					<input type="text" name="notes" id="notes"
						class="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
				</div>
				<button type="submit" class="rounded bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700">Generate Barcodes & Record Print</button>
				<div class="text-xs text-gray-400">Downloads CSV for Avery template mail merge</div>
			</form>
		</div>
	</div>

	<!-- Section C: Recent Batches -->
	<div class="mt-6 rounded-lg border bg-white p-5 shadow-sm">
		<h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">Recent Batches</h2>
		{#if data.recentBatches?.length}
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b text-left text-xs font-medium uppercase text-gray-500">
							<th class="pb-2 pr-4">Date</th>
							<th class="pb-2 pr-4">Operator</th>
							<th class="pb-2 pr-4">Sheets</th>
							<th class="pb-2 pr-4">Labels</th>
							<th class="pb-2 pr-4">Used</th>
							<th class="pb-2">Status</th>
						</tr>
					</thead>
					<tbody>
						{#each data.recentBatches as batch}
							<tr class="border-b border-gray-100">
								<td class="py-2 pr-4 text-gray-600">{new Date(batch.printedAt).toLocaleDateString()}</td>
								<td class="py-2 pr-4">{batch.printedBy}</td>
								<td class="py-2 pr-4">{batch.sheetsUsed}</td>
								<td class="py-2 pr-4">{batch.totalLabels}</td>
								<td class="py-2 pr-4">{batch.labelsUsed}</td>
								<td class="py-2">
									<span class="rounded-full px-2 py-0.5 text-xs {batch.status === 'fully_consumed' ? 'bg-green-100 text-green-700' : batch.status === 'partially_used' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-600'}">
										{batch.status}
									</span>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else}
			<div class="text-sm text-gray-400">No batches yet</div>
		{/if}
	</div>

	<!-- Section D: Orphaned Barcodes -->
	<div class="mt-6 rounded-lg border p-5 shadow-sm {data.orphanedCount > 50 ? 'bg-orange-50 border-orange-300' : 'bg-white'}">
		<h2 class="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Orphaned Barcodes</h2>
		<div class="text-2xl font-bold {data.orphanedCount > 50 ? 'text-orange-700' : 'text-gray-900'}">{data.orphanedCount}</div>
		<div class="text-xs text-gray-500">Labels printed but not yet applied to any cartridge record</div>
		{#if data.orphanedCount > 50}
			<div class="mt-2 text-xs font-medium text-orange-600">⚠ High orphan count — review print batches</div>
		{/if}
	</div>
</div>
