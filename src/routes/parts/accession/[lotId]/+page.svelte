<script lang="ts">
	let { data } = $props();
	const lot = $derived(data.lot);

	function formatDate(d: string | Date | null | undefined): string {
		if (!d) return '—';
		try {
			return new Date(d).toLocaleString();
		} catch {
			return '—';
		}
	}

	function statusClass(s: string): string {
		if (s === 'accepted') return 'bg-green-100 text-green-800 border-green-300';
		if (s === 'rejected') return 'bg-red-100 text-red-800 border-red-300';
		if (s === 'returned') return 'bg-amber-100 text-amber-800 border-amber-300';
		if (s === 'in_progress') return 'bg-blue-100 text-blue-800 border-blue-300';
		return 'bg-gray-100 text-gray-800 border-gray-300';
	}
</script>

<svelte:head>
	<title>Lot {lot.lotNumber || lot.lotId} — ROG</title>
</svelte:head>

<div class="max-w-5xl mx-auto p-6 space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<a href="/parts/accession" class="text-sm text-blue-600 hover:text-blue-800">&larr; Back to ROG</a>
			<h1 class="mt-2 text-2xl font-bold text-gray-900">Lot {lot.lotNumber || lot.lotId}</h1>
			<p class="text-sm text-gray-500 mt-1">Read-only view. Disposition workflow pending.</p>
		</div>
		<span class="rounded-full border px-3 py-1 text-sm font-medium {statusClass(lot.status)}">{lot.status}</span>
	</div>

	<!-- Core info card -->
	<div class="bg-white rounded-lg shadow p-6">
		<h2 class="text-lg font-semibold text-gray-900 mb-4">Lot Details</h2>
		<dl class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
			<div>
				<dt class="text-gray-500">Lot ID (scanned barcode)</dt>
				<dd class="mt-1 font-mono text-gray-900">{lot.lotId || '—'}</dd>
			</div>
			<div>
				<dt class="text-gray-500">Lot Number</dt>
				<dd class="mt-1 font-mono text-gray-900">{lot.lotNumber || '—'}</dd>
			</div>
			<div>
				<dt class="text-gray-500">Bag Barcode</dt>
				<dd class="mt-1 font-mono text-gray-900">{lot.bagBarcode || '—'}</dd>
			</div>
			<div>
				<dt class="text-gray-500">Vendor Lot #</dt>
				<dd class="mt-1 font-mono text-gray-900">{lot.vendorLotNumber || '—'}</dd>
			</div>
			<div>
				<dt class="text-gray-500">Part</dt>
				<dd class="mt-1 text-gray-900">
					{#if lot.part?._id}
						<a href="/parts/{lot.part._id}" class="text-blue-600 hover:underline">
							{lot.part.partNumber} — {lot.part.name}
						</a>
					{:else}
						—
					{/if}
				</dd>
			</div>
			<div>
				<dt class="text-gray-500">Quantity</dt>
				<dd class="mt-1 text-gray-900 font-semibold">{lot.quantity ?? 0}{lot.consumedUl ? ` (${lot.consumedUl} consumed)` : ''}</dd>
			</div>
			<div>
				<dt class="text-gray-500">Inspection Pathway</dt>
				<dd class="mt-1 text-gray-900 uppercase">{lot.inspectionPathway || '—'}</dd>
			</div>
			<div>
				<dt class="text-gray-500">CoC Meets Standards</dt>
				<dd class="mt-1 text-gray-900">{lot.cocMeetsStandards == null ? '—' : lot.cocMeetsStandards ? 'Yes' : 'No'}</dd>
			</div>
			<div>
				<dt class="text-gray-500">Operator</dt>
				<dd class="mt-1 text-gray-900">{lot.operator?.username || '—'}</dd>
			</div>
			<div>
				<dt class="text-gray-500">Created</dt>
				<dd class="mt-1 text-gray-900">{formatDate(lot.createdAt)}</dd>
			</div>
			<div>
				<dt class="text-gray-500">PO Reference</dt>
				<dd class="mt-1 font-mono text-gray-900">{lot.poReference || '—'}</dd>
			</div>
			<div>
				<dt class="text-gray-500">Supplier</dt>
				<dd class="mt-1 text-gray-900">{lot.supplier || '—'}</dd>
			</div>
			<div>
				<dt class="text-gray-500">Expiration</dt>
				<dd class="mt-1 text-gray-900">{formatDate(lot.expirationDate)}</dd>
			</div>
			<div>
				<dt class="text-gray-500">Storage / ESD</dt>
				<dd class="mt-1 text-gray-900">
					{lot.storageConditionsRequired ? 'Storage required' : 'No storage flag'}
					· {lot.esdHandlingRequired ? 'ESD required' : 'No ESD flag'}
				</dd>
			</div>
		</dl>
	</div>

	<!-- Notes -->
	{#if lot.notes}
		<div class="bg-white rounded-lg shadow p-6">
			<h2 class="text-lg font-semibold text-gray-900 mb-2">Notes</h2>
			<p class="text-sm text-gray-700 whitespace-pre-wrap">{lot.notes}</p>
		</div>
	{/if}

	<!-- CoC document & photos -->
	{#if lot.cocDocumentUrl || (lot.cocPhotos && lot.cocPhotos.length > 0)}
		<div class="bg-white rounded-lg shadow p-6">
			<h2 class="text-lg font-semibold text-gray-900 mb-3">CoC Evidence</h2>
			{#if lot.cocDocumentUrl}
				<a href={lot.cocDocumentUrl} target="_blank" class="inline-block text-blue-600 hover:underline text-sm mb-3">
					&rarr; Open CoC document
				</a>
			{/if}
			{#if lot.cocPhotos && lot.cocPhotos.length > 0}
				<div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
					{#each lot.cocPhotos as photo}
						{#if photo?.fileUrl}
							<a href={photo.fileUrl} target="_blank" class="block">
								<img src={photo.fileUrl} alt={photo.fileName || 'CoC photo'} class="w-full h-32 object-cover rounded border" />
								<p class="mt-1 text-xs text-gray-500 truncate">{photo.fileName || ''}</p>
							</a>
						{/if}
					{/each}
				</div>
			{/if}
		</div>
	{/if}

	<!-- IP results -->
	{#if lot.ipResults}
		<div class="bg-white rounded-lg shadow p-6">
			<h2 class="text-lg font-semibold text-gray-900 mb-3">Inspection Results</h2>
			<pre class="bg-gray-50 border border-gray-200 rounded p-3 text-xs overflow-x-auto">{JSON.stringify(lot.ipResults, null, 2)}</pre>
		</div>
	{/if}

	<!-- Disposition (if disposed) -->
	{#if lot.dispositionType || lot.disposedAt}
		<div class="bg-white rounded-lg shadow p-6">
			<h2 class="text-lg font-semibold text-gray-900 mb-3">Disposition</h2>
			<dl class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
				<div><dt class="text-gray-500">Type</dt><dd class="mt-1 text-gray-900">{lot.dispositionType || '—'}</dd></div>
				<div><dt class="text-gray-500">Disposed At</dt><dd class="mt-1 text-gray-900">{formatDate(lot.disposedAt)}</dd></div>
				<div><dt class="text-gray-500">Disposed By</dt><dd class="mt-1 text-gray-900">{lot.disposedBy?.username || '—'}</dd></div>
				<div><dt class="text-gray-500">NC / RMA</dt><dd class="mt-1 font-mono text-gray-900">{lot.ncNumber || '—'} · {lot.rmaNumber || '—'}</dd></div>
				{#if lot.totalRejects != null}
					<div><dt class="text-gray-500">Total Rejects</dt><dd class="mt-1 text-gray-900">{lot.totalRejects}</dd></div>
				{/if}
				{#if lot.defectDescription}
					<div class="md:col-span-2"><dt class="text-gray-500">Defect Description</dt><dd class="mt-1 text-gray-900 whitespace-pre-wrap">{lot.defectDescription}</dd></div>
				{/if}
				{#if lot.dispositionExplanation}
					<div class="md:col-span-2"><dt class="text-gray-500">Explanation</dt><dd class="mt-1 text-gray-900 whitespace-pre-wrap">{lot.dispositionExplanation}</dd></div>
				{/if}
			</dl>
		</div>
	{/if}
</div>
