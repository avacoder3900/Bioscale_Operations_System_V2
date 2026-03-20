<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import type { LifecycleStage } from '$lib/server/services/cartridge-admin/queries';

	let { data } = $props();

	let searchInput = $state(data.filters.search ?? '');
	let expandedId = $state<string | null>(null);

	const FAILURE_STAGES: LifecycleStage[] = ['Rejected', 'Scrapped'];

	const stageColors: Record<string, string> = {
		Rejected: 'bg-red-900/50 text-red-300 border-red-500/30',
		Scrapped: 'bg-[var(--color-tron-bg-tertiary)] text-[var(--color-tron-text)] border-[var(--color-tron-border)]'
	};

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

	const totalPages = $derived(Math.ceil(data.total / data.pageSize));
</script>

<div class="space-y-4">
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
	</div>

	<p class="text-xs text-[var(--color-tron-text-secondary)]">
		Showing {data.cartridges.length} of {data.total} failed cartridges
	</p>

	<!-- Table -->
	<div class="overflow-x-auto rounded border border-[var(--color-tron-border)]">
		<table class="w-full text-sm">
			<thead>
				<tr class="border-b border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
					{#each [
						{ key: 'date_created', label: 'Cartridge ID' },
						{ key: 'assay_type', label: 'Assay Type' },
						{ key: '', label: 'Reagent Run' },
						{ key: 'current_status', label: 'Status' },
						{ key: '', label: 'Wax QC' },
						{ key: '', label: 'Lot' },
						{ key: 'operator', label: 'Operator' },
						{ key: 'date_created', label: 'Date' }
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
					<tr
						class="cursor-pointer border-b border-[var(--color-tron-border)]/50 hover:bg-[var(--color-tron-surface)]/50"
						onclick={() => { expandedId = expandedId === c.cartridgeId ? null : c.cartridgeId; }}
					>
						<td class="px-3 py-2 font-mono text-xs text-[var(--color-tron-text)]">{c.cartridgeId}</td>
						<td class="px-3 py-2 text-xs text-[var(--color-tron-text)]">{c.assayTypeName ?? '—'}</td>
						<td class="px-3 py-2 font-mono text-xs text-[var(--color-tron-text-secondary)]">{c.reagentRunId ?? '—'}</td>
						<td class="px-3 py-2">
							<span class="rounded border px-1.5 py-0.5 text-xs font-medium {stageColors[c.currentLifecycleStage] ?? ''}">
								{c.currentLifecycleStage}
							</span>
						</td>
						<td class="px-3 py-2">
							<span class="text-xs {c.waxQcStatus === 'Rejected' ? 'text-[var(--color-tron-error)]' : 'text-[var(--color-tron-text-secondary)]'}">
								{c.waxQcStatus}
							</span>
						</td>
						<td class="px-3 py-2 font-mono text-xs text-[var(--color-tron-text-secondary)]">{c.backedLotId}</td>
						<td class="px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">{c.operatorName ?? '—'}</td>
						<td class="px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">
							{new Date(c.createdAt).toLocaleDateString()}
						</td>
					</tr>
					{#if expandedId === c.cartridgeId}
						<tr class="border-b border-[var(--color-tron-border)]/50">
							<td colspan="8" class="bg-[var(--color-tron-bg-secondary)] px-4 py-3">
								<div class="grid grid-cols-2 gap-4 text-xs md:grid-cols-4">
									<div>
										<span class="text-[var(--color-tron-text-secondary)]">Wax Run:</span>
										<span class="ml-1 font-mono text-[var(--color-tron-text)]">{c.waxRunId ?? '—'}</span>
									</div>
									<div>
										<span class="text-[var(--color-tron-text-secondary)]">Wax Status:</span>
										<span class="ml-1 text-[var(--color-tron-text)]">{c.waxStatus}</span>
									</div>
									<div>
										<span class="text-[var(--color-tron-text-secondary)]">Cooling Tray:</span>
										<span class="ml-1 font-mono text-[var(--color-tron-text)]">{c.coolingTrayId ?? '—'}</span>
									</div>
									<div>
										<span class="text-[var(--color-tron-text-secondary)]">Inspection:</span>
										<span class="ml-1 text-[var(--color-tron-text)]">{c.inspectionStatus ?? '—'}</span>
									</div>
									<div>
										<span class="text-[var(--color-tron-text-secondary)]">Storage Location:</span>
										<span class="ml-1 text-[var(--color-tron-text)]">{c.storageLocation ?? '—'}</span>
									</div>
									<div>
										<span class="text-[var(--color-tron-text-secondary)]">Top Seal Batch:</span>
										<span class="ml-1 font-mono text-[var(--color-tron-text)]">{c.topSealBatchId ?? '—'}</span>
									</div>
								</div>
							</td>
						</tr>
					{/if}
				{/each}
				{#if data.cartridges.length === 0}
					<tr>
						<td colspan="8" class="px-4 py-8 text-center text-sm text-[var(--color-tron-text-secondary)]">
							No failed cartridges found
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
