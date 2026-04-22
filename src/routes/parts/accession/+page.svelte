<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';

	let { data, form } = $props();

	let showAssignAllConfirm = $state(false);

	// Register Barcode state
	let rbPartId = $state('');
	let rbBarcode = $state('');
	let rbRegistrations = $state<Array<{ partNumber: string; partName: string; barcode: string; wasOverwrite: boolean }>>([]);
	let rbBarcodeInput: HTMLInputElement | undefined = $state();

	let rbSelectedPart = $derived(
		rbPartId ? [...data.registered, ...data.unregistered].find(p => p.id === rbPartId) : null
	);
	let rbCurrentBarcode = $derived(
		rbSelectedPart && 'barcode' in rbSelectedPart ? (rbSelectedPart as any).barcode : null
	);

	// Quick Scan state
	let qsPartId = $state('');
	let qsBagBarcode = $state('');
	let qsQuantity = $state('');
	let qsNotes = $state('');
	let qsLookupStatus = $state<'idle' | 'checking' | 'available' | 'exists'>('idle');
	let qsLookupInfo = $state('');
	let qsScans = $state<Array<{ barcode: string; partNumber: string; quantity: number; lotNumber: string }>>([]);
	let qsPartScanInput: HTMLInputElement | undefined = $state();
	let qsBarcodeInput: HTMLInputElement | undefined = $state();
	let qsQtyInput: HTMLInputElement | undefined = $state();
	let qsLookupTimer: ReturnType<typeof setTimeout> | undefined;

	// Scan Part Barcode to auto-select
	let qsPartScan = $state('');
	let qsPartScanStatus = $state<'idle' | 'checking' | 'found' | 'not-found'>('idle');
	let qsPartScanInfo = $state('');

	// Lot History filter state (echoed from server)
	let lotSearch = $state(data.filters?.q ?? '');
	let lotPartFilter = $state(data.filters?.partId ?? '');
	let lotStatusFilter = $state(data.filters?.status ?? '');
	let lotFromFilter = $state(data.filters?.from ?? '');
	let lotToFilter = $state(data.filters?.to ?? '');
	let hasLotFilters = $derived(
		Boolean(lotSearch || lotPartFilter || lotStatusFilter || lotFromFilter || lotToFilter)
	);

	function applyLotFilters() {
		const params = new URLSearchParams();
		if (lotSearch) params.set('q', lotSearch);
		if (lotPartFilter) params.set('partId', lotPartFilter);
		if (lotStatusFilter) params.set('status', lotStatusFilter);
		if (lotFromFilter) params.set('from', lotFromFilter);
		if (lotToFilter) params.set('to', lotToFilter);
		const qs = params.toString();
		goto(qs ? `${page.url.pathname}?${qs}#lot-history` : `${page.url.pathname}#lot-history`, { invalidateAll: true, keepFocus: true });
	}

	function clearLotFilters() {
		lotSearch = '';
		lotPartFilter = '';
		lotStatusFilter = '';
		lotFromFilter = '';
		lotToFilter = '';
		goto(`${page.url.pathname}#lot-history`, { invalidateAll: true, keepFocus: true });
	}

	function lotStatusClass(s: string): string {
		if (s === 'accepted') return 'bg-green-100 text-green-800 border-green-300';
		if (s === 'rejected') return 'bg-red-100 text-red-800 border-red-300';
		if (s === 'returned') return 'bg-amber-100 text-amber-800 border-amber-300';
		if (s === 'in_progress') return 'bg-blue-100 text-blue-800 border-blue-300';
		return 'bg-gray-100 text-gray-800 border-gray-300';
	}

	function formatDate(d: string | Date | null | undefined): string {
		if (!d) return '—';
		try {
			return new Date(d).toLocaleDateString();
		} catch {
			return '—';
		}
	}

	async function handlePartScan(e: KeyboardEvent) {
		if (e.key !== 'Enter') return;
		e.preventDefault();
		const barcode = qsPartScan.trim();
		if (!barcode) return;
		qsPartScanStatus = 'checking';
		try {
			const res = await fetch(`/api/parts/lookup-by-barcode?barcode=${encodeURIComponent(barcode)}`);
			if (res.ok) {
				const result = await res.json();
				qsPartId = result.id;
				qsPartScanStatus = 'found';
				qsPartScanInfo = `${result.partNumber} — ${result.name}`;
				setTimeout(() => qsBarcodeInput?.focus(), 50);
			} else {
				qsPartScanStatus = 'not-found';
				qsPartScanInfo = `No part found for barcode "${barcode}"`;
			}
		} catch {
			qsPartScanStatus = 'not-found';
			qsPartScanInfo = 'Lookup failed — check connection';
		}
	}

	function handleBagBarcodeKeydown(e: KeyboardEvent) {
		if (e.key !== 'Enter') return;
		e.preventDefault();
		if (qsLookupStatus === 'exists') return;
		if (qsBagBarcode.trim()) {
			setTimeout(() => qsQtyInput?.focus(), 30);
		}
	}

	function handleBarcodeInput(value: string) {
		qsBagBarcode = value;
		qsLookupStatus = 'idle';
		qsLookupInfo = '';
		if (qsLookupTimer) clearTimeout(qsLookupTimer);
		if (!value.trim()) return;
		qsLookupTimer = setTimeout(async () => {
			qsLookupStatus = 'checking';
			try {
				const res = await fetch(`/api/parts/lookup?barcode=${encodeURIComponent(value.trim())}`);
				if (res.ok) {
					const data = await res.json();
					qsLookupStatus = 'exists';
					qsLookupInfo = `Already registered as Lot #${data.lot.lotNumber} for ${data.lot.part?.name || data.lot.part?.partNumber || 'unknown part'}`;
				} else if (res.status === 404) {
					qsLookupStatus = 'available';
					qsLookupInfo = '';
				} else {
					qsLookupStatus = 'idle';
				}
			} catch {
				qsLookupStatus = 'idle';
			}
		}, 300);
	}

	function resetQuickScan() {
		qsPartScan = '';
		qsPartScanStatus = 'idle';
		qsPartScanInfo = '';
		qsPartId = '';
		qsBagBarcode = '';
		qsQuantity = '';
		qsLookupStatus = 'idle';
		qsLookupInfo = '';
	}
</script>

<svelte:head>
	<title>ROG — Receiving / Part Accession</title>
</svelte:head>

<div class="max-w-6xl mx-auto p-6">
	<!-- Header -->
	<div class="flex items-center justify-between mb-4">
		<div>
			<h1 class="text-2xl font-bold text-gray-900">ROG</h1>
			<p class="text-sm text-gray-500 mt-1">Scan inventory in, register part barcodes, and review recent lots</p>
		</div>
		<a href="/parts" class="text-sm text-blue-600 hover:text-blue-800">&larr; Back to Parts</a>
	</div>

	<!-- Section nav -->
	<nav class="flex flex-wrap gap-2 mb-6 text-sm">
		<a href="#quick-scan" class="px-3 py-1.5 bg-white border border-gray-300 rounded-lg hover:border-blue-400 hover:text-blue-700">Quick Scan</a>
		<a href="#lot-history" class="px-3 py-1.5 bg-white border border-gray-300 rounded-lg hover:border-blue-400 hover:text-blue-700">Lot History ({data.lots?.length ?? 0})</a>
		<a href="#register-barcodes" class="px-3 py-1.5 bg-white border border-gray-300 rounded-lg hover:border-blue-400 hover:text-blue-700">Register Barcodes</a>
		{#if data.unregistered.length > 0}
			<a href="#unregistered" class="px-3 py-1.5 bg-amber-50 border border-amber-300 text-amber-700 rounded-lg hover:border-amber-500">Unregistered ({data.unregistered.length})</a>
		{/if}
		<a href="#registered" class="px-3 py-1.5 bg-white border border-gray-300 rounded-lg hover:border-blue-400 hover:text-blue-700">Registered ({data.registered.length})</a>
	</nav>

	<!-- Progress Summary -->
	<div class="bg-white rounded-lg shadow p-4 mb-6">
		<div class="flex items-center justify-between mb-2">
			<span class="text-sm font-medium text-gray-700">Part Barcode Registration</span>
			<span class="text-sm text-gray-500">{data.counts.registered} of {data.counts.total} parts registered</span>
		</div>
		<div class="w-full bg-gray-200 rounded-full h-3">
			<div class="bg-green-500 h-3 rounded-full transition-all" style="width: {data.counts.total > 0 ? (data.counts.registered / data.counts.total) * 100 : 0}%"></div>
		</div>
		{#if data.counts.unregistered > 0}
			<p class="text-sm text-amber-600 mt-2">{data.counts.unregistered} part{data.counts.unregistered !== 1 ? 's' : ''} need barcode assignment</p>
		{:else}
			<p class="text-sm text-green-600 mt-2">All parts have barcodes assigned</p>
		{/if}
	</div>

	<!-- Success/Error Messages -->
	{#if form?.success}
		<div class="bg-green-50 border border-green-200 rounded-lg p-3 mb-4">
			<p class="text-green-800 text-sm">Barcode <strong>{form.barcode}</strong> assigned to {form.partNumber}</p>
		</div>
	{/if}
	{#if form?.assignAllSuccess}
		<div class="bg-green-50 border border-green-200 rounded-lg p-3 mb-4">
			<p class="text-green-800 text-sm font-medium">Assigned {form.count} barcode{form.count !== 1 ? 's' : ''}</p>
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
	{#if form?.quickScanSuccess}
		<div class="bg-green-50 border border-green-200 rounded-lg p-4 mb-4 flex items-start gap-3">
			<span class="text-green-600 text-2xl leading-none">✓</span>
			<div class="flex-1">
				<p class="text-green-900 font-semibold">Lot accessioned</p>
				<p class="text-green-800 text-sm mt-1">
					<strong>{form.quantity}</strong> units of <strong>{form.partNumber}</strong> as Lot <strong>{form.lotNumber}</strong> (barcode: <span class="font-mono">{form.bagBarcode}</span>)
				</p>
			</div>
		</div>
	{/if}
	{#if form?.registerSuccess}
		<div class="bg-green-50 border border-green-200 rounded-lg p-3 mb-4">
			<p class="text-green-800 text-sm">
				{#if form.wasOverwrite}
					Barcode updated for <strong>{form.registeredPartNumber}</strong>: <span class="line-through text-gray-400">{form.oldBarcode}</span> &rarr; <strong class="font-mono">{form.registeredBarcode}</strong>
				{:else}
					Barcode <strong class="font-mono">{form.registeredBarcode}</strong> registered to <strong>{form.registeredPartNumber}</strong> ({form.registeredPartName})
				{/if}
			</p>
		</div>
	{/if}
	{#if form?.registerError}
		<div class="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
			<p class="text-red-800 text-sm">{form.registerError}</p>
		</div>
	{/if}
	{#if form?.error}
		<div class="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
			<p class="text-red-800 text-sm">{form.error}</p>
		</div>
	{/if}

	<!-- ===== Quick Scan Accession (PRIMARY workflow — moved to top) ===== -->
	<section id="quick-scan" class="bg-white rounded-lg shadow mb-6 scroll-mt-4 border-l-4 border-green-500">
		<div class="p-4 border-b">
			<h2 class="text-lg font-semibold text-gray-900">📦 Quick Scan Accession</h2>
			<p class="text-sm text-gray-500 mt-1">Scan part → scan bag → enter quantity. Press Enter between fields.</p>
		</div>
		<div class="p-4">
			<form method="POST" action="?/quickScan" use:enhance={() => {
				return async ({ result, update }) => {
					if (result.type === 'success' && result.data?.quickScanSuccess) {
						qsScans = [{ barcode: result.data.bagBarcode as string, partNumber: result.data.partNumber as string, quantity: result.data.quantity as number, lotNumber: result.data.lotNumber as string }, ...qsScans];
						resetQuickScan();
						await update({ reset: false });
						setTimeout(() => qsPartScanInput?.focus(), 50);
					} else {
						await update();
					}
				};
			}}>
				<!-- Step 1: Scan part barcode (primary entry point, autofocus) -->
				<div class="mb-4">
					<label for="qs-part-scan" class="block text-sm font-semibold text-gray-700 mb-1">
						<span class="inline-flex items-center justify-center w-5 h-5 mr-1 bg-blue-100 text-blue-700 rounded-full text-xs">1</span>
						Scan Part Barcode
					</label>
					<div class="flex items-center gap-3">
						<input
							id="qs-part-scan"
							type="text"
							bind:this={qsPartScanInput}
							bind:value={qsPartScan}
							onkeydown={handlePartScan}
							onfocus={() => { qsPartScan = ''; qsPartScanStatus = 'idle'; qsPartScanInfo = ''; }}
							autofocus
							placeholder="Scan or type part barcode, then press Enter"
							class="flex-1 border-2 border-blue-300 rounded-lg px-3 py-2.5 text-base focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
						/>
						<div class="text-sm w-72 shrink-0">
							{#if qsPartScanStatus === 'checking'}<span class="text-gray-500">Checking…</span>{/if}
							{#if qsPartScanStatus === 'found'}<span class="text-green-700 font-semibold">✓ {qsPartScanInfo}</span>{/if}
							{#if qsPartScanStatus === 'not-found'}<span class="text-red-700">✗ {qsPartScanInfo}</span>{/if}
						</div>
					</div>
				</div>

				<!-- Steps 2-4: bag barcode, qty, notes -->
				<div class="grid grid-cols-1 md:grid-cols-12 gap-3">
					<div class="md:col-span-4">
						<label for="qs-part" class="block text-sm font-medium text-gray-700 mb-1">Part (auto-filled by scan)</label>
						<select id="qs-part" name="partId" bind:value={qsPartId} required class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
							<option value="">Select a part…</option>
							{#each [...data.registered, ...data.unregistered] as part}
								<option value={part.id}>{part.partNumber} — {part.name}</option>
							{/each}
						</select>
					</div>
					<div class="md:col-span-4">
						<label for="qs-barcode" class="block text-sm font-medium text-gray-700 mb-1">
							<span class="inline-flex items-center justify-center w-5 h-5 mr-1 bg-blue-100 text-blue-700 rounded-full text-xs">2</span>
							Bag Barcode
						</label>
						<div class="relative">
							<input
								id="qs-barcode"
								name="bagBarcode"
								type="text"
								bind:this={qsBarcodeInput}
								value={qsBagBarcode}
								oninput={(e) => handleBarcodeInput(e.currentTarget.value)}
								onkeydown={handleBagBarcodeKeydown}
								required
								placeholder="Scan bag barcode"
								class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm pr-8 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 {qsLookupStatus === 'exists' ? 'border-amber-400' : qsLookupStatus === 'available' ? 'border-green-400' : ''}"
							/>
							<span class="absolute right-2 top-2.5 text-gray-400">
								{#if qsLookupStatus === 'checking'}⏳{:else if qsLookupStatus === 'available'}✅{:else if qsLookupStatus === 'exists'}⚠️{:else}🔍{/if}
							</span>
						</div>
						{#if qsLookupStatus === 'exists'}
							<p class="text-xs text-amber-700 mt-1">{qsLookupInfo}</p>
						{:else if qsLookupStatus === 'available'}
							<p class="text-xs text-green-700 mt-1">Barcode is available</p>
						{/if}
					</div>
					<div class="md:col-span-2">
						<label for="qs-qty" class="block text-sm font-medium text-gray-700 mb-1">
							<span class="inline-flex items-center justify-center w-5 h-5 mr-1 bg-blue-100 text-blue-700 rounded-full text-xs">3</span>
							Quantity
						</label>
						<input
							id="qs-qty"
							name="quantity"
							type="number"
							min="1"
							bind:this={qsQtyInput}
							bind:value={qsQuantity}
							required
							placeholder="0"
							class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
						/>
					</div>
					<div class="md:col-span-2 flex items-end">
						<button
							type="submit"
							class="w-full px-4 py-2 bg-green-600 text-white text-sm font-semibold rounded-lg hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
							disabled={qsLookupStatus === 'exists' || !qsPartId || !qsBagBarcode || !qsQuantity}
						>
							Accession
						</button>
					</div>
				</div>
				<div class="mt-3">
					<label for="qs-notes" class="block text-xs text-gray-500 mb-1">Notes (optional)</label>
					<input id="qs-notes" name="notes" type="text" bind:value={qsNotes} placeholder="Optional notes" class="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
				</div>
			</form>
		</div>

		{#if qsScans.length > 0}
			<div class="border-t p-4 bg-gray-50 rounded-b-lg">
				<h3 class="text-sm font-semibold text-gray-700 mb-2">This Session ({qsScans.length})</h3>
				<div class="max-h-48 overflow-y-auto">
					<table class="w-full text-sm">
						<thead>
							<tr class="text-left text-gray-600">
								<th class="p-2 font-medium">Barcode</th>
								<th class="p-2 font-medium">Part</th>
								<th class="p-2 font-medium text-right">Qty</th>
								<th class="p-2 font-medium">Lot #</th>
							</tr>
						</thead>
						<tbody class="divide-y bg-white">
							{#each qsScans as scan}
								<tr>
									<td class="p-2 font-mono text-xs">{scan.barcode}</td>
									<td class="p-2">{scan.partNumber}</td>
									<td class="p-2 text-right">{scan.quantity}</td>
									<td class="p-2 font-mono text-xs">{scan.lotNumber}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<div class="mt-2 text-sm text-gray-500 flex gap-4">
					<span>Total scans: <strong>{qsScans.length}</strong></span>
					<span>Total units: <strong>{qsScans.reduce((sum, s) => sum + s.quantity, 0)}</strong></span>
				</div>
			</div>
		{/if}
	</section>

	<!-- ===== Lot History ===== -->
	<section id="lot-history" class="bg-white rounded-lg shadow mb-6 scroll-mt-4">
		<div class="p-4 border-b flex items-center justify-between">
			<div>
				<h2 class="text-lg font-semibold text-gray-900">📜 Lot History</h2>
				<p class="text-sm text-gray-500 mt-1">All receiving lots — newest first (max 100). Click any row for details.</p>
			</div>
			{#if hasLotFilters}
				<button onclick={clearLotFilters} class="text-xs text-gray-600 hover:text-gray-900 underline">Clear filters</button>
			{/if}
		</div>

		<!-- Filter row -->
		<div class="p-4 border-b bg-gray-50 grid grid-cols-1 md:grid-cols-12 gap-3">
			<div class="md:col-span-4">
				<label for="lot-search" class="block text-xs text-gray-500 mb-1">Search (lot #, barcode, part)</label>
				<input id="lot-search" type="text" bind:value={lotSearch} onkeydown={(e) => { if (e.key === 'Enter') applyLotFilters(); }} placeholder="LOT-…, barcode, or part name" class="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
			</div>
			<div class="md:col-span-3">
				<label for="lot-part" class="block text-xs text-gray-500 mb-1">Part</label>
				<select id="lot-part" bind:value={lotPartFilter} class="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
					<option value="">All parts</option>
					{#each data.partOptions ?? [] as p}
						<option value={p.id}>{p.partNumber} — {p.name}</option>
					{/each}
				</select>
			</div>
			<div class="md:col-span-2">
				<label for="lot-status" class="block text-xs text-gray-500 mb-1">Status</label>
				<select id="lot-status" bind:value={lotStatusFilter} class="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
					<option value="">All</option>
					<option value="in_progress">In Progress</option>
					<option value="accepted">Accepted</option>
					<option value="rejected">Rejected</option>
					<option value="returned">Returned</option>
					<option value="other">Other</option>
				</select>
			</div>
			<div class="md:col-span-1">
				<label for="lot-from" class="block text-xs text-gray-500 mb-1">From</label>
				<input id="lot-from" type="date" bind:value={lotFromFilter} class="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
			</div>
			<div class="md:col-span-1">
				<label for="lot-to" class="block text-xs text-gray-500 mb-1">To</label>
				<input id="lot-to" type="date" bind:value={lotToFilter} class="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
			</div>
			<div class="md:col-span-1 flex items-end">
				<button type="button" onclick={applyLotFilters} class="w-full px-3 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700">Apply</button>
			</div>
		</div>

		<!-- Lot table -->
		{#if (data.lots?.length ?? 0) === 0}
			<div class="p-8 text-center text-gray-500 text-sm">No lots match these filters.</div>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead class="bg-gray-50">
						<tr>
							<th class="text-left p-3 font-medium text-gray-600">Lot #</th>
							<th class="text-left p-3 font-medium text-gray-600">Bag Barcode</th>
							<th class="text-left p-3 font-medium text-gray-600">Part</th>
							<th class="text-right p-3 font-medium text-gray-600">Qty</th>
							<th class="text-left p-3 font-medium text-gray-600">Status</th>
							<th class="text-left p-3 font-medium text-gray-600">Path</th>
							<th class="text-left p-3 font-medium text-gray-600">Operator</th>
							<th class="text-left p-3 font-medium text-gray-600">Created</th>
						</tr>
					</thead>
					<tbody class="divide-y">
						{#each data.lots as lot}
							<tr class="hover:bg-blue-50 cursor-pointer" onclick={() => goto(`/parts/accession/${lot.id}`)}>
								<td class="p-3 font-mono text-xs">
									<a href="/parts/accession/{lot.id}" class="text-blue-600 hover:underline">{lot.lotNumber || lot.lotId}</a>
								</td>
								<td class="p-3 font-mono text-xs text-gray-600">{lot.bagBarcode || '—'}</td>
								<td class="p-3">{lot.partNumber} <span class="text-gray-500">— {lot.partName}</span></td>
								<td class="p-3 text-right font-medium">{lot.quantity}</td>
								<td class="p-3">
									<span class="inline-block rounded-full border px-2 py-0.5 text-xs {lotStatusClass(lot.status)}">{lot.status}</span>
								</td>
								<td class="p-3 text-xs uppercase text-gray-600">{lot.inspectionPathway || '—'}</td>
								<td class="p-3 text-xs text-gray-600">{lot.operatorUsername || '—'}</td>
								<td class="p-3 text-xs text-gray-600">{formatDate(lot.createdAt)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	<!-- ===== Register Part Barcodes ===== -->
	<section id="register-barcodes" class="bg-white rounded-lg shadow mb-6 scroll-mt-4">
		<div class="p-4 border-b">
			<h2 class="text-lg font-semibold text-gray-900">📋 Register Part Barcodes</h2>
			<p class="text-sm text-gray-500 mt-1">Scan your own physical barcode labels and link them to parts</p>
		</div>
		<div class="p-4">
			<form method="POST" action="?/registerBarcode" use:enhance={() => {
				return async ({ result, update }) => {
					if (result.type === 'success' && result.data?.registerSuccess) {
						rbRegistrations = [{
							partNumber: result.data.registeredPartNumber as string,
							partName: result.data.registeredPartName as string,
							barcode: result.data.registeredBarcode as string,
							wasOverwrite: result.data.wasOverwrite as boolean
						}, ...rbRegistrations];
						rbBarcode = '';
						await update();
						setTimeout(() => rbBarcodeInput?.focus(), 50);
					} else {
						await update();
					}
				};
			}}>
				<div class="grid grid-cols-1 md:grid-cols-3 gap-4">
					<div>
						<label for="rb-part" class="block text-sm font-medium text-gray-700 mb-1">Part</label>
						<select id="rb-part" name="partId" bind:value={rbPartId} required class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
							<option value="">Select a part…</option>
							{#each [...data.registered, ...data.unregistered] as part}
								<option value={part.id}>{part.partNumber} — {part.name}</option>
							{/each}
						</select>
						{#if rbCurrentBarcode}
							<p class="text-xs text-amber-600 mt-1">Current barcode: <span class="font-mono">{rbCurrentBarcode}</span> — registering will overwrite</p>
						{/if}
					</div>
					<div>
						<label for="rb-barcode" class="block text-sm font-medium text-gray-700 mb-1">Scan Barcode</label>
						<input id="rb-barcode" name="barcode" type="text" bind:this={rbBarcodeInput} bind:value={rbBarcode} onfocus={() => rbBarcode = ''} required placeholder="Scan physical barcode label" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
					</div>
					<div class="flex items-end">
						<button type="submit" class="px-6 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 whitespace-nowrap" disabled={!rbPartId || !rbBarcode}>Register</button>
					</div>
				</div>
			</form>
		</div>

		{#if rbRegistrations.length > 0}
			<div class="border-t p-4">
				<h3 class="text-sm font-semibold text-gray-700 mb-2">Just Registered ({rbRegistrations.length})</h3>
				<div class="max-h-48 overflow-y-auto">
					<table class="w-full text-sm">
						<thead class="bg-gray-50">
							<tr>
								<th class="text-left p-2 font-medium text-gray-600">Part</th>
								<th class="text-left p-2 font-medium text-gray-600">Name</th>
								<th class="text-left p-2 font-medium text-gray-600">Barcode</th>
								<th class="text-left p-2 font-medium text-gray-600">Status</th>
							</tr>
						</thead>
						<tbody class="divide-y">
							{#each rbRegistrations as reg}
								<tr>
									<td class="p-2 font-mono text-xs">{reg.partNumber}</td>
									<td class="p-2">{reg.partName}</td>
									<td class="p-2 font-mono text-xs">{reg.barcode}</td>
									<td class="p-2 text-xs">
										{#if reg.wasOverwrite}
											<span class="text-amber-600">Overwritten</span>
										{:else}
											<span class="text-green-600">New</span>
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</div>
		{/if}
	</section>

	<!-- ===== Unregistered Parts ===== -->
	{#if data.unregistered.length > 0}
		<section id="unregistered" class="bg-white rounded-lg shadow mb-6 scroll-mt-4">
			<div class="flex items-center justify-between p-4 border-b">
				<h2 class="text-lg font-semibold text-gray-900">Unregistered Parts ({data.unregistered.length})</h2>
				{#if !showAssignAllConfirm}
					<button onclick={() => showAssignAllConfirm = true} class="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700">Assign All Barcodes</button>
				{:else}
					<div class="flex items-center gap-2">
						<span class="text-sm text-amber-600">Assign system barcodes to all {data.unregistered.length} unregistered parts? This will NOT overwrite manually registered barcodes.</span>
						<form method="POST" action="?/assignAll" use:enhance={() => {
							return async ({ update }) => {
								showAssignAllConfirm = false;
								await update();
							};
						}}>
							<button type="submit" class="px-3 py-1.5 bg-green-600 text-white text-sm rounded hover:bg-green-700">Confirm</button>
						</form>
						<button onclick={() => showAssignAllConfirm = false} class="px-3 py-1.5 bg-gray-300 text-gray-700 text-sm rounded hover:bg-gray-400">Cancel</button>
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
										<span class="px-2 py-0.5 rounded text-xs font-medium {part.bomType === 'spu' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}">{part.bomType.toUpperCase()}</span>
									{/if}
								</td>
								<td class="p-3 text-right">{part.inventoryCount}</td>
								<td class="p-3 text-right">
									<form method="POST" action="?/assignBarcode" use:enhance>
										<input type="hidden" name="partDefinitionId" value={part.id} />
										<button type="submit" class="px-3 py-1.5 bg-green-600 text-white text-xs rounded hover:bg-green-700">Assign Barcode</button>
									</form>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{/if}

	<!-- ===== Registered Parts ===== -->
	<section id="registered" class="bg-white rounded-lg shadow scroll-mt-4">
		<div class="flex items-center justify-between p-4 border-b">
			<h2 class="text-lg font-semibold text-gray-900">Registered Parts ({data.registered.length})</h2>
			{#if data.registered.length > 0}
				<div class="flex gap-2">
					<form method="POST" action="?/exportLabels" use:enhance={() => {
						return async ({ result }) => {
							if (result.type === 'success' && result.data?.html) {
								const w = window.open('', '_blank');
								if (w) { w.document.write(result.data.html as string); w.document.close(); }
							}
						};
					}}>
						<button type="submit" class="px-4 py-2 bg-gray-600 text-white text-sm rounded-lg hover:bg-gray-700">Print QR Labels</button>
					</form>
					<form method="POST" action="?/exportLabels" use:enhance={() => {
						return async ({ result }) => {
							if (result.type === 'success' && result.data?.csv) {
								const blob = new Blob([result.data.csv as string], { type: 'text/csv' });
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
						<button type="submit" class="px-4 py-2 bg-gray-500 text-white text-sm rounded-lg hover:bg-gray-600">Export CSV</button>
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
								<td class="p-3"><span class="font-mono text-xs bg-gray-100 px-2 py-1 rounded">{part.barcode}</span></td>
								<td class="p-3 text-gray-500">{part.category ?? '—'}</td>
								<td class="p-3">
									{#if part.bomType}
										<span class="px-2 py-0.5 rounded text-xs font-medium {part.bomType === 'spu' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}">{part.bomType.toUpperCase()}</span>
									{/if}
								</td>
								<td class="p-3 text-right">{part.inventoryCount}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else}
			<div class="p-8 text-center text-gray-500">No parts have barcodes assigned yet. Use the section above to assign them.</div>
		{/if}
	</section>
</div>
