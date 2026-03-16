<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { SvelteSet } from 'svelte/reactivity';
	import type { LifecycleStage } from '$lib/server/services/cartridge-admin/queries';

	let { data } = $props();

	let searchInput = $state(data.filters.search ?? '');
	let expandedId = $state<string | null>(null);
	let selectedIds = new SvelteSet<string>();
	let showLinkPanel = $state(false);
	let selectedLotId = $state('');
	let feedbackMessage = $state('');
	let feedbackType = $state<'success' | 'error'>('success');
	let showCustomerAssign = $state<string | null>(null);

	const FILLED_STAGES: LifecycleStage[] = ['Inspected', 'Top Sealed', 'Stored'];

	const stageColors: Record<string, string> = {
		Inspected: 'bg-yellow-900/50 text-yellow-300 border-yellow-500/30',
		'Top Sealed': 'bg-purple-900/50 text-purple-300 border-purple-500/30',
		Stored: 'bg-emerald-900/50 text-emerald-300 border-emerald-500/30'
	};

	const lotStatusColors: Record<string, string> = {
		open: 'bg-yellow-900/50 text-yellow-300 border-yellow-500/30',
		released: 'bg-emerald-900/50 text-emerald-300 border-emerald-500/30',
		shipped: 'bg-blue-900/50 text-blue-300 border-blue-500/30',
		delivered: 'bg-purple-900/50 text-purple-300 border-purple-500/30'
	};

	// Cartridges eligible for linking (Stored, no lot)
	const linkableCartridges = $derived(
		data.cartridges.filter((c) => c.currentLifecycleStage === 'Stored' && !c.shippingLotId)
	);

	// Lots filtered by assay type of selected cartridges
	const selectedCartridgeAssayTypes = $derived.by(() => {
		const assayIds = new SvelteSet<string>();
		for (const id of selectedIds) {
			const c = data.cartridges.find((c) => c.cartridgeId === id);
			if (c?.assayTypeId) assayIds.add(c.assayTypeId);
		}
		return assayIds;
	});

	const availableLots = $derived(
		data.lots.filter((l) =>
			l.status === 'released' &&
			(selectedCartridgeAssayTypes.size === 0 || selectedCartridgeAssayTypes.has(l.assayTypeId))
		)
	);

	// Lot summary stats
	const openLots = $derived(data.lots.filter((l) => l.status === 'open'));
	const releasedLots = $derived(data.lots.filter((l) => l.status === 'released'));

	function updateFilters(params: Record<string, string | undefined>) {
		const url = new URL($page.url);
		for (const [key, val] of Object.entries(params)) {
			if (val) url.searchParams.set(key, val);
			else url.searchParams.delete(key);
		}
		url.searchParams.set('page', '1');
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- URL built from current page
		goto(url.toString(), { invalidateAll: true });
	}

	function doSearch() {
		updateFilters({ search: searchInput || undefined });
	}

	function toggleSort(col: string) {
		const newDir = data.filters.sortBy === col && data.filters.sortDir === 'asc' ? 'desc' : 'asc';
		updateFilters({ sortBy: col, sortDir: newDir });
	}

	function toggleSelect(cartridgeId: string) {
		if (selectedIds.has(cartridgeId)) selectedIds.delete(cartridgeId);
		else selectedIds.add(cartridgeId);
	}

	function selectAllLinkable() {
		for (const c of linkableCartridges) selectedIds.add(c.cartridgeId);
	}

	function clearSelection() {
		selectedIds.clear();
		showLinkPanel = false;
		selectedLotId = '';
	}

	function handleFormResult(result: { type: string; data?: Record<string, unknown> }) {
		if (result.type === 'success' && result.data?.success) {
			feedbackType = 'success';
			feedbackMessage = (result.data.message as string) ?? 'Action completed';
			clearSelection();
		} else if (result.type === 'failure' && result.data?.error) {
			feedbackType = 'error';
			feedbackMessage = result.data.error as string;
		}
	}

	const totalPages = $derived(Math.ceil(data.total / data.pageSize));
</script>

<div class="flex gap-4">
	<!-- Main Content -->
	<div class="min-w-0 flex-1 space-y-4">
		<!-- Feedback -->
		{#if feedbackMessage}
			<div class="flex items-center justify-between rounded border px-4 py-2 text-sm {feedbackType === 'success'
				? 'border-emerald-500/50 bg-emerald-900/20 text-emerald-300'
				: 'border-[var(--color-tron-error)]/50 bg-[var(--color-tron-error)]/10 text-[var(--color-tron-error)]'}"
			>
				<span>{feedbackMessage}</span>
				<button type="button" onclick={() => { feedbackMessage = ''; }} class="ml-4 text-xs opacity-60 hover:opacity-100">Dismiss</button>
			</div>
		{/if}

		<!-- Search + Filters -->
		<div class="flex flex-wrap gap-2">
			<div class="flex flex-1 gap-2">
				<input
					bind:value={searchInput}
					onkeydown={(e) => { if (e.key === 'Enter') doSearch(); }}
					placeholder="Search cartridge ID or lot..."
					class="min-h-[44px] min-w-[200px] flex-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
				/>
				<button type="button" onclick={doSearch}
					class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)]"
				>
					Search
				</button>
			</div>

			<select onchange={(e) => updateFilters({ assayType: e.currentTarget.value || undefined })}
				class="min-h-[44px] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
			>
				<option value="">All Assay Types</option>
				{#each data.assayTypes as at (at.id)}
					<option value={at.id} selected={data.filters.assayTypeId === at.id}>{at.name}</option>
				{/each}
			</select>

			<select onchange={(e) => updateFilters({ stage: e.currentTarget.value || undefined })}
				class="min-h-[44px] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
			>
				<option value="">All Stages</option>
				{#each FILLED_STAGES as stage (stage)}
					<option value={stage} selected={data.filters.lifecycleStage === stage}>{stage}</option>
				{/each}
			</select>
		</div>

		<!-- Selection Actions -->
		{#if selectedIds.size > 0}
			<div class="flex items-center gap-3 rounded border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/10 px-4 py-2">
				<span class="text-sm text-[var(--color-tron-cyan)]">
					{selectedIds.size} cartridge{selectedIds.size !== 1 ? 's' : ''} selected
				</span>
				<button
					type="button"
					onclick={() => { showLinkPanel = true; }}
					class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-1.5 text-sm font-medium text-[var(--color-tron-cyan)]"
				>
					Link to Lot
				</button>
				<button
					type="button"
					onclick={clearSelection}
					class="min-h-[44px] rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)]"
				>
					Clear
				</button>
			</div>
		{:else}
			<div class="flex items-center gap-3">
				<p class="text-xs text-[var(--color-tron-text-secondary)]">
					Showing {data.cartridges.length} of {data.total} filled cartridges
				</p>
				{#if linkableCartridges.length > 0}
					<button
						type="button"
						onclick={selectAllLinkable}
						class="text-xs text-[var(--color-tron-cyan)] hover:underline"
					>
						Select all linkable ({linkableCartridges.length})
					</button>
				{/if}
			</div>
		{/if}

		<!-- Link to Lot Panel -->
		{#if showLinkPanel}
			<div class="rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-surface)] p-4">
				<h3 class="mb-3 text-sm font-medium text-[var(--color-tron-cyan)]">Link {selectedIds.size} Cartridges to Lot</h3>
				<form
					method="POST"
					action="?/linkCartridgesToLot"
					use:enhance={() => {
						return async ({ result, update }) => {
							handleFormResult(result as { type: string; data?: Record<string, unknown> });
							await update();
						};
					}}
					class="space-y-3"
				>
					<input type="hidden" name="cartridgeIds" value={[...selectedIds].join(',')} />
					<div>
						<label for="linkLotId" class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]">Shipping Lot</label>
						<select
							id="linkLotId"
							name="lotId"
							required
							bind:value={selectedLotId}
							class="min-h-[44px] w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
						>
							<option value="">Select a released lot...</option>
							{#each availableLots as lot (lot.id)}
								<option value={lot.id}>
									{lot.id} — {data.assayTypes.find((a) => a.id === lot.assayTypeId)?.name ?? 'Unknown'} ({lot.cartridgeCount ?? 0} cartridges)
								</option>
							{/each}
						</select>
						{#if availableLots.length === 0}
							<p class="mt-1 text-xs text-[var(--color-tron-yellow)]">No released lots available for the selected assay type</p>
						{/if}
					</div>
					<div class="flex gap-2">
						<button
							type="submit"
							disabled={!selectedLotId}
							class="min-h-[44px] rounded border border-emerald-500/50 bg-emerald-900/20 px-4 py-2 text-sm font-medium text-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"
						>
							Link Selected to Lot
						</button>
						<button type="button" onclick={() => { showLinkPanel = false; }}
							class="min-h-[44px] rounded border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)]"
						>
							Cancel
						</button>
					</div>
				</form>
			</div>
		{/if}

		<!-- Table -->
		<div class="overflow-x-auto rounded border border-[var(--color-tron-border)]">
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
						<th class="w-10 px-2 py-2">
							<span class="sr-only">Select</span>
						</th>
						{#each [
							{ key: 'date_created', label: 'Cartridge ID' },
							{ key: 'assay_type', label: 'Assay Type' },
							{ key: '', label: 'Reagent Run' },
							{ key: 'current_status', label: 'Stage' },
							{ key: '', label: 'Fridge' },
							{ key: '', label: 'Container' },
							{ key: '', label: 'Lot' },
							{ key: '', label: 'Expiration' },
							{ key: 'operator', label: 'Operator' }
						] as col (col.label)}
							<th class="px-3 py-2 text-left font-medium text-[var(--color-tron-text-secondary)]">
								{#if col.key}
									<button type="button" onclick={() => toggleSort(col.key)} class="hover:text-[var(--color-tron-cyan)]">
										{col.label}
										{#if data.filters.sortBy === col.key}
											<span class="text-[var(--color-tron-cyan)]">{data.filters.sortDir === 'asc' ? '\u2191' : '\u2193'}</span>
										{/if}
									</button>
								{:else}
									{col.label}
								{/if}
							</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each data.cartridges as c (c.cartridgeId)}
						{@const isLinkable = c.currentLifecycleStage === 'Stored' && !c.shippingLotId}
						{@const isSelected = selectedIds.has(c.cartridgeId)}
						<tr
							class="border-b border-[var(--color-tron-border)]/50 {isSelected ? 'bg-[var(--color-tron-cyan)]/5' : 'hover:bg-[var(--color-tron-surface)]/50'}"
						>
							<td class="px-2 py-2 text-center">
								{#if isLinkable}
									<input
										type="checkbox"
										checked={isSelected}
										onchange={() => toggleSelect(c.cartridgeId)}
										class="h-4 w-4 cursor-pointer accent-[var(--color-tron-cyan)]"
									/>
								{/if}
							</td>
							<td
								class="cursor-pointer px-3 py-2 font-mono text-xs text-[var(--color-tron-text)]"
								onclick={() => { expandedId = expandedId === c.cartridgeId ? null : c.cartridgeId; }}
							>
								{c.cartridgeId}
							</td>
							<td class="px-3 py-2 text-xs text-[var(--color-tron-text)]">{c.assayTypeName ?? '—'}</td>
							<td class="px-3 py-2 font-mono text-xs text-[var(--color-tron-text-secondary)]">{c.reagentRunId ?? '—'}</td>
							<td class="px-3 py-2">
								<span class="rounded border px-1.5 py-0.5 text-xs font-medium {stageColors[c.currentLifecycleStage] ?? ''}">
									{c.currentLifecycleStage}
								</span>
							</td>
							<td class="px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">{c.fridgeId ?? '—'}</td>
							<td class="px-3 py-2 font-mono text-xs text-[var(--color-tron-text-secondary)]">{c.storageContainerBarcode ?? '—'}</td>
							<td class="px-3 py-2 font-mono text-xs" style="color: var(--color-tron-cyan)">{c.shippingLotId ?? '—'}</td>
							<td class="px-3 py-2 text-xs">
								{#if c.expirationDate}
									{@const expDate = new Date(c.expirationDate)}
									{@const daysRemaining = Math.ceil((expDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))}
									<span class="{daysRemaining <= 0 ? 'font-bold text-[var(--color-tron-error)]' : daysRemaining <= 7 ? 'text-[var(--color-tron-error)]' : daysRemaining <= 14 ? 'text-[var(--color-tron-yellow)]' : 'text-[var(--color-tron-text-secondary)]'}">
										{expDate.toLocaleDateString()}
									</span>
								{:else}
									<span class="text-[var(--color-tron-text-secondary)]">—</span>
								{/if}
							</td>
							<td class="px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">{c.operatorName ?? '—'}</td>
						</tr>
					{/each}
					{#if data.cartridges.length === 0}
						<tr>
							<td colspan="10" class="px-4 py-8 text-center text-sm text-[var(--color-tron-text-secondary)]">
								No filled cartridges found
							</td>
						</tr>
					{/if}
				</tbody>
			</table>
		</div>

		<!-- Pagination -->
		{#if totalPages > 1}
			<div class="flex items-center justify-between">
				<span class="text-xs text-[var(--color-tron-text-secondary)]">Page {data.pageNum} of {totalPages}</span>
				<div class="flex gap-2">
					{#if data.pageNum > 1}
						<button type="button" onclick={() => updateFilters({ page: String(data.pageNum - 1) })}
							class="min-h-[44px] rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)]"
						>
							Previous
						</button>
					{/if}
					{#if data.pageNum < totalPages}
						<button type="button" onclick={() => updateFilters({ page: String(data.pageNum + 1) })}
							class="min-h-[44px] rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)]"
						>
							Next
						</button>
					{/if}
				</div>
			</div>
		{/if}
	</div>

	<!-- Lot Summary Sidebar -->
	<div class="hidden w-64 shrink-0 space-y-3 lg:block">
		<h3 class="text-sm font-medium text-[var(--color-tron-text)]">Shipping Lots</h3>

		<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
			<div class="flex justify-between text-xs">
				<span class="text-[var(--color-tron-text-secondary)]">Open</span>
				<span class="font-bold text-[var(--color-tron-yellow)]">{openLots.length}</span>
			</div>
			<div class="mt-1 flex justify-between text-xs">
				<span class="text-[var(--color-tron-text-secondary)]">Released</span>
				<span class="font-bold text-emerald-400">{releasedLots.length}</span>
			</div>
			<div class="mt-1 flex justify-between text-xs">
				<span class="text-[var(--color-tron-text-secondary)]">Total</span>
				<span class="font-bold text-[var(--color-tron-text)]">{data.lots.length}</span>
			</div>
		</div>

		{#each data.lots as lot (lot.id)}
			<div class="rounded border border-[var(--color-tron-border)]/50 bg-[var(--color-tron-bg)] p-3">
				<div class="flex items-center justify-between">
					<span class="font-mono text-xs text-[var(--color-tron-text)]">{lot.id}</span>
					<span class="rounded border px-1.5 py-0.5 text-xs font-medium {lotStatusColors[lot.status] ?? ''}">
						{lot.status}
					</span>
				</div>
				<div class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
					{data.assayTypes.find((a) => a.id === lot.assayTypeId)?.name ?? '—'}
				</div>
				<div class="mt-0.5 text-xs text-[var(--color-tron-text-secondary)]">
					{lot.cartridgeCount ?? 0} cartridges
				</div>
				{#if lot.customerId}
					<div class="mt-0.5 text-xs text-[var(--color-tron-text-secondary)]">
						Customer: {data.customers.find((c) => c.id === lot.customerId)?.name ?? lot.customerId}
					</div>
				{:else}
					<button
						type="button"
						onclick={() => { showCustomerAssign = showCustomerAssign === lot.id ? null : lot.id; }}
						class="mt-1 text-xs text-[var(--color-tron-cyan)] hover:underline"
					>
						Assign Customer
					</button>
				{/if}

				{#if showCustomerAssign === lot.id}
					<form
						method="POST"
						action="?/assignLotToCustomer"
						use:enhance={() => {
							return async ({ result, update }) => {
								handleFormResult(result as { type: string; data?: Record<string, unknown> });
								showCustomerAssign = null;
								await update();
							};
						}}
						class="mt-2 space-y-2"
					>
						<input type="hidden" name="lotId" value={lot.id} />
						<select
							name="customerId"
							required
							class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-2 py-1 text-xs text-[var(--color-tron-text)]"
						>
							<option value="">Select customer...</option>
							{#each data.customers as cust (cust.id)}
								<option value={cust.id}>{cust.name}</option>
							{/each}
						</select>
						<button type="submit" class="w-full rounded border border-emerald-500/50 bg-emerald-900/20 px-2 py-1 text-xs text-emerald-300">
							Assign
						</button>
					</form>
				{/if}
			</div>
		{/each}

		{#if data.lots.length === 0}
			<p class="text-xs text-[var(--color-tron-text-secondary)]">No shipping lots yet</p>
		{/if}
	</div>
</div>
