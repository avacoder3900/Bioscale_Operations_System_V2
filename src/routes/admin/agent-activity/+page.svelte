<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';

	interface Props {
		data: {
			auditEntries: Array<{
				id: string;
				tableName: string;
				recordId: string;
				action: string;
				oldData: unknown;
				newData: unknown;
				changedAt: Date;
				changedBy: string | null;
			}>;
			pagination: {
				page: number;
				limit: number;
				total: number;
				hasNext: boolean;
				hasPrev: boolean;
			};
			stats: {
				totalActionsToday: number;
				mostCommonAction: string;
				mostCommonActionCount: number;
				lastActiveTime: Date | null;
			};
			filters: {
				actionTypes: string[];
				currentAction: string | null;
				currentDateFrom: string | null;
				currentDateTo: string | null;
			};
		};
	}

	let { data }: Props = $props();

	// Form state for filters
	let actionFilter = $state(data.filters.currentAction || '');
	let dateFromFilter = $state(data.filters.currentDateFrom || '');
	let dateToFilter = $state(data.filters.currentDateTo || '');

	// Apply filters by updating URL
	function applyFilters() {
		const params = new URLSearchParams();
		if (actionFilter) params.set('action', actionFilter);
		if (dateFromFilter) params.set('dateFrom', dateFromFilter);
		if (dateToFilter) params.set('dateTo', dateToFilter);
		params.set('page', '1'); // Reset to first page when filtering
		
		goto(`?${params.toString()}`);
	}

	// Clear filters
	function clearFilters() {
		actionFilter = '';
		dateFromFilter = '';
		dateToFilter = '';
		goto('/admin/agent-activity');
	}

	// Navigate to page
	function goToPage(pageNum: number) {
		const params = new URLSearchParams($page.url.searchParams);
		params.set('page', pageNum.toString());
		goto(`?${params.toString()}`);
	}

	// Format timestamp for display
	function formatTimestamp(date: Date): string {
		return new Date(date).toLocaleString();
	}

	// Format duration (for execution time in newData)
	function formatDuration(ms: number): string {
		if (ms < 1000) return `${ms}ms`;
		return `${(ms / 1000).toFixed(2)}s`;
	}

	// Extract execution time from newData if available
	function getExecutionTime(newData: unknown): number | null {
		if (typeof newData === 'object' && newData && 'executionTimeMs' in newData) {
			return newData.executionTimeMs as number;
		}
		return null;
	}

	// Extract endpoint from newData if available
	function getEndpoint(newData: unknown): string | null {
		if (typeof newData === 'object' && newData && 'endpoint' in newData) {
			return newData.endpoint as string;
		}
		return null;
	}

	// Extract response status from newData if available
	function getResponseStatus(newData: unknown): number | null {
		if (typeof newData === 'object' && newData && 'responseStatus' in newData) {
			return newData.responseStatus as number;
		}
		return null;
	}
</script>

<svelte:head>
	<title>Agent Activity Dashboard - Bioscale Operations</title>
</svelte:head>

<div class="p-6 max-w-7xl mx-auto">
	<!-- Header -->
	<div class="mb-8">
		<h1 class="text-3xl font-bold text-gray-900 mb-2">Agent Activity Dashboard</h1>
		<p class="text-gray-600">
			Read-only dashboard showing all OpenClaw Agent audit log entries. This is a hidden administrative route.
		</p>
	</div>

	<!-- Stats Cards -->
	<div class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
		<div class="bg-white p-6 rounded-lg shadow">
			<div class="text-2xl font-bold text-blue-600">{data.stats.totalActionsToday}</div>
			<div class="text-sm text-gray-600">Actions Today</div>
		</div>
		<div class="bg-white p-6 rounded-lg shadow">
			<div class="text-2xl font-bold text-green-600">{data.stats.mostCommonAction}</div>
			<div class="text-sm text-gray-600">Most Common Action ({data.stats.mostCommonActionCount}x)</div>
		</div>
		<div class="bg-white p-6 rounded-lg shadow">
			<div class="text-2xl font-bold text-purple-600">
				{data.stats.lastActiveTime ? formatTimestamp(data.stats.lastActiveTime) : 'Never'}
			</div>
			<div class="text-sm text-gray-600">Last Active Time</div>
		</div>
		<div class="bg-white p-6 rounded-lg shadow">
			<div class="text-2xl font-bold text-orange-600">{data.pagination.total}</div>
			<div class="text-sm text-gray-600">Total Actions</div>
		</div>
	</div>

	<!-- Filters -->
	<div class="bg-white p-6 rounded-lg shadow mb-6">
		<h2 class="text-lg font-semibold mb-4">Filters</h2>
		<div class="grid grid-cols-1 md:grid-cols-4 gap-4">
			<div>
				<label class="block text-sm font-medium text-gray-700 mb-2">Action Type</label>
				<select 
					bind:value={actionFilter}
					class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
				>
					<option value="">All Actions</option>
					{#each data.filters.actionTypes as actionType}
						<option value={actionType}>{actionType}</option>
					{/each}
				</select>
			</div>
			<div>
				<label class="block text-sm font-medium text-gray-700 mb-2">Date From</label>
				<input 
					type="date" 
					bind:value={dateFromFilter}
					class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
				/>
			</div>
			<div>
				<label class="block text-sm font-medium text-gray-700 mb-2">Date To</label>
				<input 
					type="date" 
					bind:value={dateToFilter}
					class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
				/>
			</div>
			<div class="flex items-end gap-2">
				<button 
					onclick={applyFilters}
					class="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
				>
					Apply
				</button>
				<button 
					onclick={clearFilters}
					class="px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-500"
				>
					Clear
				</button>
			</div>
		</div>
	</div>

	<!-- Activity Timeline -->
	<div class="bg-white rounded-lg shadow">
		<div class="px-6 py-4 border-b border-gray-200">
			<h2 class="text-lg font-semibold">Activity Timeline</h2>
			<p class="text-sm text-gray-600">Showing {data.pagination.total} total entries, page {data.pagination.page}</p>
		</div>
		
		<div class="overflow-x-auto">
			<table class="w-full">
				<thead class="bg-gray-50">
					<tr>
						<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Timestamp</th>
						<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
						<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Entity</th>
						<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Endpoint</th>
						<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
						<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Duration</th>
					</tr>
				</thead>
				<tbody class="bg-white divide-y divide-gray-200">
					{#each data.auditEntries as entry}
						<tr class="hover:bg-gray-50">
							<td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
								{formatTimestamp(entry.changedAt)}
							</td>
							<td class="px-6 py-4 whitespace-nowrap">
								<span class="px-2 py-1 text-xs font-medium bg-blue-100 text-blue-800 rounded-full">
									{entry.action}
								</span>
							</td>
							<td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
								<div class="font-medium">{entry.tableName}</div>
								<div class="text-gray-500 text-xs">{entry.recordId}</div>
							</td>
							<td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900 font-mono">
								{getEndpoint(entry.newData) || '-'}
							</td>
							<td class="px-6 py-4 whitespace-nowrap">
								{#if true}
									{@const status = getResponseStatus(entry.newData)}
									{#if status !== null}
										<span class="px-2 py-1 text-xs font-medium rounded-full {
											status < 300 ? 'bg-green-100 text-green-800' :
											status < 400 ? 'bg-yellow-100 text-yellow-800' :
											'bg-red-100 text-red-800'
										}">
											{status}
										</span>
									{:else}
										<span class="text-gray-400">-</span>
									{/if}
								{/if}
							</td>
							<td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
								{#if true}
									{@const executionTime = getExecutionTime(entry.newData)}
									{#if executionTime !== null}
										{formatDuration(executionTime)}
									{:else}
										<span class="text-gray-400">-</span>
									{/if}
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		<!-- Pagination -->
		{#if data.pagination.total > data.pagination.limit}
			<div class="px-6 py-4 border-t border-gray-200 flex items-center justify-between">
				<div class="text-sm text-gray-700">
					Showing {(data.pagination.page - 1) * data.pagination.limit + 1} to 
					{Math.min(data.pagination.page * data.pagination.limit, data.pagination.total)} of 
					{data.pagination.total} results
				</div>
				<div class="flex items-center space-x-2">
					{#if data.pagination.hasPrev}
						<button 
							onclick={() => goToPage(data.pagination.page - 1)}
							class="px-3 py-2 text-sm bg-white border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50"
						>
							Previous
						</button>
					{/if}
					
					<span class="px-3 py-2 text-sm text-gray-700">
						Page {data.pagination.page}
					</span>
					
					{#if data.pagination.hasNext}
						<button 
							onclick={() => goToPage(data.pagination.page + 1)}
							class="px-3 py-2 text-sm bg-white border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50"
						>
							Next
						</button>
					{/if}
				</div>
			</div>
		{/if}
	</div>
</div>