<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';

	let { data } = $props();

	let resultFilter = $state(data.filters.result);
	let projectFilter = $state(data.filters.projectId);
	let cartridgeFilter = $state(data.filters.cartridge);

	function applyFilters() {
		const params = new URLSearchParams();
		if (resultFilter) params.set('result', resultFilter);
		if (projectFilter) params.set('projectId', projectFilter);
		if (cartridgeFilter) params.set('cartridge', cartridgeFilter);
		params.set('page', '1');
		goto(`/cv/history?${params.toString()}`);
	}

	function clearFilters() {
		resultFilter = '';
		projectFilter = '';
		cartridgeFilter = '';
		goto('/cv/history');
	}

	function goToPage(p: number) {
		const params = new URLSearchParams($page.url.searchParams);
		params.set('page', p.toString());
		goto(`/cv/history?${params.toString()}`);
	}

	function fmtDate(d: string) {
		return new Date(d).toLocaleString();
	}
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h2 class="text-2xl font-bold text-[var(--color-tron-cyan)]">Inspection History</h2>
		<p class="text-sm text-[var(--color-tron-text-secondary)]">{data.pagination.total} inspections</p>
	</div>

	<!-- Filters -->
	<div class="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
		<div>
			<label for="fResult" class="mb-1 block text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Result</label>
			<select id="fResult" bind:value={resultFilter} class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-1.5 text-sm text-[var(--color-tron-text-primary)]">
				<option value="">All</option>
				<option value="pass">Pass</option>
				<option value="fail">Fail</option>
			</select>
		</div>
		<div>
			<label for="fProject" class="mb-1 block text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Project</label>
			<select id="fProject" bind:value={projectFilter} class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-1.5 text-sm text-[var(--color-tron-text-primary)]">
				<option value="">All</option>
				{#each data.projects as p}
					<option value={p._id}>{p.name}</option>
				{/each}
			</select>
		</div>
		<div>
			<label for="fCart" class="mb-1 block text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Cartridge</label>
			<input id="fCart" type="text" bind:value={cartridgeFilter} placeholder="Search..." class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-1.5 text-sm text-[var(--color-tron-text-primary)]" />
		</div>
		<button onclick={applyFilters} class="rounded-lg bg-[var(--color-tron-cyan)] px-4 py-1.5 text-sm font-medium text-black hover:opacity-90">Filter</button>
		<button onclick={clearFilters} class="rounded-lg border border-[var(--color-tron-border)] px-4 py-1.5 text-sm text-[var(--color-tron-text-secondary)]">Clear</button>
	</div>

	<!-- Table -->
	<div class="overflow-hidden rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
		{#if data.inspections.length === 0}
			<div class="p-8 text-center text-[var(--color-tron-text-secondary)]">No inspections match the current filters.</div>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full">
					<thead>
						<tr class="border-b border-[var(--color-tron-border)] text-left text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">
							<th class="px-4 py-3">Result</th>
							<th class="px-4 py-3">Confidence</th>
							<th class="px-4 py-3">Project</th>
							<th class="px-4 py-3">Type</th>
							<th class="px-4 py-3">Status</th>
							<th class="px-4 py-3">Phase</th>
							<th class="px-4 py-3">Date</th>
							<th class="px-4 py-3">Cartridge</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-[var(--color-tron-border)]">
						{#each data.inspections as insp}
							<tr class="transition-colors hover:bg-[var(--color-tron-bg-tertiary)]">
								<td class="px-4 py-2">
									{#if insp.result === 'pass'}
										<span class="rounded-full bg-[var(--color-tron-green)]/20 px-2 py-0.5 text-xs font-semibold text-[var(--color-tron-green)]">PASS</span>
									{:else if insp.result === 'fail'}
										<span class="rounded-full bg-[var(--color-tron-red)]/20 px-2 py-0.5 text-xs font-semibold text-[var(--color-tron-red)]">FAIL</span>
									{:else}
										<span class="text-xs text-[var(--color-tron-text-secondary)]">—</span>
									{/if}
								</td>
								<td class="px-4 py-2 text-sm text-[var(--color-tron-text-primary)]">
									{insp.confidenceScore != null ? Math.round(insp.confidenceScore * 100) + '%' : '—'}
								</td>
								<td class="px-4 py-2 text-sm text-[var(--color-tron-text-primary)]">
									{data.projectMap[insp.projectId] || insp.projectId}
								</td>
								<td class="px-4 py-2 text-sm text-[var(--color-tron-text-secondary)]">{insp.inspectionType || '—'}</td>
								<td class="px-4 py-2">
									{#if insp.status === 'complete'}
										<span class="text-xs text-[var(--color-tron-green)]">Complete</span>
									{:else if insp.status === 'pending' || insp.status === 'processing'}
										<span class="animate-pulse text-xs text-[var(--color-tron-yellow)]">{insp.status}</span>
									{:else}
										<span class="text-xs text-[var(--color-tron-red)]">{insp.status}</span>
									{/if}
								</td>
								<td class="px-4 py-2 text-sm text-[var(--color-tron-text-secondary)]">{insp.phase || '—'}</td>
								<td class="px-4 py-2 text-xs text-[var(--color-tron-text-secondary)]">{fmtDate(insp.createdAt)}</td>
								<td class="px-4 py-2">
									{#if insp.cartridgeRecordId}
										<a href="/cv/cartridge/{insp.cartridgeRecordId}" class="text-xs text-[var(--color-tron-cyan)] hover:underline">{insp.cartridgeRecordId}</a>
									{:else}
										<span class="text-xs text-[var(--color-tron-text-secondary)]">—</span>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>

	<!-- Pagination -->
	{#if data.pagination.totalPages > 1}
		<div class="flex items-center justify-center gap-2">
			<button onclick={() => goToPage(data.pagination.page - 1)} disabled={data.pagination.page <= 1} class="rounded border border-[var(--color-tron-border)] px-3 py-1 text-sm text-[var(--color-tron-text-secondary)] disabled:opacity-50">Prev</button>
			<span class="text-sm text-[var(--color-tron-text-secondary)]">Page {data.pagination.page} of {data.pagination.totalPages}</span>
			<button onclick={() => goToPage(data.pagination.page + 1)} disabled={data.pagination.page >= data.pagination.totalPages} class="rounded border border-[var(--color-tron-border)] px-3 py-1 text-sm text-[var(--color-tron-text-secondary)] disabled:opacity-50">Next</button>
		</div>
	{/if}
</div>
