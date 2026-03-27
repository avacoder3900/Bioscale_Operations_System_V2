<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { CHECKPOINT_NAMES, CRASH_CATEGORIES, getCheckpointName } from '$lib/checkpoint-codes';

	interface Props {
		data: {
			deviceId: string;
			logs: Array<{
				_id: string;
				sessionId: string;
				firmwareVersion: number | null;
				bootCount: number | null;
				uploadedAt: string;
				lineCount: number;
				errorCount: number;
				hasCrash: boolean;
				firstLine: string;
				lastLine: string;
			}>;
			crashes: Array<{
				_id: string;
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
			webhookLogs: Array<{
				_id: string;
				eventName: string;
				timestamp: string;
				processingTimeMs: number | null;
				request: { raw?: string; parsed?: any; particlePublishedAt?: string };
				response: { status?: string; data?: any; errorMessage?: string };
			}>;
			events: Array<{
				_id: string;
				eventType: string;
				eventData: any;
				createdAt: string;
			}>;
			stats: {
				totalLogs: number;
				totalCrashes: number;
				mostCommonCrashCategory: string | null;
				avgWebhookTimeMs: number | null;
				lastCrash: string | null;
			};
			filters: {
				from: string;
				to: string;
			};
		};
	}

	let { data }: Props = $props();

	let activeTab = $state('timeline');
	let dateFrom = $state(data.filters.from);
	let dateTo = $state(data.filters.to);
	let expandedRows: Record<string, boolean> = $state({});

	function toggleRow(id: string) {
		expandedRows[id] = !expandedRows[id];
	}

	function applyFilters() {
		const params = new URLSearchParams();
		if (dateFrom) params.set('from', dateFrom);
		if (dateTo) params.set('to', dateTo);
		goto(`?${params.toString()}`);
	}

	function clearFilters() {
		dateFrom = '';
		dateTo = '';
		goto($page.url.pathname);
	}

	function formatDate(date: string): string {
		return new Date(date).toLocaleString();
	}

	function formatMs(ms: number | null): string {
		if (ms === null) return '-';
		return `${ms}ms`;
	}

	// Build unified timeline from all sources
	function getTimeline() {
		const items: Array<{ type: string; date: string; data: any }> = [];

		for (const log of data.logs) {
			items.push({ type: 'log', date: log.uploadedAt, data: log });
		}
		for (const crash of data.crashes) {
			items.push({ type: 'crash', date: crash.detectedAt, data: crash });
		}
		for (const wh of data.webhookLogs) {
			items.push({ type: 'webhook', date: wh.timestamp, data: wh });
		}
		for (const ev of data.events) {
			items.push({ type: 'event', date: ev.createdAt, data: ev });
		}

		items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
		return items;
	}
</script>

<svelte:head>
	<title>Device Diagnostics — {data.deviceId}</title>
</svelte:head>

<div class="p-6 max-w-7xl mx-auto">
	<!-- Header -->
	<div class="mb-8">
		<h1 class="text-3xl font-bold text-gray-900 mb-2">Device Diagnostics</h1>
		<p class="text-gray-600 font-mono">{data.deviceId}</p>
	</div>

	<!-- Stats Cards -->
	<div class="grid grid-cols-1 md:grid-cols-5 gap-6 mb-8">
		<div class="bg-white p-6 rounded-lg shadow">
			<div class="text-2xl font-bold text-blue-600">{data.stats.totalLogs}</div>
			<div class="text-sm text-gray-600">Session Logs</div>
		</div>
		<div class="bg-white p-6 rounded-lg shadow">
			<div class="text-2xl font-bold {data.stats.totalCrashes > 0 ? 'text-red-600' : 'text-green-600'}">
				{data.stats.totalCrashes}
			</div>
			<div class="text-sm text-gray-600">Crashes</div>
		</div>
		<div class="bg-white p-6 rounded-lg shadow">
			<div class="text-2xl font-bold text-purple-600">
				{data.stats.mostCommonCrashCategory ?? 'None'}
			</div>
			<div class="text-sm text-gray-600">Top Crash Category</div>
		</div>
		<div class="bg-white p-6 rounded-lg shadow">
			<div class="text-2xl font-bold text-orange-600">
				{data.stats.avgWebhookTimeMs !== null ? `${data.stats.avgWebhookTimeMs}ms` : '-'}
			</div>
			<div class="text-sm text-gray-600">Avg Webhook Time</div>
		</div>
		<div class="bg-white p-6 rounded-lg shadow">
			<div class="text-2xl font-bold text-gray-700">
				{data.stats.lastCrash ? formatDate(data.stats.lastCrash) : 'No crashes'}
			</div>
			<div class="text-sm text-gray-600">Last Crash</div>
		</div>
	</div>

	<!-- Date Range Filter -->
	<div class="bg-white p-6 rounded-lg shadow mb-6">
		<div class="grid grid-cols-1 md:grid-cols-4 gap-4">
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

	<!-- Tabs -->
	<div class="bg-white rounded-lg shadow">
		<div class="border-b border-gray-200">
			<nav class="flex -mb-px">
				{#each [
					{ id: 'timeline', label: 'Timeline' },
					{ id: 'logs', label: 'Session Logs' },
					{ id: 'crashes', label: `Crashes (${data.crashes.length})` },
					{ id: 'webhooks', label: 'Webhook Logs' }
				] as tab}
					<button
						onclick={() => activeTab = tab.id}
						class="px-6 py-3 text-sm font-medium border-b-2 {activeTab === tab.id
							? 'border-blue-500 text-blue-600'
							: 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}"
					>
						{tab.label}
					</button>
				{/each}
			</nav>
		</div>

		<div class="p-0">
			<!-- Timeline Tab -->
			{#if activeTab === 'timeline'}
				<div class="overflow-x-auto">
					<table class="w-full">
						<thead class="bg-gray-50">
							<tr>
								<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Time</th>
								<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th>
								<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Details</th>
							</tr>
						</thead>
						<tbody class="bg-white divide-y divide-gray-200">
							{#each getTimeline() as item}
								<tr class="hover:bg-gray-50">
									<td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{formatDate(item.date)}</td>
									<td class="px-6 py-4 whitespace-nowrap">
										{#if item.type === 'crash'}
											<span class="px-2 py-1 text-xs font-medium bg-red-100 text-red-800 rounded-full">Crash</span>
										{:else if item.type === 'log'}
											<span class="px-2 py-1 text-xs font-medium bg-blue-100 text-blue-800 rounded-full">Session Log</span>
										{:else if item.type === 'webhook'}
											<span class="px-2 py-1 text-xs font-medium bg-green-100 text-green-800 rounded-full">Webhook</span>
										{:else}
											<span class="px-2 py-1 text-xs font-medium bg-gray-100 text-gray-800 rounded-full">Event</span>
										{/if}
									</td>
									<td class="px-6 py-4 text-sm text-gray-900">
										{#if item.type === 'crash'}
											{item.data.crashCategory} — CP {item.data.lastCheckpoint} ({item.data.lastCheckpointName})
										{:else if item.type === 'log'}
											FW v{item.data.firmwareVersion ?? '?'}, {item.data.lineCount} lines, {item.data.errorCount} errors
											{#if item.data.hasCrash}<span class="text-red-600 font-medium ml-2">CRASH DETECTED</span>{/if}
										{:else if item.type === 'webhook'}
											{item.data.eventName} — {item.data.response?.status ?? '?'} ({formatMs(item.data.processingTimeMs)})
										{:else}
											{item.data.eventType}
										{/if}
									</td>
								</tr>
							{/each}
							{#if getTimeline().length === 0}
								<tr><td colspan="3" class="px-6 py-8 text-center text-gray-500">No events found</td></tr>
							{/if}
						</tbody>
					</table>
				</div>

			<!-- Session Logs Tab -->
			{:else if activeTab === 'logs'}
				<div class="overflow-x-auto">
					<table class="w-full">
						<thead class="bg-gray-50">
							<tr>
								<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Uploaded</th>
								<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Firmware</th>
								<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Boot #</th>
								<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Lines</th>
								<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Errors</th>
								<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Crash</th>
							</tr>
						</thead>
						<tbody class="bg-white divide-y divide-gray-200">
							{#each data.logs as log}
								<tr class="hover:bg-gray-50 cursor-pointer" onclick={() => toggleRow(log._id)}>
									<td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{formatDate(log.uploadedAt)}</td>
									<td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">v{log.firmwareVersion ?? '?'}</td>
									<td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{log.bootCount ?? '-'}</td>
									<td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{log.lineCount}</td>
									<td class="px-6 py-4 whitespace-nowrap text-sm {log.errorCount > 0 ? 'text-red-600 font-medium' : 'text-gray-900'}">{log.errorCount}</td>
									<td class="px-6 py-4 whitespace-nowrap">
										{#if log.hasCrash}
											<span class="px-2 py-1 text-xs font-medium bg-red-100 text-red-800 rounded-full">YES</span>
										{:else}
											<span class="text-gray-400">-</span>
										{/if}
									</td>
								</tr>
								{#if expandedRows[log._id]}
									<tr>
										<td colspan="6" class="px-6 py-4 bg-gray-50">
											<div class="text-sm">
												<div class="font-medium text-gray-700 mb-1">Session: <span class="font-mono">{log.sessionId}</span></div>
												<div class="text-gray-600">First: {log.firstLine || '-'}</div>
												<div class="text-gray-600">Last: {log.lastLine || '-'}</div>
											</div>
										</td>
									</tr>
								{/if}
							{/each}
							{#if data.logs.length === 0}
								<tr><td colspan="6" class="px-6 py-8 text-center text-gray-500">No session logs found</td></tr>
							{/if}
						</tbody>
					</table>
				</div>

			<!-- Crashes Tab -->
			{:else if activeTab === 'crashes'}
				<div class="overflow-x-auto">
					<table class="w-full">
						<thead class="bg-gray-50">
							<tr>
								<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Detected</th>
								<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Firmware</th>
								<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Checkpoint</th>
								<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Category</th>
								<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Sequence</th>
							</tr>
						</thead>
						<tbody class="bg-white divide-y divide-gray-200">
							{#each data.crashes as crash}
								<tr class="hover:bg-gray-50 cursor-pointer" onclick={() => toggleRow(crash._id)}>
									<td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{formatDate(crash.detectedAt)}</td>
									<td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">v{crash.firmwareVersion ?? '?'}</td>
									<td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
										<span class="font-mono">CP {crash.lastCheckpoint}</span>
										<span class="text-gray-500 ml-1">({crash.lastCheckpointName})</span>
									</td>
									<td class="px-6 py-4 whitespace-nowrap">
										<span class="px-2 py-1 text-xs font-medium bg-red-100 text-red-800 rounded-full">{crash.crashCategory}</span>
									</td>
									<td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{crash.checkpointSequence.length} steps</td>
								</tr>
								{#if expandedRows[crash._id]}
									<tr>
										<td colspan="5" class="px-6 py-4 bg-gray-50">
											<div class="text-sm">
												<div class="font-medium text-gray-700 mb-2">Checkpoint Sequence:</div>
												<div class="flex flex-wrap gap-1">
													{#each crash.checkpointSequence as cp}
														<span class="px-2 py-1 text-xs font-mono rounded {cp === crash.lastCheckpoint ? 'bg-red-200 text-red-900 font-bold' : 'bg-gray-200 text-gray-700'}">
															{cp} ({getCheckpointName(cp)})
														</span>
													{/each}
												</div>
											</div>
										</td>
									</tr>
								{/if}
							{/each}
							{#if data.crashes.length === 0}
								<tr><td colspan="5" class="px-6 py-8 text-center text-gray-500">No crashes recorded</td></tr>
							{/if}
						</tbody>
					</table>
				</div>

			<!-- Webhook Logs Tab -->
			{:else if activeTab === 'webhooks'}
				<div class="overflow-x-auto">
					<table class="w-full">
						<thead class="bg-gray-50">
							<tr>
								<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Time</th>
								<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Event</th>
								<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
								<th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Duration</th>
							</tr>
						</thead>
						<tbody class="bg-white divide-y divide-gray-200">
							{#each data.webhookLogs as wh}
								<tr class="hover:bg-gray-50 cursor-pointer" onclick={() => toggleRow(wh._id)}>
									<td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{formatDate(wh.timestamp)}</td>
									<td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900 font-mono">{wh.eventName}</td>
									<td class="px-6 py-4 whitespace-nowrap">
										{#if wh.response?.status === 'SUCCESS'}
											<span class="px-2 py-1 text-xs font-medium bg-green-100 text-green-800 rounded-full">SUCCESS</span>
										{:else if wh.response?.status === 'FAILURE' || wh.response?.status === 'ERROR'}
											<span class="px-2 py-1 text-xs font-medium bg-red-100 text-red-800 rounded-full">{wh.response.status}</span>
										{:else}
											<span class="px-2 py-1 text-xs font-medium bg-gray-100 text-gray-800 rounded-full">{wh.response?.status ?? '-'}</span>
										{/if}
									</td>
									<td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{formatMs(wh.processingTimeMs)}</td>
								</tr>
								{#if expandedRows[wh._id]}
									<tr>
										<td colspan="4" class="px-6 py-4 bg-gray-50">
											<div class="grid grid-cols-2 gap-4 text-sm">
												<div>
													<div class="font-medium text-gray-700 mb-1">Request</div>
													<pre class="bg-gray-100 p-3 rounded text-xs overflow-x-auto max-h-48">{JSON.stringify(wh.request?.parsed ?? wh.request?.raw ?? '-', null, 2)}</pre>
												</div>
												<div>
													<div class="font-medium text-gray-700 mb-1">Response</div>
													<pre class="bg-gray-100 p-3 rounded text-xs overflow-x-auto max-h-48">{JSON.stringify(wh.response?.data ?? wh.response?.errorMessage ?? '-', null, 2)}</pre>
												</div>
											</div>
										</td>
									</tr>
								{/if}
							{/each}
							{#if data.webhookLogs.length === 0}
								<tr><td colspan="4" class="px-6 py-8 text-center text-gray-500">No webhook logs found</td></tr>
							{/if}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
	</div>
</div>
