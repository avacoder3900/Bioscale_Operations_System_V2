<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { TronCard, TronBadge } from '$lib/components/ui';

	let { data } = $props();

	let statusFilter = $state(data.filters?.status ?? '');
	let deviceIdFilter = $state(data.filters?.deviceId ?? '');

	function applyFilters() {
		const params = new URLSearchParams();
		if (statusFilter) params.set('status', statusFilter);
		if (deviceIdFilter.trim()) params.set('deviceId', deviceIdFilter.trim());
		goto(`/spu/test-results?${params.toString()}`);
	}

	function clearFilters() {
		statusFilter = '';
		deviceIdFilter = '';
		goto('/spu/test-results');
	}

	function goToPage(p: number) {
		const params = new URLSearchParams(page.url.searchParams);
		params.set('page', String(p));
		goto(`/spu/test-results?${params.toString()}`);
	}

	function getStatusVariant(status: string): 'success' | 'info' | 'warning' | 'error' | 'neutral' {
		switch (status) {
			case 'completed': return 'success';
			case 'processing': return 'info';
			case 'uploaded': return 'neutral';
			case 'failed': return 'error';
			default: return 'neutral';
		}
	}

	function formatDate(date: string | Date | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleString();
	}

	function formatDuration(seconds: number | null): string {
		if (!seconds) return '—';
		const mins = Math.floor(seconds / 60);
		const secs = seconds % 60;
		if (mins === 0) return `${secs}s`;
		return `${mins}m ${secs}s`;
	}

	function truncateId(id: string): string {
		if (!id) return '—';
		return id.length > 12 ? id.substring(0, 12) + '...' : id;
	}

	let hasFilters = $derived(!!statusFilter || !!deviceIdFilter);
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h2 class="tron-text-primary font-mono text-2xl font-bold">Test Results</h2>
			<p class="tron-text-muted text-sm">{data.pagination?.total ?? 0} total results</p>
		</div>
	</div>

	<!-- Filter Bar -->
	<TronCard>
		<div class="flex flex-wrap items-end gap-3">
			<div>
				<label class="tron-text-muted mb-1 block text-xs">Status</label>
				<select
					class="tron-input"
					style="min-height: 40px"
					bind:value={statusFilter}
					onchange={applyFilters}
				>
					<option value="">All Statuses</option>
					<option value="uploaded">Uploaded</option>
					<option value="processing">Processing</option>
					<option value="completed">Completed</option>
					<option value="failed">Failed</option>
				</select>
			</div>
			<div class="flex-1">
				<label class="tron-text-muted mb-1 block text-xs">Device ID</label>
				<input
					type="text"
					class="tron-input w-full"
					style="min-height: 40px"
					placeholder="Filter by device ID..."
					bind:value={deviceIdFilter}
					onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && applyFilters()}
				/>
			</div>
			<button class="tron-button" style="min-height: 40px" onclick={applyFilters}>Apply</button>
			{#if hasFilters}
				<button class="tron-button" style="min-height: 40px" onclick={clearFilters}>Clear</button>
			{/if}
		</div>
	</TronCard>

	<!-- Results Table -->
	<TronCard>
		<div class="overflow-x-auto">
			<table class="tron-table">
				<thead>
					<tr>
						<th>ID</th>
						<th>Cartridge UUID</th>
						<th>Assay</th>
						<th>Device</th>
						<th>Status</th>
						<th>Readings</th>
						<th>Scans (B/T)</th>
						<th>Duration</th>
						<th>Processed</th>
						<th>Created</th>
					</tr>
				</thead>
				<tbody>
					{#each data.results ?? [] as result (result.id)}
						<tr>
							<td class="font-mono text-[var(--color-tron-cyan)]" title={result.id}>{truncateId(result.id)}</td>
							<td class="font-mono text-xs">{result.cartridgeUuid ?? '—'}</td>
							<td>{result.assayId ?? '—'}</td>
							<td class="font-mono text-xs">{result.deviceId ?? '—'}</td>
							<td><TronBadge variant={getStatusVariant(result.status)}>{result.status}</TronBadge></td>
							<td class="text-center font-mono">{result.numberOfReadings ?? '—'}</td>
							<td class="text-center font-mono">{result.baselineScans ?? '—'}/{result.testScans ?? '—'}</td>
							<td class="font-mono">{formatDuration(result.duration)}</td>
							<td class="tron-text-muted text-xs">{formatDate(result.processedAt)}</td>
							<td class="tron-text-muted text-xs">{formatDate(result.createdAt)}</td>
						</tr>
					{:else}
						<tr>
							<td colspan="10" class="tron-text-muted text-center">
								{#if hasFilters}
									No results match your filters.
								{:else}
									No test results found.
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</TronCard>

	<!-- Pagination -->
	{#if data.pagination && (data.pagination.hasPrev || data.pagination.hasNext)}
		<div class="flex items-center justify-between">
			<button
				class="tron-button"
				disabled={!data.pagination.hasPrev}
				onclick={() => goToPage(data.pagination.page - 1)}
			>
				Previous
			</button>
			<span class="tron-text-muted text-sm">
				Page {data.pagination.page} of {Math.ceil(data.pagination.total / data.pagination.limit)}
			</span>
			<button
				class="tron-button"
				disabled={!data.pagination.hasNext}
				onclick={() => goToPage(data.pagination.page + 1)}
			>
				Next
			</button>
		</div>
	{/if}
</div>
