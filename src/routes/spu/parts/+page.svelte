<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { TronCard, TronButton, TronBadge } from '$lib/components/ui';
	import { SvelteSet, SvelteURLSearchParams } from 'svelte/reactivity';

	let { data, form } = $props();

	// Tab state from URL
	const params = page.url.searchParams;
	let activeTab = $state<'spu' | 'cartridge'>(params.get('tab') === 'cartridge' ? 'cartridge' : 'spu');

	// Cartridge parts state
	let cartSearchQuery = $state('');
	let cartAddOpen = $state(false);
	let cartEditId = $state<string | null>(null);

	type CartSortColumn = 'partNumber' | 'name' | 'category' | 'quantityPerUnit' | 'inventoryCount' | 'unitCost' | 'totalValue';
	let cartSortColumn = $state<CartSortColumn>('partNumber');
	let cartSortDirection = $state<SortDirection>('asc');

	function toggleCartSort(column: CartSortColumn) {
		if (cartSortColumn !== column) {
			cartSortColumn = column;
			cartSortDirection = 'asc';
		} else if (cartSortDirection === 'asc') {
			cartSortDirection = 'desc';
		} else if (cartSortDirection === 'desc') {
			cartSortDirection = null;
		} else {
			cartSortDirection = 'asc';
		}
	}

	let filteredCartridgeParts = $derived.by(() => {
		let items = data.cartridgeParts ?? [];
		if (cartSearchQuery) {
			const q = cartSearchQuery.toLowerCase();
			items = items.filter(
				(i: { partNumber: string; name: string; manufacturer?: string | null }) =>
					i.partNumber.toLowerCase().includes(q) ||
					i.name.toLowerCase().includes(q) ||
					i.manufacturer?.toLowerCase().includes(q)
			);
		}
		if (cartSortDirection) {
			const dir = cartSortDirection === 'asc' ? 1 : -1;
			items = [...items].sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
				const av = a[cartSortColumn];
				const bv = b[cartSortColumn];
				if (av == null && bv == null) return 0;
				if (av == null) return 1;
				if (bv == null) return -1;
				if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv) * dir;
				return ((av as number) - (bv as number)) * dir;
			});
		}
		return items;
	});

	function switchTab(tab: 'spu' | 'cartridge') {
		activeTab = tab;
		const url = new URL(page.url);
		url.searchParams.set('tab', tab);
		history.replaceState(history.state, '', url.toString());
	}

	// Read initial filter state from URL params
	let searchQuery = $state(params.get('q') ?? '');
	let selectedCategory = $state(params.get('cat') ?? 'all');
	let syncing = $state(false);
	let filtersOpen = $state(!!params.get('fo'));
	let lowStockOpen = $state(false);
	let lowInventoryOpen = $state(false);
	let lowInvTab = $state<'zero' | 'low'>('zero');
	let syncErrorOpen = $state(false);

	// Numeric range filters (initialized from URL)
	let invMin = $state(params.get('invMin') ?? '');
	let invMax = $state(params.get('invMax') ?? '');
	let costMin = $state(params.get('costMin') ?? '');
	let costMax = $state(params.get('costMax') ?? '');
	let valMin = $state(params.get('valMin') ?? '');
	let valMax = $state(params.get('valMax') ?? '');
	let ltMin = $state(params.get('ltMin') ?? '');
	let ltMax = $state(params.get('ltMax') ?? '');

	// Classification multi-select (initialized from URL)
	let selectedClassifications = new SvelteSet<string>(params.getAll('cls'));

	// Manufacturer text search
	let manufacturerSearch = $state(params.get('mfr') ?? '');

	// Derive available manufacturers and classifications from data
	let manufacturers = $derived(
		[...new Set(data.items.map((i) => i.manufacturer).filter(Boolean))].sort() as string[]
	);
	let classifications = $derived(
		[...new Set(data.items.map((i) => i.category).filter(Boolean))].sort() as string[]
	);

	// Low inventory derived lists from lowestInventory data
	let zeroItems = $derived(
		(data.lowestInventory ?? []).filter((i: { inventoryCount: number }) => i.inventoryCount <= 0)
	);
	let lowItems = $derived(
		(data.lowestInventory ?? []).filter((i: { inventoryCount: number }) => i.inventoryCount > 0)
	);

	// Count active filters
	let activeFilterCount = $derived.by(() => {
		let count = 0;
		if (invMin || invMax) count++;
		if (costMin || costMax) count++;
		if (valMin || valMax) count++;
		if (ltMin || ltMax) count++;
		if (selectedClassifications.size > 0) count++;
		if (manufacturerSearch) count++;
		return count;
	});

	// Sync filter state to URL (without triggering navigation/load)
	$effect(() => {
		const p = new SvelteURLSearchParams();
		if (searchQuery) p.set('q', searchQuery);
		if (selectedCategory !== 'all') p.set('cat', selectedCategory);
		if (filtersOpen) p.set('fo', '1');
		if (invMin) p.set('invMin', invMin);
		if (invMax) p.set('invMax', invMax);
		if (costMin) p.set('costMin', costMin);
		if (costMax) p.set('costMax', costMax);
		if (valMin) p.set('valMin', valMin);
		if (valMax) p.set('valMax', valMax);
		if (ltMin) p.set('ltMin', ltMin);
		if (ltMax) p.set('ltMax', ltMax);
		for (const cls of selectedClassifications) p.append('cls', cls);
		if (manufacturerSearch) p.set('mfr', manufacturerSearch);

		const qs = p.toString();
		const url = qs ? `${page.url.pathname}?${qs}` : page.url.pathname;
		history.replaceState(history.state, '', url);
	});

	function clearAllFilters() {
		invMin = '';
		invMax = '';
		costMin = '';
		costMax = '';
		valMin = '';
		valMax = '';
		ltMin = '';
		ltMax = '';
		selectedClassifications.clear();
		manufacturerSearch = '';
		selectedCategory = 'all';
		searchQuery = '';
	}

	type SortColumn =
		| 'partNumber'
		| 'name'
		| 'category'
		| 'quantityPerUnit'
		| 'inventoryCount'
		| 'unitCost'
		| 'totalValue'
		| 'leadTimeDays';
	type SortDirection = 'asc' | 'desc' | null;

	let sortColumn = $state<SortColumn>('partNumber');
	let sortDirection = $state<SortDirection>('asc');

	function toggleSort(column: SortColumn) {
		if (sortColumn !== column) {
			sortColumn = column;
			sortDirection = 'asc';
		} else if (sortDirection === 'asc') {
			sortDirection = 'desc';
		} else if (sortDirection === 'desc') {
			sortDirection = null;
		} else {
			sortDirection = 'asc';
		}
	}

	function inRange(value: number | null, min: string, max: string): boolean {
		const v = value ?? 0;
		if (min && v < Number(min)) return false;
		if (max && v > Number(max)) return false;
		return true;
	}

	let filteredItems = $derived.by(() => {
		let items = data.items;

		// Category filter (from dropdown)
		if (selectedCategory !== 'all') {
			items = items.filter((i) => i.category === selectedCategory);
		}

		// Text search
		if (searchQuery) {
			const query = searchQuery.toLowerCase();
			items = items.filter(
				(i) =>
					i.partNumber.toLowerCase().includes(query) ||
					i.name.toLowerCase().includes(query) ||
					i.supplier?.toLowerCase().includes(query)
			);
		}

		// Classification multi-select
		if (selectedClassifications.size > 0) {
			items = items.filter((i) => i.category && selectedClassifications.has(i.category));
		}

		// Manufacturer text search
		if (manufacturerSearch) {
			const mfr = manufacturerSearch.toLowerCase();
			items = items.filter((i) => i.manufacturer?.toLowerCase().includes(mfr));
		}

		// Numeric range filters
		if (invMin || invMax) items = items.filter((i) => inRange(i.inventoryCount, invMin, invMax));
		if (costMin || costMax) items = items.filter((i) => inRange(i.unitCost, costMin, costMax));
		if (valMin || valMax) items = items.filter((i) => inRange(i.totalValue, valMin, valMax));
		if (ltMin || ltMax) items = items.filter((i) => inRange(i.leadTimeDays, ltMin, ltMax));

		// Sorting
		if (sortDirection) {
			const dir = sortDirection === 'asc' ? 1 : -1;
			items = [...items].sort((a, b) => {
				const av = a[sortColumn];
				const bv = b[sortColumn];
				if (av == null && bv == null) return 0;
				if (av == null) return 1;
				if (bv == null) return -1;
				if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv) * dir;
				return ((av as number) - (bv as number)) * dir;
			});
		}

		return items;
	});

	function toggleClassification(cls: string) {
		if (selectedClassifications.has(cls)) {
			selectedClassifications.delete(cls);
		} else {
			selectedClassifications.add(cls);
		}
	}

	function formatCurrency(value: number | null): string {
		if (value === null || value === undefined) return '—';
		if (isNaN(value)) return '—';
		return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
	}

	function formatDate(date: Date | string | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleDateString();
	}
</script>

<div class="space-y-6">
	<!-- Tab Switcher -->
	<div class="flex items-center gap-1 border-b border-[var(--color-tron-border)]">
		<button
			class="px-4 py-2 text-sm font-medium transition-colors {activeTab === 'spu' ? 'border-b-2 border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]' : 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}"
			onclick={() => switchTab('spu')}
		>
			SPU Parts
		</button>
		<button
			class="px-4 py-2 text-sm font-medium transition-colors {activeTab === 'cartridge' ? 'border-b-2 border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]' : 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}"
			onclick={() => switchTab('cartridge')}
		>
			Cartridge Parts
			{#if data.cartridgeBomSummary}
				<span class="ml-1 text-xs">({data.cartridgeBomSummary.totalParts})</span>
			{/if}
		</button>
	</div>

	{#if activeTab === 'spu'}
	<div class="flex items-center justify-between">
		<div>
			<h2 class="tron-text-primary font-mono text-2xl font-bold">SPU Parts</h2>
			<p class="tron-text-muted">Bill of Materials — synced from Box.com</p>
		</div>
		<div class="flex gap-2">
			{#if data.boxStatus.isConnected}
				<form
					method="POST"
					action="?/sync"
					use:enhance={() => {
						syncing = true;
						return async ({ update }) => {
							syncing = false;
							await update();
						};
					}}
				>
					<TronButton type="submit" variant="default" disabled={syncing}>
						<svg class="mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
							/>
						</svg>
						{syncing ? 'Syncing...' : 'Sync from Box'}
					</TronButton>
				</form>
			{:else}
				<!-- eslint-disable svelte/no-navigation-without-resolve -->
				<a href="/spu/bom/settings">
					<TronButton variant="default">Connect to Box</TronButton>
				</a>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
			{/if}
		</div>
	</div>

	{#if form?.error}
		<div class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-3">
			<p class="text-sm text-[var(--color-tron-red)]">{form.error}</p>
		</div>
	{/if}

	{#if form?.success}
		<div class="rounded border border-[var(--color-tron-green)] bg-[rgba(0,255,136,0.1)] p-3">
			<p class="text-sm text-[var(--color-tron-green)]">{form.message}</p>
		</div>
	{/if}

	<!-- Stats Cards -->
	<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
		<TronCard>
			<div class="text-center">
				<div class="tron-text-primary font-mono text-3xl font-bold">{data.stats.total}</div>
				<div class="tron-text-muted text-sm">Total Parts</div>
			</div>
		</TronCard>
		<TronCard>
			<div class="text-center">
				<div class="tron-text-primary font-mono text-3xl font-bold">{data.stats.categories}</div>
				<div class="tron-text-muted text-sm">Classifications</div>
			</div>
		</TronCard>
		<TronCard>
			<div class="text-center">
				<div class="font-mono text-3xl font-bold text-[var(--color-tron-cyan)]">
					{formatCurrency(data.stats.totalInventoryValue)}
				</div>
				<div class="tron-text-muted text-sm">Total Inventory Value</div>
			</div>
		</TronCard>
		<TronCard>
			<button
				class="w-full text-center"
				onclick={() => data.stats.lowStockCount > 0 && (lowStockOpen = !lowStockOpen)}
				class:cursor-pointer={data.stats.lowStockCount > 0}
				class:cursor-default={data.stats.lowStockCount === 0}
			>
				<div
					class="font-mono text-3xl font-bold {data.stats.lowStockCount > 0
						? 'text-[var(--color-tron-orange)]'
						: 'text-[var(--color-tron-green)]'}"
				>
					{data.stats.lowStockCount}
				</div>
				<div class="tron-text-muted inline-flex items-center gap-1 text-sm">
					Low Stock
					{#if data.stats.lowStockCount > 0}
						<svg
							class="h-3 w-3 transition-transform {lowStockOpen ? 'rotate-180' : ''}"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M19 9l-7 7-7-7"
							/>
						</svg>
					{/if}
				</div>
			</button>
			{#if lowStockOpen && data.lowStockItems.length > 0}
				<div class="mt-3 border-t border-[var(--color-tron-border)] pt-3">
					<div class="max-h-48 space-y-2 overflow-y-auto">
						{#each data.lowStockItems as item (item.id)}
							<div
								class="flex items-center justify-between rounded bg-[var(--color-tron-bg-primary)] px-2 py-1.5 text-xs"
							>
								<div class="min-w-0 flex-1">
									<!-- eslint-disable svelte/no-navigation-without-resolve -->
									<a
										href="/spu/parts/{item.id}"
										class="font-mono text-[var(--color-tron-cyan)] hover:underline"
										>{item.partNumber}</a
									>
									<!-- eslint-enable svelte/no-navigation-without-resolve -->
									<div class="tron-text-muted truncate">{item.name}</div>
								</div>
								<div class="ml-2 text-right font-mono">
									<span
										class={item.inventoryCount === 0
											? 'text-[var(--color-tron-red)]'
											: 'text-[var(--color-tron-orange)]'}>{item.inventoryCount}</span
									>
									<span class="tron-text-muted">/ {item.minimumStockLevel}</span>
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/if}
		</TronCard>
		<TronCard>
			<button
				class="w-full text-center"
				onclick={() =>
					data.boxStatus.lastSyncStatus === 'error' && (syncErrorOpen = !syncErrorOpen)}
				class:cursor-pointer={data.boxStatus.lastSyncStatus === 'error'}
				class:cursor-default={data.boxStatus.lastSyncStatus !== 'error'}
			>
				<div class="tron-text-muted text-sm">Last Sync</div>
				<div class="tron-text-primary font-mono text-lg">
					{data.boxStatus.lastSyncAt ? formatDate(data.boxStatus.lastSyncAt) : 'Never'}
				</div>
				{#if data.boxStatus.lastSyncStatus}
					<div class="inline-flex items-center gap-1">
						<TronBadge
							variant={data.boxStatus.lastSyncStatus === 'success'
								? 'success'
								: data.boxStatus.lastSyncStatus === 'error'
									? 'error'
									: 'warning'}
						>
							{data.boxStatus.lastSyncStatus}
						</TronBadge>
						{#if data.boxStatus.lastSyncStatus === 'error'}
							<svg
								class="h-3 w-3 text-[var(--color-tron-text)] transition-transform {syncErrorOpen
									? 'rotate-180'
									: ''}"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M19 9l-7 7-7-7"
								/>
							</svg>
						{/if}
					</div>
				{/if}
			</button>
			{#if syncErrorOpen && data.syncErrorDetail}
				<div class="mt-3 border-t border-[var(--color-tron-border)] pt-3 text-left text-sm">
					<div
						class="mb-2 rounded border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-2"
					>
						<p class="font-medium text-[var(--color-tron-red)]">{data.syncErrorDetail.message}</p>
					</div>
					{#if data.syncErrorDetail.failedRows?.length}
						<div class="mb-2">
							<span class="tron-text-muted text-xs uppercase">Affected Rows</span>
							<ul class="mt-1 list-inside list-disc text-xs text-[var(--color-tron-text)]">
								{#each data.syncErrorDetail.failedRows as row (row)}
									<li>{row}</li>
								{/each}
							</ul>
						</div>
					{/if}
					{#if data.syncErrorDetail.columnIssues?.length}
						<div class="mb-2">
							<span class="tron-text-muted text-xs uppercase">Column Issues</span>
							<ul class="mt-1 list-inside list-disc text-xs text-[var(--color-tron-text)]">
								{#each data.syncErrorDetail.columnIssues as issue (issue)}
									<li>{issue}</li>
								{/each}
							</ul>
						</div>
					{/if}
					<p class="tron-text-muted mb-2 text-xs">
						Try verifying the Box file format and column headers, then retry the sync.
					</p>
					<form
						method="POST"
						action="?/sync"
						use:enhance={() => {
							syncing = true;
							return async ({ update }) => {
								syncing = false;
								syncErrorOpen = false;
								await update();
							};
						}}
					>
						<TronButton type="submit" variant="default" disabled={syncing}>
							{syncing ? 'Syncing...' : 'Retry Sync'}
						</TronButton>
					</form>
				</div>
			{/if}
		</TronCard>
	</div>

	<!-- Low Inventory Panel (collapsible) -->
	{#if data.lowestInventory && data.lowestInventory.length > 0}
	<TronCard>
		<button
			type="button"
			class="flex w-full items-center justify-between"
			onclick={() => (lowInventoryOpen = !lowInventoryOpen)}
		>
			<h3 class="tron-text-primary text-lg font-medium">⚠️ Low Inventory</h3>
			<svg
				class="h-4 w-4 text-[var(--color-tron-cyan)] transition-transform {lowInventoryOpen ? 'rotate-180' : ''}"
				fill="none" viewBox="0 0 24 24" stroke="currentColor"
			>
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
			</svg>
		</button>

		{#if lowInventoryOpen}
			<!-- Sub-tabs -->
			<div class="mt-3 flex gap-1 border-b border-[var(--color-tron-border)]">
				<button
					class="px-3 py-1.5 text-xs font-medium transition-colors {lowInvTab === 'zero' ? 'border-b-2 border-[var(--color-tron-red)] text-[var(--color-tron-red)]' : 'tron-text-muted hover:text-[var(--color-tron-text)]'}"
					onclick={() => (lowInvTab = 'zero')}
				>
					Zero & Negative ({zeroItems.length})
				</button>
				<button
					class="px-3 py-1.5 text-xs font-medium transition-colors {lowInvTab === 'low' ? 'border-b-2 border-[var(--color-tron-orange)] text-[var(--color-tron-orange)]' : 'tron-text-muted hover:text-[var(--color-tron-text)]'}"
					onclick={() => (lowInvTab = 'low')}
				>
					Low Stock ({lowItems.length})
				</button>
			</div>

			<div class="mt-3 overflow-x-auto">
				{@const displayItems = lowInvTab === 'zero' ? zeroItems : lowItems}
				{#if displayItems.length > 0}
					<table class="tron-table w-full text-sm">
						<thead>
							<tr>
								<th class="text-left">Part #</th>
								<th class="text-left">Name</th>
								<th class="text-right">Inventory</th>
								<th class="text-right">Lead Time (days)</th>
							</tr>
						</thead>
						<tbody>
							{#each displayItems as item (item.id)}
								<tr>
									<td>
										<a href="/spu/parts/{item.id}" class="font-mono text-[var(--color-tron-cyan)] hover:underline">
											{item.partNumber ?? '—'}
										</a>
									</td>
									<td class="tron-text-muted">{item.name}</td>
									<td class="text-right font-mono">
										<span class={item.inventoryCount <= 0 ? 'text-[var(--color-tron-red)]' : 'text-[var(--color-tron-orange)]'}>
											{item.inventoryCount}
										</span>
									</td>
									<td class="text-right font-mono tron-text-muted">
										{item.leadTimeDays ?? '—'}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{:else}
					<p class="tron-text-muted py-4 text-center text-sm">
						{lowInvTab === 'zero' ? 'No items at zero or negative inventory.' : 'No low stock items.'}
					</p>
				{/if}
			</div>
		{/if}
	</TronCard>
	{/if}

	<!-- Filters -->
	<TronCard>
		<div class="flex flex-wrap items-center gap-4">
			<div class="flex-1">
				<input
					type="search"
					placeholder="Search by part number, name, or supplier..."
					bind:value={searchQuery}
					class="tron-input w-full"
				/>
			</div>
			<div>
				<select
					bind:value={selectedCategory}
					class="tron-input rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] px-3 py-2 text-[var(--color-tron-text-primary)]"
				>
					<option value="all">All Classifications</option>
					{#each data.categories as category (category)}
						<option value={category}>{category}</option>
					{/each}
				</select>
			</div>
			<button
				class="inline-flex items-center gap-1.5 rounded border px-3 py-2 text-sm {activeFilterCount >
				0
					? 'border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
					: 'border-[var(--color-tron-border)] text-[var(--color-tron-text-primary)]'} bg-[var(--color-tron-bg-secondary)] hover:border-[var(--color-tron-cyan)]"
				onclick={() => (filtersOpen = !filtersOpen)}
			>
				<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"
					/>
				</svg>
				Filters
				{#if activeFilterCount > 0}
					<span
						class="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--color-tron-cyan)] px-1 font-mono text-xs text-black"
					>
						{activeFilterCount}
					</span>
				{/if}
			</button>
			{#if activeFilterCount > 0}
				<button
					class="text-sm text-[var(--color-tron-red)] hover:underline"
					onclick={clearAllFilters}
				>
					Clear All
				</button>
			{/if}
			<!-- eslint-disable svelte/no-navigation-without-resolve -->
			<a
				href="/spu/bom/settings"
				class="tron-text-muted text-sm hover:text-[var(--color-tron-cyan)]"
			>
				Box Settings
			</a>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		</div>

		{#if filtersOpen}
			<div class="mt-4 border-t border-[var(--color-tron-border)] pt-4">
				<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
					<!-- Inventory Range -->
					<div>
						<label
							for="filter-inv-min"
							class="tron-text-muted mb-1 block text-xs font-medium tracking-wider uppercase"
							>Inventory</label
						>
						<div class="flex items-center gap-2">
							<input
								id="filter-inv-min"
								type="number"
								placeholder="Min"
								bind:value={invMin}
								class="tron-input w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] px-2 py-1.5 font-mono text-sm text-[var(--color-tron-text-primary)]"
							/>
							<span class="tron-text-muted">—</span>
							<input
								type="number"
								placeholder="Max"
								bind:value={invMax}
								aria-label="Inventory max"
								class="tron-input w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] px-2 py-1.5 font-mono text-sm text-[var(--color-tron-text-primary)]"
							/>
						</div>
					</div>

					<!-- Unit Cost Range -->
					<div>
						<label
							for="filter-cost-min"
							class="tron-text-muted mb-1 block text-xs font-medium tracking-wider uppercase"
							>Unit Cost ($)</label
						>
						<div class="flex items-center gap-2">
							<input
								id="filter-cost-min"
								type="number"
								step="0.01"
								placeholder="Min"
								bind:value={costMin}
								class="tron-input w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] px-2 py-1.5 font-mono text-sm text-[var(--color-tron-text-primary)]"
							/>
							<span class="tron-text-muted">—</span>
							<input
								type="number"
								step="0.01"
								placeholder="Max"
								bind:value={costMax}
								aria-label="Unit cost max"
								class="tron-input w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] px-2 py-1.5 font-mono text-sm text-[var(--color-tron-text-primary)]"
							/>
						</div>
					</div>

					<!-- Total Value Range -->
					<div>
						<label
							for="filter-val-min"
							class="tron-text-muted mb-1 block text-xs font-medium tracking-wider uppercase"
							>Total Value ($)</label
						>
						<div class="flex items-center gap-2">
							<input
								id="filter-val-min"
								type="number"
								step="0.01"
								placeholder="Min"
								bind:value={valMin}
								class="tron-input w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] px-2 py-1.5 font-mono text-sm text-[var(--color-tron-text-primary)]"
							/>
							<span class="tron-text-muted">—</span>
							<input
								type="number"
								step="0.01"
								placeholder="Max"
								bind:value={valMax}
								aria-label="Total value max"
								class="tron-input w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] px-2 py-1.5 font-mono text-sm text-[var(--color-tron-text-primary)]"
							/>
						</div>
					</div>

					<!-- Lead Time Range -->
					<div>
						<label
							for="filter-lt-min"
							class="tron-text-muted mb-1 block text-xs font-medium tracking-wider uppercase"
							>Lead Time (days)</label
						>
						<div class="flex items-center gap-2">
							<input
								id="filter-lt-min"
								type="number"
								placeholder="Min"
								bind:value={ltMin}
								class="tron-input w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] px-2 py-1.5 font-mono text-sm text-[var(--color-tron-text-primary)]"
							/>
							<span class="tron-text-muted">—</span>
							<input
								type="number"
								placeholder="Max"
								bind:value={ltMax}
								aria-label="Lead time max"
								class="tron-input w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] px-2 py-1.5 font-mono text-sm text-[var(--color-tron-text-primary)]"
							/>
						</div>
					</div>

					<!-- Classification Multi-Select -->
					<fieldset>
						<legend class="tron-text-muted mb-1 block text-xs font-medium tracking-wider uppercase"
							>Classification</legend
						>
						<div
							class="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-2"
						>
							{#each classifications as cls (cls)}
								<button
									class="rounded px-2 py-0.5 text-xs transition-colors {selectedClassifications.has(
										cls
									)
										? 'bg-[var(--color-tron-cyan)] text-black'
										: 'bg-[var(--color-tron-bg-primary)] text-[var(--color-tron-text-primary)] hover:bg-[color-mix(in_srgb,var(--color-tron-cyan)_20%,transparent)]'}"
									onclick={() => toggleClassification(cls)}
								>
									{cls}
								</button>
							{:else}
								<span class="tron-text-muted text-xs">No classifications</span>
							{/each}
						</div>
					</fieldset>

					<!-- Manufacturer Search -->
					<div>
						<label
							for="filter-mfr"
							class="tron-text-muted mb-1 block text-xs font-medium tracking-wider uppercase"
							>Manufacturer</label
						>
						<input
							id="filter-mfr"
							type="text"
							placeholder="Search manufacturers..."
							bind:value={manufacturerSearch}
							list="manufacturer-options"
							class="tron-input w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] px-2 py-1.5 text-sm text-[var(--color-tron-text-primary)]"
						/>
						<datalist id="manufacturer-options">
							{#each manufacturers as mfr (mfr)}
								<option value={mfr}></option>
							{/each}
						</datalist>
					</div>
				</div>
			</div>
		{/if}
	</TronCard>

	<!-- Result Count -->
	{#if activeFilterCount > 0 || searchQuery || selectedCategory !== 'all'}
		<p class="tron-text-muted text-sm">
			Showing {filteredItems.length} of {data.items.length} parts
		</p>
	{/if}

	<!-- Parts Table -->
	<TronCard>
		<div class="overflow-x-auto">
			<table class="tron-table">
				<thead>
					<tr>
						{#each [{ key: 'partNumber', label: 'Part #' }, { key: 'name', label: 'Name' }, { key: 'category', label: 'Classification' }, { key: null, label: 'Manufacturer' }, { key: 'quantityPerUnit', label: 'Qty/Unit' }, { key: 'inventoryCount', label: 'Inventory' }, { key: 'unitCost', label: 'Unit Cost' }, { key: 'totalValue', label: 'Total Value' }, { key: 'leadTimeDays', label: 'Lead Time' }, { key: null, label: 'Actions' }] as col (col.label)}
							{#if col.key}
								<th
									class="cursor-pointer select-none hover:text-[var(--color-tron-cyan)]"
									onclick={() => toggleSort(col.key as SortColumn)}
								>
									<span class="inline-flex items-center gap-1">
										{col.label}
										{#if sortColumn === col.key && sortDirection}
											<svg
												class="h-3 w-3 text-[var(--color-tron-cyan)]"
												fill="currentColor"
												viewBox="0 0 20 20"
											>
												{#if sortDirection === 'asc'}
													<path
														d="M5.293 9.707a1 1 0 010-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 01-1.414 1.414L10 6.414l-3.293 3.293a1 1 0 01-1.414 0z"
													/>
												{:else}
													<path
														d="M14.707 10.293a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 111.414-1.414L10 13.586l3.293-3.293a1 1 0 011.414 0z"
													/>
												{/if}
											</svg>
										{/if}
									</span>
								</th>
							{:else}
								<th>{col.label}</th>
							{/if}
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each filteredItems as item (item.id)}
						{@const isLow = (item.inventoryCount ?? 0) <= item.minimumStockLevel}
						<tr>
							<td class="font-mono text-[var(--color-tron-cyan)]">{item.partNumber}</td>
							<td>{item.name}</td>
							<td>
								{#if item.category}
									<TronBadge variant="neutral">{item.category}</TronBadge>
								{:else}
									<span class="tron-text-muted">—</span>
								{/if}
							</td>
							<td>{item.supplier || '—'}</td>
							<td class="font-mono">{item.quantityPerUnit}</td>
							<td class="font-mono">
								{#if isLow}
									<span class="text-[var(--color-tron-orange)]">{item.inventoryCount ?? 0}</span>
								{:else}
									{item.inventoryCount ?? 0}
								{/if}
							</td>
							<td class="font-mono">{formatCurrency(item.unitCost)}</td>
							<td class="font-mono">{formatCurrency(item.totalValue)}</td>
							<td class="font-mono">{item.leadTimeDays ? `${item.leadTimeDays}d` : '—'}</td>
							<td>
								<!-- eslint-disable svelte/no-navigation-without-resolve -->
								<a
									href="/spu/parts/{item.id}"
									class="text-sm text-[var(--color-tron-cyan)] hover:underline"
								>
									View Details
								</a>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
							</td>
						</tr>
					{:else}
						<tr>
							<td colspan="10" class="tron-text-muted py-8 text-center">
								{#if searchQuery || selectedCategory !== 'all' || activeFilterCount > 0}
									No parts match your filters.
								{:else if !data.boxStatus.isConnected}
									Connect to Box.com to sync parts data.
								{:else}
									No parts yet. Click "Sync from Box" to import data.
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</TronCard>
	{:else}
	<!-- Cartridge Parts Tab -->
	<div class="flex items-center justify-between">
		<div>
			<h2 class="tron-text-primary font-mono text-2xl font-bold">Cartridge Parts</h2>
			<p class="tron-text-muted">Cartridge manufacturing BOM — manually managed</p>
		</div>
		<button
			class="tron-button"
			onclick={() => (cartAddOpen = !cartAddOpen)}
		>
			{cartAddOpen ? 'Cancel' : '+ Add Part'}
		</button>
	</div>

	{#if form?.error}
		<div class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-3">
			<p class="text-sm text-[var(--color-tron-red)]">{form.error}</p>
		</div>
	{/if}

	{#if cartAddOpen}
		<TronCard>
			<h3 class="tron-text-primary mb-4 text-lg font-semibold">Add Cartridge Part</h3>
			<form method="POST" action="?/createCartridgePart" use:enhance={() => {
				return async ({ update }) => {
					await update();
					cartAddOpen = false;
				};
			}}>
				<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
					<div>
						<label for="cp-pn" class="tron-text-muted mb-1 block text-xs uppercase">Part Number *</label>
						<input id="cp-pn" name="partNumber" required class="tron-input w-full" />
					</div>
					<div>
						<label for="cp-name" class="tron-text-muted mb-1 block text-xs uppercase">Name *</label>
						<input id="cp-name" name="name" required class="tron-input w-full" />
					</div>
					<div>
						<label for="cp-cat" class="tron-text-muted mb-1 block text-xs uppercase">Category</label>
						<input id="cp-cat" name="category" class="tron-input w-full" />
					</div>
					<div>
						<label for="cp-mfr" class="tron-text-muted mb-1 block text-xs uppercase">Manufacturer</label>
						<input id="cp-mfr" name="manufacturer" class="tron-input w-full" />
					</div>
					<div>
						<label for="cp-cost" class="tron-text-muted mb-1 block text-xs uppercase">Unit Cost ($)</label>
						<input id="cp-cost" name="unitCost" type="text" class="tron-input w-full" />
					</div>
					<div>
						<label for="cp-qty" class="tron-text-muted mb-1 block text-xs uppercase">Qty / Unit</label>
						<input id="cp-qty" name="quantityPerUnit" type="number" value="1" class="tron-input w-full" />
					</div>
					<div>
						<label for="cp-uom" class="tron-text-muted mb-1 block text-xs uppercase">Unit of Measure</label>
						<input id="cp-uom" name="unitOfMeasure" class="tron-input w-full" />
					</div>
					<div>
						<label for="cp-inv" class="tron-text-muted mb-1 block text-xs uppercase">Inventory Count</label>
						<input id="cp-inv" name="inventoryCount" type="number" class="tron-input w-full" />
					</div>
					<div>
						<label for="cp-min" class="tron-text-muted mb-1 block text-xs uppercase">Min Stock Level</label>
						<input id="cp-min" name="minimumStockLevel" type="number" value="0" class="tron-input w-full" />
					</div>
				</div>
				<div class="mt-4">
					<label for="cp-desc" class="tron-text-muted mb-1 block text-xs uppercase">Description</label>
					<input id="cp-desc" name="description" class="tron-input w-full" />
				</div>
				<div class="mt-4">
					<TronButton type="submit">Create Part</TronButton>
				</div>
			</form>
		</TronCard>
	{/if}

	<!-- Cartridge Stats -->
	{#if data.cartridgeBomSummary}
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
			<TronCard>
				<div class="text-center">
					<div class="tron-text-primary font-mono text-3xl font-bold">{data.cartridgeBomSummary.totalParts}</div>
					<div class="tron-text-muted text-sm">Total Parts</div>
				</div>
			</TronCard>
			<TronCard>
				<div class="text-center">
					<div class="font-mono text-3xl font-bold text-[var(--color-tron-cyan)]">
						{formatCurrency(data.cartridgeBomSummary.totalValue)}
					</div>
					<div class="tron-text-muted text-sm">Total Value</div>
				</div>
			</TronCard>
			<TronCard>
				<div class="text-center">
					<div class="tron-text-primary font-mono text-3xl font-bold">{data.cartridgeBomSummary.categories.length}</div>
					<div class="tron-text-muted text-sm">Categories</div>
				</div>
			</TronCard>
			<TronCard>
				<div class="text-center">
					<div class="font-mono text-3xl font-bold {data.cartridgeBomSummary.lowStockCount > 0 ? 'text-[var(--color-tron-orange)]' : 'text-[var(--color-tron-green)]'}">
						{data.cartridgeBomSummary.lowStockCount}
					</div>
					<div class="tron-text-muted text-sm">Low Stock</div>
				</div>
			</TronCard>
		</div>
	{/if}

	<!-- Cartridge Search -->
	<TronCard>
		<input
			type="search"
			placeholder="Search cartridge parts..."
			bind:value={cartSearchQuery}
			class="tron-input w-full"
		/>
	</TronCard>

	<!-- Cartridge Parts Table -->
	<TronCard>
		<div class="overflow-x-auto">
			<table class="tron-table">
				<thead>
					<tr>
						{#each [{ key: 'partNumber', label: 'Part #' }, { key: 'name', label: 'Name' }, { key: 'category', label: 'Category' }, { key: null, label: 'Manufacturer' }, { key: 'quantityPerUnit', label: 'Qty/Unit' }, { key: 'inventoryCount', label: 'Inventory' }, { key: 'unitCost', label: 'Unit Cost' }, { key: 'totalValue', label: 'Total Value' }, { key: null, label: 'Actions' }] as col (col.label)}
							{#if col.key}
								<th
									class="cursor-pointer select-none hover:text-[var(--color-tron-cyan)]"
									onclick={() => toggleCartSort(col.key as CartSortColumn)}
								>
									<span class="inline-flex items-center gap-1">
										{col.label}
										{#if cartSortColumn === col.key && cartSortDirection}
											<svg class="h-3 w-3 text-[var(--color-tron-cyan)]" fill="currentColor" viewBox="0 0 20 20">
												{#if cartSortDirection === 'asc'}
													<path d="M5.293 9.707a1 1 0 010-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 01-1.414 1.414L10 6.414l-3.293 3.293a1 1 0 01-1.414 0z" />
												{:else}
													<path d="M14.707 10.293a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 111.414-1.414L10 13.586l3.293-3.293a1 1 0 011.414 0z" />
												{/if}
											</svg>
										{/if}
									</span>
								</th>
							{:else}
								<th>{col.label}</th>
							{/if}
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each filteredCartridgeParts as item (item.id)}
						<tr>
							<td class="font-mono text-[var(--color-tron-cyan)]">{item.partNumber}</td>
							<td>{item.name}</td>
							<td>
								{#if item.category}
									<TronBadge variant="neutral">{item.category}</TronBadge>
								{:else}
									<span class="tron-text-muted">—</span>
								{/if}
							</td>
							<td>{item.manufacturer || '—'}</td>
							<td class="font-mono">{item.quantityPerUnit}</td>
							<td class="font-mono">
								{#if (item.inventoryCount ?? 0) <= item.minimumStockLevel}
									<span class="text-[var(--color-tron-orange)]">{item.inventoryCount ?? 0}</span>
								{:else}
									{item.inventoryCount ?? 0}
								{/if}
							</td>
							<td class="font-mono">{formatCurrency(item.unitCost)}</td>
							<td class="font-mono">{formatCurrency(item.totalValue)}</td>
							<td>
								<div class="flex gap-2">
									<form method="POST" action="?/deleteCartridgePart" use:enhance>
										<input type="hidden" name="id" value={item.id} />
										<button type="submit" class="text-xs text-[var(--color-tron-red)] hover:underline">Delete</button>
									</form>
								</div>
							</td>
						</tr>
					{:else}
						<tr>
							<td colspan="9" class="tron-text-muted py-8 text-center">
								{#if cartSearchQuery}
									No cartridge parts match your search.
								{:else}
									No cartridge parts yet. Click "Add Part" to get started.
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</TronCard>
	{/if}
</div>
