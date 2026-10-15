<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { enhance } from '$app/forms';
	import { TronCard, TronBadge, TronButton } from '$lib/components/ui';
	import { getCheckpointName } from '$lib/checkpoint-codes';

	let { data, form } = $props();

	// Monitor mode (firmware v103 + daily Claude review)
	let monitorBusy = $state(false);
	let showMonitorForm = $state(false);
	let reviewBusy = $state(false);
	function monitorFlagText(m: { flagState: string | null; flag: number | null; flagError: string | null }): { text: string; color: string } {
		switch (m.flagState) {
			case 'synced':
				return m.flag === 1
					? { text: 'Device uploading logs', color: 'var(--color-tron-green)' }
					: { text: 'Device flag clear', color: 'var(--color-tron-text-secondary)' };
			case 'offline': return { text: 'Pending — device offline', color: 'var(--color-tron-text-secondary)' };
			case 'unsupported': return { text: 'Firmware < 103 — flag not pushed', color: 'var(--color-tron-yellow, #fbbf24)' };
			case 'unlinked': return { text: 'No device linked', color: 'var(--color-tron-text-secondary)' };
			case 'error': return { text: m.flagError ?? 'Sync error', color: 'var(--color-tron-red, #ef4444)' };
			default: return { text: 'Not synced yet', color: 'var(--color-tron-text-secondary)' };
		}
	}
	function verdictVariant(s: string | null): 'info' | 'success' | 'warning' | 'error' | 'neutral' {
		switch (s) {
			case 'healthy': return 'success';
			case 'watch': return 'warning';
			case 'suspect': case 'error': return 'error';
			default: return 'neutral';
		}
	}
	let reviews = $derived(data.findings.filter((f: any) => f.kind === 'daily_review'));
	let findingsByReview = $derived(
		data.findings.filter((f: any) => f.kind === 'review_finding').reduce((acc: Record<string, any[]>, f: any) => { (acc[f.reviewId] ??= []).push(f); return acc; }, {})
	);
	let openFindingCount = $derived(data.findings.filter((f: any) => f.kind === 'review_finding' && !f.resolvedAt).length);

	let activeTab = $state('timeline');
	let dateFrom = $state(data.dateRange?.from ?? '');
	let dateTo = $state(data.dateRange?.to ?? '');
	let expandedRows: Record<string, boolean> = $state({});

	// Dump Logs button state
	let dumpLogsLoading = $state(false);
	let dumpLogsMessage = $state('');
	let dumpLogsSuccess = $state<boolean | null>(null);

	async function handleDumpLogs() {
		dumpLogsLoading = true;
		dumpLogsMessage = '';
		dumpLogsSuccess = null;
		try {
			const res = await fetch('/api/device/dump-logs', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ particleDeviceId: data.particleDeviceId })
			});
			const result = await res.json();
			dumpLogsMessage = result.message || result.error || 'Unknown response';
			dumpLogsSuccess = result.success;
			if (result.success) {
				dumpLogsMessage = 'Log upload triggered — refreshing in 8s...';
				setTimeout(() => location.reload(), 8000);
			}
		} catch (err) {
			dumpLogsMessage = 'Failed to contact device';
			dumpLogsSuccess = false;
		} finally {
			dumpLogsLoading = false;
		}
	}

	// Source visibility toggles for timeline
	let showFirmware = $state(true);
	let showWebhooks = $state(true);
	let showCrashes = $state(true);
	let showEvents = $state(true);
	let searchQuery = $state('');

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

	function formatTime(date: string): string {
		return new Date(date).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
	}

	function formatMs(ms: number | null): string {
		if (ms === null || ms === undefined) return '—';
		return `${ms}ms`;
	}

	function isErrorLine(message: string): boolean {
		return /ERROR|WARN|OVERHEAT|INTERRUPTED|THERMISTOR DISCONNECT/i.test(message);
	}

	function isCheckpointBlock(message: string): boolean {
		return /^===\s*(PREV SESSION|END) CHECKPOINTS/i.test(message) || /^\s*CP\[/.test(message);
	}

	function isMetadataLine(message: string): boolean {
		const m = message.trim();
		return /UPLOAD METADATA/i.test(m)
			|| /^={4,}/.test(m)
			|| /^Boot #\d+\s*\|/i.test(m)
			|| /^Firmware:\s*v\d+\s*\|/i.test(m);
	}

	function truncate(str: string | null, len: number): string {
		if (!str) return '—';
		return str.length > len ? str.slice(0, len) + '...' : str;
	}

	// Filter timeline entries based on source toggles and search
	function filteredTimeline() {
		return data.timeline.filter((entry: any) => {
			// Hide metadata lines (UPLOAD METADATA / ==== separator lines)
			if (entry.source === 'firmware' && !entry.data.isSessionHeader && entry.data.message && isMetadataLine(entry.data.message)) return false;

			// Source filter
			if (entry.source === 'firmware' && !showFirmware) return false;
			if (entry.source === 'webhook' && !showWebhooks) return false;
			if (entry.source === 'crash' && !showCrashes) return false;
			if (entry.source === 'event' && !showEvents) return false;

			// Search filter (firmware messages only)
			if (searchQuery && entry.source === 'firmware') {
				return entry.data.message?.toLowerCase().includes(searchQuery.toLowerCase());
			}
			if (searchQuery && entry.source !== 'firmware') {
				return true;
			}

			return true;
		});
	}

	// Detect session boundaries for visual separators
	let lastSessionId = '';
	function isNewSession(entry: any): boolean {
		if (entry.source !== 'firmware') return false;
		if (!entry.data.sessionId) return false;
		if (entry.data.sessionId !== lastSessionId) {
			lastSessionId = entry.data.sessionId;
			return true;
		}
		return false;
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
		<div class="flex items-center gap-3">
			{#if data.particleDeviceId}
				<button
					onclick={handleDumpLogs}
					disabled={dumpLogsLoading}
					class="px-4 py-2 text-sm font-medium rounded transition-colors"
					style="background: var(--color-tron-cyan); color: var(--color-tron-bg, #000); opacity: {dumpLogsLoading ? '0.5' : '1'}; cursor: {dumpLogsLoading ? 'not-allowed' : 'pointer'};"
				>
					{dumpLogsLoading ? 'Requesting...' : 'Dump Logs'}
				</button>
				{#if dumpLogsMessage}
					<span class="text-xs" style="color: {dumpLogsSuccess ? 'var(--color-tron-green)' : dumpLogsSuccess === false ? 'var(--color-tron-red, #ef4444)' : 'var(--color-tron-text-secondary)'};">
						{dumpLogsMessage}
					</span>
				{/if}
			{/if}
			<a href="/spu/monitor" class="tron-text-muted hover:underline text-sm" style="color: var(--color-tron-cyan);">Monitor fleet</a>
			<a href="/spu/{data.spu.id}" class="tron-text-muted hover:underline text-sm" style="color: var(--color-tron-cyan);">
				← Back to SPU
			</a>
		</div>
	</div>

	{#if data.particleDeviceId}
		<!-- Monitor mode -->
		<TronCard>
			<div class="flex flex-wrap items-center gap-3">
				<span class="tron-text-muted text-xs font-medium uppercase">Monitor mode:</span>
				<TronBadge variant={data.monitoring.enabled ? (data.monitoring.role === 'control' ? 'info' : 'warning') : 'neutral'}>
					{data.monitoring.enabled ? `ON — ${data.monitoring.role}` : 'OFF'}
				</TronBadge>
				{#if data.monitoring.enabled}
					<span class="text-xs" style="color: {monitorFlagText(data.monitoring).color};">{monitorFlagText(data.monitoring).text}</span>
					{#if data.monitoring.reason}<span class="tron-text-muted text-xs">— {data.monitoring.reason}</span>{/if}
					{#if data.monitoring.lastReviewStatus}
						<span class="tron-text-muted text-xs">Last review:</span>
						<TronBadge variant={verdictVariant(data.monitoring.lastReviewStatus)}>{data.monitoring.lastReviewStatus}</TronBadge>
					{/if}
				{/if}
				<div class="ml-auto flex items-center gap-2">
					{#if data.monitoring.enabled}
						<form method="POST" action="?/reviewNow" use:enhance={() => { reviewBusy = true; return async ({ update }) => { reviewBusy = false; await update(); }; }}>
							<TronButton type="submit" disabled={reviewBusy} style="min-height: 38px;">{reviewBusy ? 'Reviewing…' : 'Review now'}</TronButton>
						</form>
						<form method="POST" action="?/resyncMonitor" use:enhance={() => { monitorBusy = true; return async ({ update }) => { monitorBusy = false; await update(); }; }}>
							<TronButton type="submit" disabled={monitorBusy} style="min-height: 38px;">Resync flag</TronButton>
						</form>
						<form method="POST" action="?/setMonitor" use:enhance={() => { monitorBusy = true; return async ({ update }) => { monitorBusy = false; await update(); }; }}>
							<input type="hidden" name="enabled" value="0" />
							<TronButton type="submit" disabled={monitorBusy} style="min-height: 38px;">Turn off</TronButton>
						</form>
					{:else if !showMonitorForm}
						<TronButton type="button" variant="primary" onclick={() => (showMonitorForm = true)} style="min-height: 38px;">Turn on</TronButton>
					{/if}
				</div>
			</div>
			{#if showMonitorForm && !data.monitoring.enabled}
				<form method="POST" action="?/setMonitor" use:enhance={() => { monitorBusy = true; return async ({ result, update }) => { monitorBusy = false; if (result.type === 'success') showMonitorForm = false; await update(); }; }} class="mt-3 flex flex-wrap items-center gap-3">
					<input type="hidden" name="enabled" value="1" />
					<select name="role" class="tron-input" style="min-height: 38px;">
						<option value="suspect">Suspect (reviewed daily)</option>
						<option value="control">Control (reference numbers for the suspects)</option>
					</select>
					<input name="reason" type="text" class="tron-input flex-1" placeholder="Why is this unit being watched?" maxlength="500" style="min-height: 38px;" />
					<TronButton type="submit" variant="primary" disabled={monitorBusy} style="min-height: 38px;">{monitorBusy ? 'Saving…' : 'Enable'}</TronButton>
					<TronButton type="button" onclick={() => (showMonitorForm = false)} style="min-height: 38px;">Cancel</TronButton>
				</form>
			{/if}
			{#if form?.error}
				<p class="text-xs mt-2" style="color: var(--color-tron-red, #ef4444);">{form.error}</p>
			{:else if form?.review}
				<p class="text-xs mt-2"><span class="font-medium">Review:</span> {form.review.status} — {form.review.summary} ({form.review.findingCount} finding(s){form.review.costUsd != null ? `, $${form.review.costUsd}` : ''})</p>
			{:else if form?.flag}
				<p class="tron-text-muted text-xs mt-2">Flag sync: {form.flag.state}{form.flag.state === 'error' ? ` — ${form.flag.message}` : ''}</p>
			{/if}
			<p class="tron-text-muted text-xs mt-2">While on, firmware v103 uploads the session log after every test, screen, error and boot (no 60 s polling). The 07:30 UTC review compares this unit with the control units and files findings in the Findings tab.</p>
		</TronCard>
	{/if}

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
					<div class="text-lg font-bold tron-text-primary">{data.stats.lastUpload ? formatDate(data.stats.lastUpload) : '—'}</div>
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
				<span class="tron-text-muted text-xs ml-2">Showing {data.dateRange?.from} to {data.dateRange?.to}</span>
			</div>
		</TronCard>

		<!-- Tabs -->
		<div class="flex gap-2 border-b" style="border-color: var(--color-tron-border);">
			{#each [
				{ id: 'timeline', label: 'Timeline', count: data.timeline.length },
				{ id: 'logs', label: 'Session Logs', count: data.logs.length },
				{ id: 'crashes', label: 'Crashes', count: data.crashes.length },
				{ id: 'webhooks', label: 'Webhook Logs', count: data.webhookLogs.length },
				{ id: 'events', label: 'Events', count: data.events.length },
				{ id: 'findings', label: 'Findings', count: openFindingCount }
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

		<!-- ==================== TIMELINE TAB ==================== -->
		{#if activeTab === 'timeline'}
			<!-- Timeline Controls -->
			<TronCard>
				<div class="flex flex-wrap items-center gap-4">
					<span class="tron-text-muted text-xs font-medium uppercase">Sources:</span>
					<label class="flex items-center gap-1.5 text-xs cursor-pointer">
						<input type="checkbox" bind:checked={showFirmware} class="accent-[var(--color-tron-cyan)]" />
						<span style="color: var(--color-tron-cyan);">Firmware</span>
					</label>
					<label class="flex items-center gap-1.5 text-xs cursor-pointer">
						<input type="checkbox" bind:checked={showWebhooks} class="accent-[var(--color-tron-green)]" />
						<span style="color: var(--color-tron-green);">Webhooks</span>
					</label>
					<label class="flex items-center gap-1.5 text-xs cursor-pointer">
						<input type="checkbox" bind:checked={showCrashes} class="accent-[var(--color-tron-red,#ef4444)]" />
						<span style="color: var(--color-tron-red, #ef4444);">Crashes</span>
					</label>
					<label class="flex items-center gap-1.5 text-xs cursor-pointer">
						<input type="checkbox" bind:checked={showEvents} class="accent-[var(--color-tron-text-secondary)]" />
						<span class="tron-text-muted">Events</span>
					</label>
					<div class="ml-auto">
						<input type="text" bind:value={searchQuery} placeholder="Search firmware logs..." class="tron-input text-xs" style="min-height: 30px; width: 200px;" />
					</div>
				</div>
			</TronCard>

			<!-- Timeline Entries -->
			<TronCard>
				{#if filteredTimeline().length === 0}
					<p class="tron-text-muted py-8 text-center text-sm">No timeline entries for this date range.</p>
				{:else}
					<div class="max-h-[80vh] overflow-y-auto font-mono text-xs space-y-0">
						{#each filteredTimeline() as entry, i (i)}
							<!-- Session boundary separator -->
							{#if entry.data.isSessionHeader}
								<div class="py-2 px-3 mt-4 first:mt-0 rounded" style="background: rgba(0,255,255,0.05); border: 1px solid var(--color-tron-border);">
									<div class="flex items-center justify-between">
										<span class="font-bold" style="color: var(--color-tron-cyan);">{entry.data.message.split('\n')[0]}</span>
										<span class="tron-text-muted text-[10px]">{formatDate(entry.data.uploadedAt)}</span>
									</div>
									{#if entry.data.message.includes('\n')}
										<div class="tron-text-muted mt-0.5">{entry.data.message.split('\n')[1]}</div>
									{/if}
									{#if entry.data.lineCount != null}
										<div class="tron-text-muted text-[10px] mt-1">{entry.data.lineCount} log lines in this upload</div>
									{/if}
								</div>
							{:else if entry.source === 'firmware'}
								<!-- Firmware log line -->
								<div
									class="flex gap-3 py-0.5 px-3 hover:bg-[rgba(0,255,255,0.03)]"
									style="{isErrorLine(entry.data.message) ? 'background: rgba(239,68,68,0.08);' : ''} {isCheckpointBlock(entry.data.message) ? 'opacity: 0.7;' : ''}"
								>
									<span class="shrink-0 w-16 text-right tron-text-muted">{formatTime(entry.timestamp)}</span>
									<span class="shrink-0 w-20 text-right tron-text-muted">{entry.data.ms != null ? `${(entry.data.ms / 1000).toFixed(1)}s` : ''}</span>
									<span class="shrink-0 px-1.5 py-0 rounded text-[10px] font-bold" style="color: var(--color-tron-cyan); background: rgba(0,255,255,0.1);">FW</span>
									<span style="color: {isErrorLine(entry.data.message) ? 'var(--color-tron-red, #ef4444)' : 'var(--color-tron-text-primary)'}; {isErrorLine(entry.data.message) ? 'font-weight: bold;' : ''}">{entry.data.message}</span>
								</div>

							{:else if entry.source === 'webhook'}
								<!-- Webhook round-trip -->
								<div
									class="flex gap-3 py-1 px-3 cursor-pointer hover:bg-[rgba(0,255,100,0.05)]"
									style="border-left: 2px solid var(--color-tron-green);"
									onclick={() => toggleRow(entry.data._id)}
								>
									<span class="shrink-0 w-16 text-right tron-text-muted">{formatTime(entry.timestamp)}</span>
									<span class="shrink-0 w-20"></span>
									<span class="shrink-0 px-1.5 py-0 rounded text-[10px] font-bold" style="color: var(--color-tron-green); background: rgba(0,255,100,0.1);">WH</span>
									<span>
										<span style="color: var(--color-tron-text-primary);">{entry.data.eventName}</span>
										<span class="tron-text-muted"> → </span>
										<span style="color: {entry.data.status === 'SUCCESS' ? 'var(--color-tron-green)' : entry.data.status === 'FAILURE' || entry.data.status === 'ERROR' ? 'var(--color-tron-red, #ef4444)' : 'var(--color-tron-text-primary)'}; font-weight: bold;">
											{entry.data.status ?? '?'}
										</span>
										{#if entry.data.processingTimeMs != null}
											<span class="tron-text-muted"> ({entry.data.processingTimeMs}ms)</span>
										{/if}
									</span>
								</div>
								{#if expandedRows[entry.data._id]}
									<div class="ml-[9.5rem] mb-2 p-3 rounded grid grid-cols-1 md:grid-cols-2 gap-3" style="background: var(--color-tron-bg-secondary, rgba(0,0,0,0.3)); border: 1px solid var(--color-tron-border);">
										<div>
											<div class="tron-text-muted text-[10px] font-bold mb-1">REQUEST</div>
											<pre class="text-[10px] overflow-x-auto max-h-32" style="color: var(--color-tron-text-primary);">{JSON.stringify(entry.data.request?.parsed ?? entry.data.request?.raw ?? null, null, 2)}</pre>
										</div>
										<div>
											<div class="tron-text-muted text-[10px] font-bold mb-1">RESPONSE</div>
											<pre class="text-[10px] overflow-x-auto max-h-32" style="color: var(--color-tron-text-primary);">{JSON.stringify(entry.data.response?.data ?? entry.data.response?.errorMessage ?? null, null, 2)}</pre>
										</div>
									</div>
								{/if}

							{:else if entry.source === 'crash'}
								<!-- Crash report -->
								<div
									class="flex gap-3 py-1.5 px-3 cursor-pointer rounded my-1"
									style="background: rgba(239,68,68,0.1); border: 1px solid var(--color-tron-red, #ef4444);"
									onclick={() => toggleRow(entry.data._id)}
								>
									<span class="shrink-0 w-16 text-right tron-text-muted">{formatTime(entry.timestamp)}</span>
									<span class="shrink-0 w-20"></span>
									<span class="shrink-0 px-1.5 py-0 rounded text-[10px] font-bold" style="color: var(--color-tron-red, #ef4444); background: rgba(239,68,68,0.2);">CRASH</span>
									<span style="color: var(--color-tron-red, #ef4444); font-weight: bold;">
										INTERRUPTED at {entry.data.lastCheckpointName} (code {entry.data.lastCheckpoint}) — Category: {entry.data.crashCategory}
									</span>
								</div>
								{#if expandedRows[entry.data._id]}
									<div class="ml-[9.5rem] mb-2 p-3 rounded" style="background: var(--color-tron-bg-secondary, rgba(0,0,0,0.3)); border: 1px solid var(--color-tron-border);">
										<div class="tron-text-muted text-[10px] font-bold mb-2">CHECKPOINT TRAIL</div>
										<div class="flex flex-wrap gap-1">
											{#each entry.data.checkpointSequence as cp}
												<span
													class="px-2 py-0.5 text-[10px] rounded"
													style="background: {cp === entry.data.lastCheckpoint ? 'rgba(239,68,68,0.3)' : 'rgba(0,255,255,0.1)'}; color: {cp === entry.data.lastCheckpoint ? 'var(--color-tron-red, #ef4444)' : 'var(--color-tron-cyan)'}; {cp === entry.data.lastCheckpoint ? 'font-weight: bold; border: 1px solid var(--color-tron-red, #ef4444);' : 'border: 1px solid var(--color-tron-border);'}"
												>
													{cp} ({getCheckpointName(cp)}){cp === entry.data.lastCheckpoint ? ' ⚠' : ''}
												</span>
											{/each}
										</div>
									</div>
								{/if}

							{:else if entry.source === 'event'}
								<!-- Raw event -->
								<div class="flex gap-3 py-0.5 px-3 hover:bg-[rgba(128,128,128,0.05)]" style="opacity: 0.6;">
									<span class="shrink-0 w-16 text-right tron-text-muted">{formatTime(entry.timestamp)}</span>
									<span class="shrink-0 w-20"></span>
									<span class="shrink-0 px-1.5 py-0 rounded text-[10px] font-bold tron-text-muted" style="background: rgba(128,128,128,0.1);">EVT</span>
									<span class="tron-text-muted">{entry.data.eventType} published</span>
								</div>
							{/if}
						{/each}
					</div>
				{/if}
			</TronCard>

		<!-- ==================== SESSION LOGS TAB ==================== -->
		{:else if activeTab === 'logs'}
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
																{#if !isMetadataLine(line.message)}
																	<div class="py-0.5 flex gap-3" style="color: {isErrorLine(line.message) ? 'var(--color-tron-red, #ef4444)' : 'var(--color-tron-text-primary)'}; {isErrorLine(line.message) ? 'font-weight: bold;' : ''}">
																		<span class="tron-text-muted shrink-0 w-16 text-right">{line.ms != null ? `${(line.ms / 1000).toFixed(1)}s` : ''}</span>
																		<span>{line.message}</span>
																	</div>
																{/if}
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

		<!-- ==================== CRASHES TAB ==================== -->
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

		<!-- ==================== WEBHOOK LOGS TAB ==================== -->
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

		<!-- ==================== EVENTS TAB ==================== -->
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

		<!-- ==================== FINDINGS TAB ==================== -->
		{:else if activeTab === 'findings'}
			<TronCard>
				{#if reviews.length === 0}
					<p class="tron-text-muted py-6 text-center text-sm">No reviews yet. Turn monitor mode on and press "Review now", or wait for the 07:30 UTC cron.</p>
				{:else}
					<div class="space-y-4">
						{#each reviews as rv}
							<div class="rounded border p-4" style="border-color: var(--color-tron-border);">
								<div class="flex flex-wrap items-center gap-2">
									<span class="font-mono text-sm">{rv.dayKey}</span>
									<TronBadge variant={verdictVariant(rv.status)}>{rv.status}</TronBadge>
									<span class="tron-text-muted text-xs">{rv.model ?? ''}{rv.costUsd != null ? ` · $${rv.costUsd}` : ''}{rv.inputCounts ? ` · ${rv.inputCounts.logLines ?? 0} log lines, ${rv.inputCounts.records ?? 0} runs, ${rv.inputCounts.webhooks ?? 0} hooks, ${rv.inputCounts.crashes ?? 0} crashes` : ''}</span>
								</div>
								<p class="text-sm mt-2">{rv.summary}</p>
								{#if findingsByReview[rv._id]?.length}
									<div class="mt-3 space-y-2">
										{#each findingsByReview[rv._id] as f}
											<div class="rounded border p-3" style="border-color: var(--color-tron-border); opacity: {f.resolvedAt ? 0.6 : 1};">
												<div class="flex flex-wrap items-center gap-2">
													<TronBadge variant={f.severity === 'error' ? 'error' : f.severity === 'warning' ? 'warning' : 'info'}>{f.severity}</TronBadge>
													<span class="font-mono text-xs">{f.category}</span>
													<span class="font-medium">{f.title}</span>
													<span class="tron-text-muted text-xs">confidence {Math.round((f.confidence ?? 0) * 100)}%</span>
													{#if f.resolvedAt}<TronBadge variant="neutral">resolved</TronBadge>{:else if f.acknowledgedAt}<TronBadge variant="neutral">acknowledged</TronBadge>{/if}
													<div class="ml-auto flex gap-2">
														{#if !f.acknowledgedAt}
															<form method="POST" action="?/ackFinding" use:enhance><input type="hidden" name="findingId" value={f._id} /><TronButton type="submit" style="min-height: 32px;">Acknowledge</TronButton></form>
														{/if}
														{#if !f.resolvedAt}
															<form method="POST" action="?/ackFinding" use:enhance><input type="hidden" name="findingId" value={f._id} /><input type="hidden" name="resolve" value="1" /><TronButton type="submit" style="min-height: 32px;">Resolve</TronButton></form>
														{/if}
													</div>
												</div>
												<p class="text-sm mt-1">{f.detail}</p>
												<p class="text-xs mt-1" style="color: var(--color-tron-green);">→ {f.recommendation}</p>
												{#if f.evidence?.length}
													<ul class="mt-2 space-y-1">
														{#each f.evidence as e}
															<li class="font-mono text-xs tron-text-muted">[{e.source}{e.at ? ` ${formatDate(e.at)}` : ''}] {e.text}</li>
														{/each}
													</ul>
												{/if}
											</div>
										{/each}
									</div>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</TronCard>
		{/if}
	{/if}
</div>
