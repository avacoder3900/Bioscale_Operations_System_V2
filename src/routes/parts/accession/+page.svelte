<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';

	let { data, form } = $props();

	let showAssignAllConfirm = $state(false);
	let assignAllResult = $state<any>(null);
	let lastAssigned = $state<{ partNumber: string; barcode: string } | null>(null);
</script>

<svelte:head>
	<title>Part Accession — Barcode Registration</title>
</svelte:head>

<div class="max-w-6xl mx-auto p-6">
	<div class="flex items-center justify-between mb-6">
		<div>
			<h1 class="text-2xl font-bold text-gray-900">Part Accession</h1>
			<p class="text-sm text-gray-500 mt-1">Generate and assign QR code barcodes to parts</p>
		</div>
		<a href="/parts" class="text-sm text-blue-600 hover:text-blue-800">&larr; Back to Parts</a>
	</div>

	<!-- Progress Summary -->
	<div class="bg-white rounded-lg shadow p-4 mb-6">
		<div class="flex items-center justify-between mb-2">
			<span class="text-sm font-medium text-gray-700">Registration Progress</span>
			<span class="text-sm text-gray-500">
				{data.counts.registered} of {data.counts.total} parts registered
			</span>
		</div>
		<div class="w-full bg-gray-200 rounded-full h-3">
			<div
				class="bg-green-500 h-3 rounded-full transition-all"
				style="width: {data.counts.total > 0 ? (data.counts.registered / data.counts.total) * 100 : 0}%"
			></div>
		</div>
		{#if data.counts.unregistered > 0}
			<p class="text-sm text-amber-600 mt-2">
				{data.counts.unregistered} part{data.counts.unregistered !== 1 ? 's' : ''} need barcode assignment
			</p>
		{:else}
			<p class="text-sm text-green-600 mt-2">All parts have barcodes assigned</p>
		{/if}
	</div>

	<!-- Success/Error Messages -->
	{#if form?.success}
		<div class="bg-green-50 border border-green-200 rounded-lg p-3 mb-4">
			<p class="text-green-800 text-sm">
				Barcode <strong>{form.barcode}</strong> assigned to {form.partNumber}
			</p>
		</div>
	{/if}

	{#if form?.assignAllSuccess}
		<div class="bg-green-50 border border-green-200 rounded-lg p-3 mb-4">
			<p class="text-green-800 text-sm font-medium">
				Assigned {form.count} barcode{form.count !== 1 ? 's' : ''}
			</p>
			{#if form.assignments?.length > 0}
				<div class="mt-2 max-h-40 overflow-y-auto">
					{#each form.assignments as a}
						<p class="text-green-700 text-xs">{a.partNumber} &rarr; {a.barcode}</p>
					{/each}
				</div>
			{/if}
			{#if form.failures?.length > 0}
				<div class="mt-2">
					<p class="text-red-600 text-sm font-medium">{form.failures.length} failed:</p>
					{#each form.failures as f}
						<p class="text-red-600 text-xs">{f.partNumber}: {f.error}</p>
					{/each}
				</div>
			{/if}
		</div>
	{/if}

	{#if form?.error}
		<div class="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
			<p class="text-red-800 text-sm">{form.error}</p>
		</div>
	{/if}

	<!-- Unregistered Parts -->
	{#if data.unregistered.length > 0}
		<div class="bg-white rounded-lg shadow mb-6">
			<div class="flex items-center justify-between p-4 border-b">
				<h2 class="text-lg font-semibold text-gray-900">
					Unregistered Parts ({data.unregistered.length})
				</h2>
				{#if !showAssignAllConfirm}
					<button
						onclick={() => showAssignAllConfirm = true}
						class="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
					>
						Assign All Barcodes
					</button>
				{:else}
					<div class="flex items-center gap-2">
						<span class="text-sm text-amber-600">Assign barcodes to all {data.unregistered.length} parts?</span>
						<form method="POST" action="?/assignAll" use:enhance={() => {
							return async ({ update }) => {
								showAssignAllConfirm = false;
								await update();
							};
						}}>
							<button type="submit" class="px-3 py-1.5 bg-green-600 text-white text-sm rounded hover:bg-green-700">
								Confirm
							</button>
						</form>
						<button
							onclick={() => showAssignAllConfirm = false}
							class="px-3 py-1.5 bg-gray-300 text-gray-700 text-sm rounded hover:bg-gray-400"
						>
							Cancel
						</button>
					</div>
				{/if}
			</div>
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead class="bg-gray-50">
						<tr>
							<th class="text-left p-3 font-medium text-gray-600">Part Number</th>
							<th class="text-left p-3 font-medium text-gray-600">Name</th>
							<th class="text-left p-3 font-medium text-gray-600">Category</th>
							<th class="text-left p-3 font-medium text-gray-600">BOM Type</th>
							<th class="text-right p-3 font-medium text-gray-600">Inventory</th>
							<th class="text-right p-3 font-medium text-gray-600">Action</th>
						</tr>
					</thead>
					<tbody class="divide-y">
						{#each data.unregistered as part}
							<tr class="hover:bg-gray-50">
								<td class="p-3 font-mono text-xs">{part.partNumber}</td>
								<td class="p-3">{part.name}</td>
								<td class="p-3 text-gray-500">{part.category ?? '—'}</td>
								<td class="p-3">
									{#if part.bomType}
										<span class="px-2 py-0.5 rounded text-xs font-medium {part.bomType === 'spu' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}">
											{part.bomType.toUpperCase()}
										</span>
									{/if}
								</td>
								<td class="p-3 text-right">{part.inventoryCount}</td>
								<td class="p-3 text-right">
									<form method="POST" action="?/assignBarcode" use:enhance>
										<input type="hidden" name="partDefinitionId" value={part.id} />
										<button type="submit" class="px-3 py-1.5 bg-green-600 text-white text-xs rounded hover:bg-green-700">
											Assign Barcode
										</button>
									</form>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{/if}

	<!-- Registered Parts -->
	<div class="bg-white rounded-lg shadow">
		<div class="flex items-center justify-between p-4 border-b">
			<h2 class="text-lg font-semibold text-gray-900">
				Registered Parts ({data.registered.length})
			</h2>
			{#if data.registered.length > 0}
				<div class="flex gap-2">
					<form method="POST" action="?/exportLabels" use:enhance={() => {
						return async ({ result }) => {
							if (result.type === 'success' && result.data?.html) {
								const w = window.open('', '_blank');
								if (w) { w.document.write(result.data.html); w.document.close(); }
							}
						};
					}}>
						<button type="submit" class="px-4 py-2 bg-gray-600 text-white text-sm rounded-lg hover:bg-gray-700">
							Print QR Labels
						</button>
					</form>
					<form method="POST" action="?/exportLabels" use:enhance={() => {
						return async ({ result }) => {
							if (result.type === 'success' && result.data?.csv) {
								const blob = new Blob([result.data.csv], { type: 'text/csv' });
								const url = URL.createObjectURL(blob);
								const a = document.createElement('a');
								a.href = url;
								a.download = `part-barcodes-${new Date().toISOString().slice(0, 10)}.csv`;
								a.click();
								URL.revokeObjectURL(url);
							}
						};
					}}>
						<input type="hidden" name="format" value="csv" />
						<button type="submit" class="px-4 py-2 bg-gray-500 text-white text-sm rounded-lg hover:bg-gray-600">
							Export CSV
						</button>
					</form>
				</div>
			{/if}
		</div>
		{#if data.registered.length > 0}
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead class="bg-gray-50">
						<tr>
							<th class="text-left p-3 font-medium text-gray-600">QR</th>
							<th class="text-left p-3 font-medium text-gray-600">Part Number</th>
							<th class="text-left p-3 font-medium text-gray-600">Name</th>
							<th class="text-left p-3 font-medium text-gray-600">Barcode</th>
							<th class="text-left p-3 font-medium text-gray-600">Category</th>
							<th class="text-left p-3 font-medium text-gray-600">BOM Type</th>
							<th class="text-right p-3 font-medium text-gray-600">Inventory</th>
						</tr>
					</thead>
					<tbody class="divide-y">
						{#each data.registered as part}
							<tr class="hover:bg-gray-50">
								<td class="p-3">
									{#if part.qrDataUrl}
										<img src={part.qrDataUrl} alt={part.barcode} class="w-10 h-10" />
									{/if}
								</td>
								<td class="p-3 font-mono text-xs">{part.partNumber}</td>
								<td class="p-3">{part.name}</td>
								<td class="p-3">
									<span class="font-mono text-xs bg-gray-100 px-2 py-1 rounded">{part.barcode}</span>
								</td>
								<td class="p-3 text-gray-500">{part.category ?? '—'}</td>
								<td class="p-3">
									{#if part.bomType}
										<span class="px-2 py-0.5 rounded text-xs font-medium {part.bomType === 'spu' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}">
											{part.bomType.toUpperCase()}
										</span>
									{/if}
								</td>
								<td class="p-3 text-right">{part.inventoryCount}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else}
			<div class="p-8 text-center text-gray-500">
				No parts have barcodes assigned yet. Use the section above to assign them.
			</div>
		{/if}
	</div>
</div>
