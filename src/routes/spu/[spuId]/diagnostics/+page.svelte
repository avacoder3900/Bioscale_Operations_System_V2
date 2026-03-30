<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { TronCard, TronBadge, TronButton } from '$lib/components/ui';
	import { getCheckpointName } from '$lib/checkpoint-codes';

	let { data } = $props();

	let activeTab = $state('logs');
	let dateFrom = $state($page.url.searchParams.get('from') ?? '');
	let dateTo = $state($page.url.searchParams.get('to') ?? '');
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

	function formatDate(date: string | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleString();
	}

	function formatMs(ms: number | null): string {
		if (ms === null || ms === undefined) return '—';
		return `${ms}ms`;
	}

	function isErrorLine(message: string): boolean {
		return /ERROR|WARN|OVERHEAT|INTERRUPTED/i.test(message);
	}

	function truncate(str: string | null, len: number): string {
		if (!str) return '—';
		return str.length > len ? str.slice(0, len) + '...' : str;
	}
</script>

<svelte:head>
	<title>Diagnostics — {data.spu.udi}</title>
</svelte:head>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h2 class="tron-text-primary font-mono text-2xl font-bold">Diagnostics</h2>
			<p class="tron-text-muted">{data.spu.udi}</p>
			{#if data.particleDeviceId}
				<p class="tron-text-muted font-mono text-xs mt-1">{data.particleDeviceId}</p>
			{/if}
		</div>
		<a href="/spu/{data.spu.id}" class="tron-text-muted hover:underline text-sm" style="color: var(--color-tron-cyan);">
			← Back to SPU
		</a>
	</div>

	{#if !data.particleDeviceId}
		<TronCard>
			<div class="py-8 text-center">
				<p class="tron-text-muted text-lg">No Particle device linked to this SPU.</p>
				<p class="tron-text-muted text-sm mt-2">Link a device on the SPU detail page to see diagnostics data.</p>
			</div>
		</TronCard>
	{:else}
		<!-- Stats Cards -->
		<div class="grid grid-cols-2 gap-4 md:grid-cols-4">
			<TronCard>
				<div class="text-center">
					<div class="text-2xl font-bold" style="color: var(--color-tron-cyan);">{data.stats.totalLogs}</div>
					<div class="tron-text-muted text-sm">Session Logs</div>
				</div>
			</TronCard>
			<TronCard>
				<div class="text-center">
					<div class="text-2xl font-bold" style="color: {data.stats.totalCrashes > 0 ? 'var(--color-tron-red, #ef4444)' : 'var(--color-tron-green)'};">
						{data.stats.totalCrashes}
					</div>
					<div class="tron-text-muted text-sm">Crashes</div>
				</div>
			</TronCard>
			<TronCard>
				<div class="text-center">
					<div class="text-2xl font-bold tron-text-primary">{data.stats.lastUpload ? formatDate(data.stats.lastUpload) : '—'}</div>
					<div class="tron-text-muted text-sm">Last Upload</div>
				</div>
			</TronCard>
			<TronCard>
				<div class="text-center">
					<div class="text-2xl font-bold" style="color: var(--color-tron-orange, #f97316);">
						{data.stats.avgWebhookTimeMs !== null ? `${data.stats.avgWebhookTimeMs}ms` : '—'}
					</div>
					<div class="tron-text-muted text-sm">Avg Webhook Time</div>
				</div>
			</TronCard>
		</div>

		<!-- Date Filter -->
		<TronCard>
			<div class="flex flex-wrap items-end gap-4">
				<div>
					<label class="tron-text-muted text-xs block mb-1">From</label>
					<input type="date" bind:value={dateFrom} class="tron-input text-sm" style="min-height: 38px;" />
				</div>
				<div>
					<label class="tron-text-muted text-xs block mb-1">To</label>
					<input type="date" bind:value={dateTo} class="tron-input text-sm" style="min-height: 38px;" />
				</div>
				<TronButton variant="primary" onclick={applyFilters} style="min-height: 38px;">Apply</TronButton>
				<TronButton onclick={clearFilters} style="min-height: 38px;">Clear</TronButton>
			</div>
		</TronCard>

		<!-- Tabs -->
		<div class="flex gap-2 border-b" style="border-color: var(--color-tron-border);">
			{#each [
				{ id: 'logs', label: 'Session Logs', count: data.logs.length },
				{ id: 'crashes', label: 'Crashes', count: data.crashes.length },
				{ id: 'webhooks', label: 'Webhook Logs', count: data.webhookLogs.length },
				{ id: 'events', label: 'Events', count: data.events.length }
			] as tab}
				<button
					onclick={() => activeTab = tab.id}
					class="px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors"
					style="border-color: {activeTab === tab.id ? 'var(--color-tron-cyan)' : 'transparent'}; color: {activeTab === tab.id ? 'var(--color-tron-cyan)' : 'var(--color-tron-text-secondary)'};"
				>
					{tab.label}
					{#if tab.count > 0}
						<span class="ml-1 rounded-full px-1.5 py-0.5 text-xs" style="background: {tab.id === 'crashes' && tab.count > 0 ? 'rgba(239,68,68,0.2)' : 'rgba(0,255,255,0.1)'}; color: {tab.id === 'crashes' && tab.count > 0 ? 'var(--color-tron-red, #ef4444)' : 'var(--color-tron-cyan)'};">
							{tab.count}
						</span>
					{/if}
				</button>
			{/each}
		</div>

		<!-- Session Logs Tab -->
		{#if activeTab === 'logs'}
			<TronCard>
				{#if data.logs.length === 0}
					<p class="tron-text-muted py-6 text-center text-sm">No session logs found.</p>
				{:else}
					<div class="overflow-x-auto">
						<table class="tron-table">
							<thead>
								<tr>
									<th>Upload Date</th>
									<th>Firmware</th>
									<th>Boot #</th>
									<th>Lines</th>
									<th>Errors</th>
									<th>Crash</th>
								</tr>
							</thead>
							<tbody>
								{#each data.logs as log}
									<tr class="cursor-pointer" onclick={() => toggleRow(log._id)}>
										<td>{formatDate(log.uploadedAt)}</td>
										<td class="font-mono">v{log.firmwareVersion ?? '?'}</td>
										<td class="font-mono">{log.bootCount ?? '—'}</td>
										<td>{log.lineCount}</td>
										<td style="color: {log.errorCount > 0 ? 'var(--color-tron-red, #ef4444)' : 'inherit'}; font-weight: {log.errorCount > 0 ? 'bold' : 'normal'};">
											{log.errorCount}
										</td>
										<td>
											{#if log.hasCrash}
												<TronBadge variant="error">CRASH</TronBadge>
											{:else}
												<span class="tron-text-muted">—</span>
											{/if}
										</td>
									</tr>
									{#if expandedRows[log._id]}
										<tr>
											<td colspan="6" class="p-0">
												<div class="p-4" style="background: var(--color-tron-bg-secondary, rgba(0,0,0,0.3));">
													<div class="tron-text-muted text-xs mb-2">
														Session: <span class="font-mono">{log.sessionId}</span>
													</div>
													<div class="max-h-80 overflow-y-auto rounded border p-3 font-mono text-xs" style="border-color: var(--color-tron-border); background: var(--color-tron-bg);">
														{#if log.logLines && log.logLines.length > 0}
															{#each log.logLines as line}
																<div class="py-0.5 flex gap-3 {isErrorLine(line.message) ? '' : ''}" style="color: {isErrorLine(line.message) ? 'var(--color-tron-red, #ef4444)' : 'var(--color-tron-text-primary)'}; {isErrorLine(line.message) ? 'font-weight: bold;' : ''}">
																	<span class="tron-text-muted shrink-0 w-16 text-right">{line.ms != null ? `${(line.ms / 1000).toFixed(1)}s` : ''}</span>
																	<span>{line.message}</span>
																</div>
															{/each}
														{:else}
															<div class="tron-text-muted">
																First: {log.firstLine || '—'}<br/>
																Last: {log.lastLine || '—'}
															</div>
														{/if}
													</div>
												</div>
											</td>
										</tr>
									{/if}
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</TronCard>

		<!-- Crashes Tab -->
		{:else if activeTab === 'crashes'}
			<TronCard>
				{#if data.crashes.length === 0}
					<p class="tron-text-muted py-6 text-center text-sm">No crashes recorded.</p>
				{:else}
					<div class="overflow-x-auto">
						<table class="tron-table">
							<thead>
								<tr>
									<th>Detected</th>
									<th>Firmware</th>
									<th>Checkpoint</th>
									<th>Category</th>
									<th>Sequence</th>
								</tr>
							</thead>
							<tbody>
								{#each data.crashes as crash}
									<tr class="cursor-pointer" onclick={() => toggleRow(crash._id)}>
										<td>{formatDate(crash.detectedAt)}</td>
										<td class="font-mono">v{crash.firmwareVersion ?? '?'}</td>
										<td>
											<span class="font-mono">CP {crash.lastCheckpoint}</span>
											<span class="tron-text-muted ml-1 text-xs">({crash.lastCheckpointName})</span>
										</td>
										<td>
											<TronBadge variant="error">{crash.crashCategory}</TronBadge>
										</td>
										<td class="tron-text-muted">{crash.checkpointSequence?.length ?? 0} steps</td>
									</tr>
									{#if expandedRows[crash._id]}
										<tr>
											<td colspan="5" class="p-0">
												<div class="p-4" style="background: var(--color-tron-bg-secondary, rgba(0,0,0,0.3));">
													<div class="tron-text-muted text-xs font-medium mb-2">Checkpoint Sequence:</div>
													<div class="flex flex-wrap gap-1">
														{#each crash.checkpointSequence as cp}
															<span
																class="px-2 py-1 text-xs font-mono rounded"
																style="background: {cp === crash.lastCheckpoint ? 'rgba(239,68,68,0.3)' : 'rgba(0,255,255,0.1)'}; color: {cp === crash.lastCheckpoint ? 'var(--color-tron-red, #ef4444)' : 'var(--color-tron-cyan)'}; {cp === crash.lastCheckpoint ? 'font-weight: bold; border: 1px solid var(--color-tron-red, #ef4444);' : 'border: 1px solid var(--color-tron-border);'}"
															>
																{cp} ({getCheckpointName(cp)})
															</span>
														{/each}
													</div>
													{#if crash.sessionLogId}
														<div class="tron-text-muted text-xs mt-3">
															Session Log ID: <span class="font-mono">{crash.sessionLogId}</span>
														</div>
													{/if}
												</div>
											</td>
										</tr>
									{/if}
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</TronCard>

		<!-- Webhook Logs Tab -->
		{:else if activeTab === 'webhooks'}
			<TronCard>
				{#if data.webhookLogs.length === 0}
					<p class="tron-text-muted py-6 text-center text-sm">No webhook logs found.</p>
				{:else}
					<div class="overflow-x-auto">
						<table class="tron-table">
							<thead>
								<tr>
									<th>Timestamp</th>
									<th>Event</th>
									<th>Status</th>
									<th>Duration</th>
								</tr>
							</thead>
							<tbody>
								{#each data.webhookLogs as wh}
									<tr class="cursor-pointer" onclick={() => toggleRow(wh._id)}>
										<td>{formatDate(wh.timestamp)}</td>
										<td class="font-mono">{wh.eventName}</td>
										<td>
											{#if wh.response?.status === 'SUCCESS'}
												<TronBadge variant="success">SUCCESS</TronBadge>
											{:else if wh.response?.status === 'FAILURE' || wh.response?.status === 'ERROR'}
												<TronBadge variant="error">{wh.response.status}</TronBadge>
											{:else if wh.response?.status === 'INVALID'}
												<TronBadge variant="warning">{wh.response.status}</TronBadge>
											{:else}
												<TronBadge variant="neutral">{wh.response?.status ?? '—'}</TronBadge>
											{/if}
										</td>
										<td class="font-mono">{formatMs(wh.processingTimeMs)}</td>
									</tr>
									{#if expandedRows[wh._id]}
										<tr>
											<td colspan="4" class="p-0">
												<div class="p-4 grid grid-cols-1 md:grid-cols-2 gap-4" style="background: var(--color-tron-bg-secondary, rgba(0,0,0,0.3));">
													<div>
														<div class="tron-text-muted text-xs font-medium mb-1">Request</div>
														<pre class="rounded border p-3 text-xs font-mono overflow-x-auto max-h-48" style="border-color: var(--color-tron-border); background: var(--color-tron-bg); color: var(--color-tron-text-primary);">{JSON.stringify(wh.request?.parsed ?? wh.request?.raw ?? null, null, 2)}</pre>
													</div>
													<div>
														<div class="tron-text-muted text-xs font-medium mb-1">Response</div>
														<pre class="rounded border p-3 text-xs font-mono overflow-x-auto max-h-48" style="border-color: var(--color-tron-border); background: var(--color-tron-bg); color: var(--color-tron-text-primary);">{JSON.stringify(wh.response?.data ?? wh.response?.errorMessage ?? null, null, 2)}</pre>
													</div>
												</div>
											</td>
										</tr>
									{/if}
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</TronCard>

		<!-- Events Tab -->
		{:else if activeTab === 'events'}
			<TronCard>
				{#if data.events.length === 0}
					<p class="tron-text-muted py-6 text-center text-sm">No events found.</p>
				{:else}
					<div class="overflow-x-auto">
						<table class="tron-table">
							<thead>
								<tr>
									<th>Timestamp</th>
									<th>Event Type</th>
									<th>Data</th>
								</tr>
							</thead>
							<tbody>
								{#each data.events as ev}
									<tr>
										<td>{formatDate(ev.createdAt)}</td>
										<td class="font-mono">{ev.eventType}</td>
										<td class="tron-text-muted text-xs font-mono">{truncate(typeof ev.eventData === 'string' ? ev.eventData : JSON.stringify(ev.eventData), 100)}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</TronCard>
		{/if}
	{/if}
</div>
