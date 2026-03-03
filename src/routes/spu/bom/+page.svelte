<script lang="ts">
	import { enhance } from '$app/forms';
	import { TronCard, TronButton, TronBadge } from '$lib/components/ui';

	let { data, form } = $props();

	let searchQuery = $state('');
	let selectedCategory = $state('all');
	let syncing = $state(false);

	let filteredItems = $derived(() => {
		let items = data.items;

		if (selectedCategory !== 'all') {
			items = items.filter((i) => i.category === selectedCategory);
		}

		if (searchQuery) {
			const query = searchQuery.toLowerCase();
			items = items.filter(
				(i) => i.partNumber.toLowerCase().includes(query) || i.name.toLowerCase().includes(query)
			);
		}

		return items;
	});

	function formatCurrency(value: number | string | null): string {
		if (value === null || value === undefined) return '—';
		const num = typeof value === 'string' ? parseFloat(value) : value;
		if (isNaN(num)) return '—';
		return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(num);
	}

	function formatDate(date: Date | string | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleDateString();
	}
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<h2 class="tron-text-primary font-mono text-2xl font-bold">BOM</h2>
			<p class="tron-text-muted">Bill of Materials — Inventory counts, quantities, and value</p>
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
				<a href="/spu/bom/settings">
					<TronButton variant="default">Connect to Box</TronButton>
				</a>
			{/if}
		</div>
	</div>


	<!-- Stats Cards -->
	<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
		<TronCard>
			<div class="text-center">
				<div class="tron-text-primary font-mono text-3xl font-bold">{data.stats.totalItems}</div>
				<div class="tron-text-muted text-sm">Total Items</div>
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
			<div class="text-center">
				<div class="font-mono text-3xl font-bold text-[var(--color-tron-red)]">
					{data.stats.lowStock}
				</div>
				<div class="tron-text-muted text-sm">Low Stock Items</div>
			</div>
		</TronCard>
		<TronCard>
			<div class="text-center">
				<div class="tron-text-muted text-sm">Last Sync</div>
				<div class="tron-text-primary font-mono text-lg">
					{data.boxStatus.lastSyncAt ? formatDate(data.boxStatus.lastSyncAt) : 'Never'}
				</div>
				{#if data.boxStatus.lastSyncStatus}
					<TronBadge
						variant={data.boxStatus.lastSyncStatus === 'success'
							? 'success'
							: data.boxStatus.lastSyncStatus === 'error'
								? 'error'
								: 'warning'}
					>
						{data.boxStatus.lastSyncStatus}
					</TronBadge>
				{/if}
			</div>
		</TronCard>
	</div>

	<!-- Filters -->
	<TronCard>
		<div class="flex flex-wrap items-center gap-4">
			<div class="flex-1">
				<input
					type="search"
					placeholder="Search by part number or name..."
					bind:value={searchQuery}
					class="tron-input w-full"
				/>
			</div>
			<div>
				<select
					bind:value={selectedCategory}
					class="tron-input rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] px-3 py-2 text-[var(--color-tron-text-primary)]"
				>
					<option value="all">All Categories</option>
					{#each data.categories as category}
						<option value={category}>{category}</option>
					{/each}
				</select>
			</div>
			<a
				href="/spu/bom/settings"
				class="tron-text-muted text-sm hover:text-[var(--color-tron-cyan)]"
			>
				Settings
			</a>
		</div>
	</TronCard>

	<!-- Inventory Table -->
	<TronCard>
		<div class="overflow-x-auto">
			<table class="tron-table">
				<thead>
					<tr>
						<th>Part #</th>
						<th>Name</th>
						<th>Classification</th>
						<th>Qty/Unit</th>
						<th>Inventory Count</th>
						<th>Unit Cost</th>
						<th>Total Value</th>
						<th>Actions</th>
					</tr>
				</thead>
				<tbody>
					{#each filteredItems() as item (item.id)}
						{@const isLow = (item.inventoryCount ?? 0) < item.quantityPerUnit}
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
							<td class="font-mono">{item.quantityPerUnit}</td>
							<td class="font-mono">
								{#if isLow}
									<span class="text-[var(--color-tron-red)]">{item.inventoryCount ?? 0}</span>
								{:else}
									{item.inventoryCount ?? 0}
								{/if}
							</td>
							<td class="font-mono">{formatCurrency(item.unitCost)}</td>
							<td class="font-mono">{formatCurrency(item.totalValue)}</td>
							<td>
								{#if item.partDefinitionId}
									<a
										href="/spu/parts/{item.partDefinitionId}"
										class="text-sm text-[var(--color-tron-cyan)] hover:underline"
									>
										View Part
									</a>
								{:else}
									<a
										href="/spu/bom/{item.id}"
										class="text-sm text-[var(--color-tron-cyan)] hover:underline"
									>
										Details
									</a>
								{/if}
							</td>
						</tr>
					{:else}
						<tr>
							<td colspan="8" class="tron-text-muted py-8 text-center">
								{#if searchQuery || selectedCategory !== 'all'}
									No items match your filters.
								{:else}
									No BOM items yet. Sync from Box.com to populate inventory.
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</TronCard>
</div>
