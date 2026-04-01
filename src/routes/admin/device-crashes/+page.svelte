<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { getCheckpointName } from '$lib/checkpoint-codes';

	interface Props {
		data: {
			crashes: Array<{
				_id: string;
				deviceId: string;
				deviceName: string | null;
				firmwareVersion: number | null;
				bootCount: number | null;
				detectedAt: string;
				lastCheckpoint: number;
				lastCheckpointName: string;
				checkpointSequence: number[];
				crashCategory: string;
				sessionLogId: string | null;
			}>;
			pagination: {
				page: number;
				limit: number;
				total: number;
				hasNext: boolean;
				hasPrev: boolean;
			};
			stats: {
				totalAllTime: number;
				last7Days: number;
				last24Hours: number;
				topCategory: { name: string; count: number } | null;
				topCheckpoint: { code: number; name: string; count: number } | null;
				topDevice: { deviceId: string; count: number } | null;
			};
			filterOptions: {
				devices: string[];
				categories: string[];
				firmwareVersions: number[];
			};
			currentFilters: {
				deviceId: string | null;
				category: string | null;
				firmware: string | null;
				from: string | null;
				to: string | null;
			};
		};
	}

	let { data }: Props = $props();

	let deviceFilter = $state(data.currentFilters.deviceId || '');
	let categoryFilter = $state(data.currentFilters.category || '');
	let firmwareFilter = $state(data.currentFilters.firmware || '');
	let dateFrom = $state(data.currentFilters.from || '');
	let dateTo = $state(data.currentFilters.to || '');
	let expandedRows: Record<string, boolean> = $state({});

	function toggleRow(id: string) {
		expandedRows[id] = !expandedRows[id];
	}

	function applyFilters() {
		const params = new URLSearchParams();
		if (deviceFilter) params.set('deviceId', deviceFilter);
		if (categoryFilter) params.set('category', categoryFilter);
		if (firmwareFilter) params.set('firmware', firmwareFilter);
		if (dateFrom) params.set('from', dateFrom);
		if (dateTo) params.set('to', dateTo);
		params.set('page', '1');
		goto(`?${params.toString()}`);
	}

	function clearFilters() {
		deviceFilter = '';
		categoryFilter = '';
		firmwareFilter = '';
		dateFrom = '';
		dateTo = '';
		goto('/admin/device-crashes');
	}

	function goToPage(pageNum: number) {
		const params = new URLSearchParams($page.url.searchParams);
		params.set('page', pageNum.toString());
		goto(`?${params.toString()}`);
	}

	function formatDate(date: string): string {
		return new Date(date).toLocaleString();
	}
</script>

<svelte:head>
	<title>Device Crashes — Fleet Overview</title>
</svelte:head>

<div class="p-6 max-w-7xl mx-auto">
	<!-- Header -->
	<div class="mb-8">
		<h1 class="text-3xl font-bold text-gray-900 mb-2">Device Crash Dashboard</h1>
		<p class="text-gray-600">Fleet-wide crash overview across all devices</p>
	</div>

	<!-- Stats Cards -->
	<div class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
		<div class="bg-white p-6 rounded-lg shadow">
			<div class="text-2xl font-bold text-red-600">{data.stats.totalAllTime}</div>
			<div class="text-sm text-gray-600">Total Crashes</div>
			<div class="text-xs text-gray-400 mt-1">
				{data.stats.last7Days} last 7d / {data.stats.last24Hours} last 24h
			</div>
		</div>
		<div class="bg-white p-6 rounded-lg shadow">
			<div class="text-2xl font-bold text-purple-600">
				{data.stats.topCategory?.name ?? 'None'}
			</div>
			<div class="text-sm text-gray-600">
				Most Common Category {data.stats.topCategory ? `(${data.stats.topCategory.count}x)` : ''}
			</div>
		</div>
		<div class="bg-white p-6 rounded-lg shadow">
			<div class="text-2xl font-bold text-orange-600 font-mono truncate">
				{data.stats.topDevice?.deviceId ?? 'None'}
			</div>
			<div class="text-sm text-gray-600">
				Most Crash-Prone Device {data.stats.topDevice ? `(${data.stats.topDevice.count}x)` : ''}
			</div>
		</div>
		<div class="bg-white p-6 rounded-lg shadow">
			{#if data.stats.topCheckpoint}
				<div class="text-2xl font-bold text-blue-600">CP {data.stats.topCheckpoint.code}</div>
				<div class="text-sm text-gray-600">
					{data.stats.topCheckpoint.name} ({data.stats.topCheckpoint.count}x)
				</div>
			{:else}
				<div class="text-2xl font-bold text-gray-400">-</div>
				<div class="text-sm text-gray-600">Top Checkpoint Failure</div>
			{/if}
		</div>
	</div>

	<!-- Filters -->
	<div class="bg-white p-6 rounded-lg shadow mb-6">
		<h2 class="text-lg font-semibold mb-4">Filters</h2>
		<div class="grid grid-cols-1 md:grid-cols-6 gap-4">
			<div>
				<label class="block text-sm font-medium text-gray-700 mb-2">Device</label>
				<select bind:value={deviceFilter}
					class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500">
					<option value="">All Devices</option>
					{#each data.filterOptions.devices as d}
						<option value={d}>{d}</option>
					{/each}
				</select>
			</div>
			<div>
				<label class="block text-sm font-medium text-gray-700 mb-2">Category</label>
				<select bind:value={categoryFilter}
					class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500">
					<option value="">All Categories</option>
					{#each data.filterOptions.categories as c}
						<option value={c}>{c}</option>
					{/each}
				</select>
			</div>
			<div>
				<label class="block text-sm font-medium text-gray-700 mb-2">Firmware</label>
				<select bind:value={firmwareFilter}
					class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500">
					<option value="">All Versions</option>
					{#each data.filterOptions.firmwareVersions as v}
						<option value={v}>v{v}</option>
					{/each}
				</select>
			</div>
			<div>
				<label class="block text-sm font-medium text-gray-700 mb-2">From</label>
				<input type="date" bind:value={dateFrom}
					class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" />
			</div>
			<div>
				<label class="block text-sm font-medium text-gray-700 mb-2">To</label>
				<input type="date" bind:value={dateTo}
					class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" />
			</div>
			<div class="flex items-end gap-2">
				<button onclick={applyFilters}
					class="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700">Apply</button>
				<button onclick={clearFilters}
					class="px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700">Clear</button>
			</div>
		</div>
	</div>

	<!-- Crashes Table -->
	<div class="bg-white rounded-lg shadow">
		<div class="px-6 py-4 border-b border-gray-200">
			<h2 class="text-lg font-semibold">Crash Reports</h2>
			<p class="text-sm text-gray-600">Showing {data.pagination.total} total, page {data.pagination.page}</p>
		</div>

		<div class="overflow-x-auto">
			<table class="w-full">
				<thead class="bg-gray-50">
					<tr>
						<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Detected</th>
						<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Device</th>
						<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Firmware</th>
						<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Checkpoint</th>
						<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Category</th>
					</tr>
				</thead>
				<tbody class="bg-white divide-y divide-gray-200">
					{#each data.crashes as crash}
						<tr class="hover:bg-gray-50 cursor-pointer" onclick={() => toggleRow(crash._id)}>
							<td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{formatDate(crash.detectedAt)}</td>
							<td class="px-6 py-4 whitespace-nowrap text-sm">
								<div class="font-mono text-gray-900">{crash.deviceName ?? crash.deviceId}</div>
								{#if crash.deviceName}
									<div class="text-xs text-gray-500 font-mono">{crash.deviceId}</div>
								{/if}
							</td>
							<td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">v{crash.firmwareVersion ?? '?'}</td>
							<td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
								<span class="font-mono">CP {crash.lastCheckpoint}</span>
								<span class="text-gray-500 ml-1">({crash.lastCheckpointName})</span>
							</td>
							<td class="px-6 py-4 whitespace-nowrap">
								<span class="px-2 py-1 text-xs font-medium bg-red-100 text-red-800 rounded-full">{crash.crashCategory}</span>
							</td>
						</tr>
						{#if expandedRows[crash._id]}
							<tr>
								<td colspan="5" class="px-6 py-4 bg-gray-50">
									<div class="text-sm">
										<div class="font-medium text-gray-700 mb-2">Checkpoint Sequence ({crash.checkpointSequence.length} steps):</div>
										<div class="flex flex-wrap gap-1">
											{#each crash.checkpointSequence as cp}
												<span class="px-2 py-1 text-xs font-mono rounded {cp === crash.lastCheckpoint ? 'bg-red-200 text-red-900 font-bold' : 'bg-gray-200 text-gray-700'}">
													{cp} ({getCheckpointName(cp)})
												</span>
											{/each}
										</div>
										{#if crash.sessionLogId}
											<div class="mt-2 text-gray-500">Session Log: <span class="font-mono">{crash.sessionLogId}</span></div>
										{/if}
									</div>
								</td>
							</tr>
						{/if}
					{/each}
					{#if data.crashes.length === 0}
						<tr><td colspan="5" class="px-6 py-8 text-center text-gray-500">No crashes found</td></tr>
					{/if}
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
						<button onclick={() => goToPage(data.pagination.page - 1)}
							class="px-3 py-2 text-sm bg-white border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50">
							Previous
						</button>
					{/if}
					<span class="px-3 py-2 text-sm text-gray-700">Page {data.pagination.page}</span>
					{#if data.pagination.hasNext}
						<button onclick={() => goToPage(data.pagination.page + 1)}
							class="px-3 py-2 text-sm bg-white border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50">
							Next
						</button>
					{/if}
				</div>
			</div>
		{/if}
	</div>
</div>
