<script lang="ts">
	import { goto } from '$app/navigation';

	let { data } = $props();

	let searchInput = $state(data.filters.search);
	let statusFilter = $state(data.filters.status);

	function applyFilters() {
		const params = new URLSearchParams();
		if (searchInput.trim()) params.set('search', searchInput.trim());
		if (statusFilter) params.set('status', statusFilter);
		goto(`/spu/test-results?${params.toString()}`);
	}

	function handleSearch(e: Event) {
		e.preventDefault();
		applyFilters();
	}

	function formatDuration(ms: number | null): string {
		if (!ms) return '—';
		if (ms < 1000) return `${ms}ms`;
		const seconds = ms / 1000;
		if (seconds < 60) return `${seconds.toFixed(1)}s`;
		const minutes = Math.floor(seconds / 60);
		const remainingSeconds = Math.round(seconds % 60);
		return `${minutes}m ${remainingSeconds}s`;
	}

	function formatDate(date: Date | string | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleString();
	}

	function getStatusColor(status: string): string {
		const colors: Record<string, string> = {
			uploaded: 'var(--color-tron-cyan, #00ffff)',
			processed: 'var(--color-tron-green, #39ff14)',
			flagged: '#f97316',
			archived: 'var(--color-tron-text-secondary, #6b7280)'
		};
		return colors[status] ?? 'var(--color-tron-text-secondary, #6b7280)';
	}

	function getStatusBg(status: string): string {
		const bgs: Record<string, string> = {
			uploaded: 'rgba(0, 255, 255, 0.12)',
			processed: 'rgba(57, 255, 20, 0.12)',
			flagged: 'rgba(249, 115, 22, 0.12)',
			archived: 'rgba(107, 114, 128, 0.12)'
		};
		return bgs[status] ?? 'rgba(107, 114, 128, 0.12)';
	}
</script>

<div class="mx-auto max-w-7xl space-y-6 p-4">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan, #00ffff)">
			Test Results
		</h1>
	</div>

	<!-- Stats Cards -->
	<div class="grid grid-cols-2 gap-4 md:grid-cols-4">
		<div class="tron-card p-4 text-center">
			<div class="text-2xl font-bold" style="color: var(--color-tron-cyan, #00ffff)">
				{data.stats.total}
			</div>
			<div class="text-sm" style="color: var(--color-tron-text-secondary, #9ca3af)">Total</div>
		</div>
		<div class="tron-card p-4 text-center">
			<div class="text-2xl font-bold" style="color: var(--color-tron-cyan, #00ffff)">
				{data.stats.uploaded}
			</div>
			<div class="text-sm" style="color: var(--color-tron-text-secondary, #9ca3af)">
				Uploaded
			</div>
		</div>
		<div class="tron-card p-4 text-center">
			<div class="text-2xl font-bold" style="color: var(--color-tron-green, #39ff14)">
				{data.stats.processed}
			</div>
			<div class="text-sm" style="color: var(--color-tron-text-secondary, #9ca3af)">
				Processed
			</div>
		</div>
		<div class="tron-card p-4 text-center">
			<div class="text-2xl font-bold" style="color: #f97316">
				{data.stats.flagged}
			</div>
			<div class="text-sm" style="color: var(--color-tron-text-secondary, #9ca3af)">
				Flagged
			</div>
		</div>
	</div>

	<!-- Search & Filters -->
	<div class="tron-card p-4">
		<form onsubmit={handleSearch} class="flex flex-wrap items-end gap-3">
			<div class="flex-1">
				<input
					type="text"
					class="tron-input w-full"
					style="min-height: 44px"
					placeholder="Search by cartridge UUID..."
					bind:value={searchInput}
				/>
			</div>
			<select
				class="tron-input"
				style="min-height: 44px"
				bind:value={statusFilter}
				onchange={applyFilters}
			>
				<option value="">All Status</option>
				<option value="uploaded">Uploaded</option>
				<option value="processed">Processed</option>
				<option value="flagged">Flagged</option>
				<option value="archived">Archived</option>
			</select>
			<button class="tron-button" style="min-height: 44px" type="submit">Search</button>
			{#if data.filters.search || data.filters.status}
				<a href="/spu/test-results" class="tron-button" style="min-height: 44px; opacity: 0.7">
					Clear
				</a>
			{/if}
		</form>
	</div>

	<!-- Table -->
	{#if data.results.length === 0}
		<div class="tron-card p-8 text-center">
			<p style="color: var(--color-tron-text-secondary, #9ca3af)">
				{#if data.filters.search || data.filters.status}
					No test results match your filters.
				{:else}
					No test results found. Results appear here after devices upload test data.
				{/if}
			</p>
		</div>
	{:else}
		<div class="overflow-x-auto">
			<table class="tron-table w-full">
				<thead>
					<tr>
						<th>ID</th>
						<th>Cartridge</th>
						<th>Assay</th>
						<th>Device</th>
						<th>Duration</th>
						<th>Readings</th>
						<th>Status</th>
						<th>Created</th>
					</tr>
				</thead>
				<tbody>
					{#each data.results as result (result.id)}
						<tr
							style="cursor: pointer"
							onclick={() => goto(`/spu/test-results/${result.id}`)}
						>
							<td style="font-family: monospace">{result.id}</td>
							<td style="font-family: monospace; color: var(--color-tron-cyan, #00ffff)">
								{result.cartridgeUuid ?? '—'}
							</td>
							<td>
								{#if result.assayId}
									<span style="font-family: monospace; color: var(--color-tron-cyan, #00ffff)">
										{result.assayId}
									</span>
								{:else}
									<span style="color: var(--color-tron-text-secondary, #9ca3af)">—</span>
								{/if}
							</td>
							<td style="font-family: monospace">{result.deviceId ?? '—'}</td>
							<td>{formatDuration(result.duration)}</td>
							<td style="font-family: monospace">{result.numberOfReadings ?? '—'}</td>
							<td>
								<span
									class="inline-block rounded px-2 py-1 text-xs font-semibold"
									style="background: {getStatusBg(result.status)}; color: {getStatusColor(result.status)}; border: 1px solid {getStatusColor(result.status)}"
								>
									{result.status}
								</span>
							</td>
							<td style="color: var(--color-tron-text-secondary, #9ca3af); font-size: 0.8125rem">
								{formatDate(result.createdAt)}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
