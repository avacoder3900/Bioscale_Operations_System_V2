<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import PartsNav from '$lib/components/PartsNav.svelte';
	import type { LifecycleStage } from '$lib/server/services/cartridge-admin/queries';

	let { data } = $props();

	let searchInput = $state(data.filters.search ?? '');
	let expandedId = $state<string | null>(null);

	const STAGES: LifecycleStage[] = ['backing', 'wax_filled', 'wax_qc', 'wax_stored', 'reagent_filled', 'inspected', 'sealed', 'cured', 'stored', 'released', 'shipped', 'assay_loaded', 'testing', 'completed', 'voided'];

	function stageLabel(stage: string): string {
		return stage.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
	}

	const stageColors: Record<string, string> = {
		backing: 'bg-gray-900/50 text-gray-300 border-gray-500/30',
		wax_filled: 'bg-blue-900/50 text-blue-300 border-blue-500/30',
		wax_qc: 'bg-cyan-900/50 text-cyan-300 border-cyan-500/30',
		wax_stored: 'bg-violet-900/50 text-violet-300 border-violet-500/30',
		reagent_filled: 'bg-green-900/50 text-green-300 border-green-500/30',
		inspected: 'bg-yellow-900/50 text-yellow-300 border-yellow-500/30',
		sealed: 'bg-purple-900/50 text-purple-300 border-purple-500/30',
		cured: 'bg-teal-900/50 text-teal-300 border-teal-500/30',
		stored: 'bg-emerald-900/50 text-emerald-300 border-emerald-500/30',
		released: 'bg-lime-900/50 text-lime-300 border-lime-500/30',
		shipped: 'bg-sky-900/50 text-sky-300 border-sky-500/30',
		assay_loaded: 'bg-amber-900/50 text-amber-300 border-amber-500/30',
		testing: 'bg-orange-900/50 text-orange-300 border-orange-500/30',
		completed: 'bg-green-900/50 text-green-300 border-green-500/30',
		voided: 'bg-red-950/50 text-red-400 border-red-700/30'
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
	<PartsNav />
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
			{#each STAGES as stage (stage)}
				<option value={stage} selected={data.filters.lifecycleStage === stage}>{stageLabel(stage)}</option>
			{/each}
		</select>

		<select onchange={(e) => updateFilters({ operator: e.currentTarget.value || undefined })}
			class="min-h-[44px] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
		>
			<option value="">All Operators</option>
			{#each data.operators as op (op.id)}
				<option value={op.id} selected={data.filters.operatorId === op.id}>{op.name}</option>
			{/each}
		</select>
	</div>

	<p class="text-xs text-[var(--color-tron-text-secondary)]">
		Showing {data.cartridges.length} of {data.total} cartridges
	</p>

	<!-- Table -->
	<div class="overflow-x-auto rounded border border-[var(--color-tron-border)]">
		<table class="w-full text-sm">
			<thead>
				<tr class="border-b border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
					{#each [
						{ key: 'date_created', label: 'Cartridge ID' },
						{ key: '', label: 'Backed Lot' },
						{ key: 'assay_type', label: 'Assay Type' },
						{ key: '', label: 'Wax Run' },
						{ key: '', label: 'Reagent Run' },
						{ key: 'current_status', label: 'Stage' },
						{ key: 'operator', label: 'Operator' },
						{ key: 'date_created', label: 'Created' },
						{ key: '', label: 'Expiration' },
						{ key: '', label: 'Storage' }
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
						<td class="px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">{c.backedLotId}</td>
						<td class="px-3 py-2 text-xs text-[var(--color-tron-text)]">{c.assayTypeName ?? '—'}</td>
						<td class="px-3 py-2 font-mono text-xs text-[var(--color-tron-text-secondary)]">{c.waxRunId ?? '—'}</td>
						<td class="px-3 py-2 font-mono text-xs text-[var(--color-tron-text-secondary)]">{c.reagentRunId ?? '—'}</td>
						<td class="px-3 py-2">
							<span class="rounded border px-1.5 py-0.5 text-xs font-medium {stageColors[c.currentLifecycleStage] ?? ''}">
								{c.currentLifecycleStage}
							</span>
						</td>
						<td class="px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">{c.operatorName ?? '—'}</td>
						<td class="px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">{new Date(c.createdAt).toLocaleDateString()}</td>
						<td class="px-3 py-2 text-xs">
							{#if c.expirationDate}
								{@const expDate = new Date(c.expirationDate)}
								{@const daysRemaining = Math.ceil((expDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))}
								<span class="{daysRemaining <= 0 ? 'font-bold text-[var(--color-tron-error)]' : daysRemaining <= 7 ? 'text-[var(--color-tron-error)]' : daysRemaining <= 14 ? 'text-[var(--color-tron-yellow)]' : 'text-[var(--color-tron-text-secondary)]'}">
									{expDate.toLocaleDateString()}
									{#if daysRemaining <= 14}
										<span class="ml-1 text-[10px]">({daysRemaining}d)</span>
									{/if}
								</span>
							{:else}
								<span class="text-[var(--color-tron-text-secondary)]">—</span>
							{/if}
						</td>
						<td class="px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">{c.storageLocation ?? '—'}</td>
					</tr>
					{#if expandedId === c.cartridgeId}
						<tr>
							<td colspan="10" class="bg-[var(--color-tron-surface)]/50 px-4 py-3">
								<div class="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
									<div>
										<span class="text-[var(--color-tron-text-secondary)]">Wax Status:</span>
										<span class="ml-1 text-[var(--color-tron-text)]">{c.waxStatus}</span>
									</div>
									<div>
										<span class="text-[var(--color-tron-text-secondary)]">Wax QC:</span>
										<span class="ml-1 text-[var(--color-tron-text)]">{c.waxQcStatus}</span>
									</div>
									<div>
										<span class="text-[var(--color-tron-text-secondary)]">Inspection:</span>
										<span class="ml-1 text-[var(--color-tron-text)]">{c.inspectionStatus ?? 'N/A'}</span>
									</div>
									<div>
										<span class="text-[var(--color-tron-text-secondary)]">Top Seal Batch:</span>
										<span class="ml-1 font-mono text-[var(--color-tron-text)]">{c.topSealBatchId ?? 'N/A'}</span>
									</div>
									<div>
										<span class="text-[var(--color-tron-text-secondary)]">Cooling Tray:</span>
										<span class="ml-1 text-[var(--color-tron-text)]">{c.coolingTrayId ?? 'N/A'}</span>
									</div>
									<div>
										<span class="text-[var(--color-tron-text-secondary)]">Oven Entry:</span>
										<span class="ml-1 text-[var(--color-tron-text)]">{c.ovenEntryTime ? new Date(c.ovenEntryTime).toLocaleString() : 'N/A'}</span>
									</div>
									<div class="col-span-2">
										<span class="text-[var(--color-tron-text-secondary)]">Future:</span>
										<span class="ml-1 italic text-[var(--color-tron-text-secondary)]">Customer Assignment, Shipping, Results — Coming Soon</span>
									</div>
								</div>
							</td>
						</tr>
					{/if}
				{/each}
				{#if data.cartridges.length === 0}
					<tr>
						<td colspan="10" class="px-4 py-8 text-center text-sm text-[var(--color-tron-text-secondary)]">
							No cartridges found
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
