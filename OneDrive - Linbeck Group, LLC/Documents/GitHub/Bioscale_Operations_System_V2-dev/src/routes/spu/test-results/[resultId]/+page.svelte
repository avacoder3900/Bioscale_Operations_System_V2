<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	let activeTab = $state<'overview' | 'readings' | 'chart'>('overview');
	let showStatusModal = $state(false);
	let statusValue = $state(data.result.status);
	let statusNotes = $state('');

	// Chart channel toggles
	let channels = $state({
		f1: true,
		f2: true,
		f3: true,
		f4: true,
		f5: false,
		f6: false,
		f7: false,
		f8: false,
		clear: false,
		nir: false
	});

	const channelConfig: Record<string, { label: string; color: string; wavelength: string }> = {
		f1: { label: 'F1', color: '#8b5cf6', wavelength: '415nm' },
		f2: { label: 'F2', color: '#3b82f6', wavelength: '445nm' },
		f3: { label: 'F3', color: '#00ffff', wavelength: '480nm' },
		f4: { label: 'F4', color: '#22c55e', wavelength: '515nm' },
		f5: { label: 'F5', color: '#eab308', wavelength: '555nm' },
		f6: { label: 'F6', color: '#f97316', wavelength: '590nm' },
		f7: { label: 'F7', color: '#ef4444', wavelength: '630nm' },
		f8: { label: 'F8', color: '#991b1b', wavelength: '680nm' },
		clear: { label: 'Clear', color: '#9ca3af', wavelength: 'Clear' },
		nir: { label: 'NIR', color: '#7f1d1d', wavelength: 'NIR' }
	};

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

	// Chart SVG helpers
	let chartReadings = $derived(data.readings);

	function getChartData(channelKey: string) {
		return chartReadings.map((r) => {
			const fieldMap: Record<string, number | null> = {
				f1: r.f1,
				f2: r.f2,
				f3: r.f3,
				f4: r.f4,
				f5: r.f5,
				f6: r.f6,
				f7: r.f7,
				f8: r.f8,
				clear: r.clearChannel,
				nir: r.nirChannel
			};
			return { x: r.readingNumber, y: fieldMap[channelKey] ?? 0 };
		});
	}

	let activeChannels = $derived(
		Object.entries(channels)
			.filter(([, v]) => v)
			.map(([k]) => k)
	);

	let maxY = $derived.by(() => {
		let max = 0;
		for (const ch of activeChannels) {
			for (const point of getChartData(ch)) {
				if (point.y > max) max = point.y;
			}
		}
		return max || 1;
	});

	let maxX = $derived(chartReadings.length > 0 ? chartReadings[chartReadings.length - 1].readingNumber : 1);
	const chartWidth = 800;
	const chartHeight = 300;
	const padding = { top: 20, right: 20, bottom: 40, left: 60 };

	function scaleX(x: number): number {
		return padding.left + ((x / maxX) * (chartWidth - padding.left - padding.right));
	}

	function scaleY(y: number): number {
		return chartHeight - padding.bottom - ((y / maxY) * (chartHeight - padding.top - padding.bottom));
	}

	function buildPath(points: Array<{ x: number; y: number }>): string {
		if (points.length === 0) return '';
		return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(p.x).toFixed(1)} ${scaleY(p.y).toFixed(1)}`).join(' ');
	}
</script>

<div class="mx-auto max-w-7xl space-y-6 p-4">
	<!-- Header -->
	<div class="flex items-start justify-between">
		<div class="flex items-center gap-3">
			<a
				href="/spu/test-results"
				class="flex items-center justify-center rounded"
				style="min-width: 44px; min-height: 44px; color: var(--color-tron-text-secondary, #9ca3af)"
				aria-label="Back to test results"
			>
				<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M19 12H5M12 19l-7-7 7-7" />
				</svg>
			</a>
			<div>
				<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan, #00ffff)">
					Test Result #{data.result.id}
				</h1>
				<span class="font-mono text-sm" style="color: var(--color-tron-text-secondary, #9ca3af)">
					{data.result.cartridgeUuid ?? 'No cartridge'}
				</span>
			</div>
			<span
				class="inline-block rounded px-2 py-1 text-xs font-semibold"
				style="color: {getStatusColor(data.result.status)}"
			>
				{data.result.status}
			</span>
		</div>
		<div class="flex gap-2">
			{#if data.canWrite}
				<button
					class="tron-button"
					style="min-height: 44px"
					onclick={() => (showStatusModal = true)}
				>
					Update Status
				</button>
			{/if}
		</div>
	</div>

	<!-- Success/Error -->
	{#if form?.success}
		<div class="tron-card p-3" style="border-color: var(--color-tron-green, #39ff14); color: var(--color-tron-green, #39ff14)">
			Status updated successfully.
		</div>
	{/if}

	<!-- Tab Bar -->
	<div class="flex gap-1 border-b" style="border-color: var(--color-tron-border, #374151)">
		<button
			class="px-4 py-2"
			style="min-height: 44px; color: {activeTab === 'overview' ? 'var(--color-tron-cyan, #00ffff)' : 'var(--color-tron-text-secondary, #9ca3af)'}; border-bottom: 2px solid {activeTab === 'overview' ? 'var(--color-tron-cyan, #00ffff)' : 'transparent'}"
			onclick={() => (activeTab = 'overview')}
		>
			Overview
		</button>
		<button
			class="px-4 py-2"
			style="min-height: 44px; color: {activeTab === 'chart' ? 'var(--color-tron-cyan, #00ffff)' : 'var(--color-tron-text-secondary, #9ca3af)'}; border-bottom: 2px solid {activeTab === 'chart' ? 'var(--color-tron-cyan, #00ffff)' : 'transparent'}"
			onclick={() => (activeTab = 'chart')}
		>
			Spectro Chart
			{#if data.readings.length > 0}
				<span class="ml-1 rounded-full px-1.5 py-0.5 text-xs" style="background: var(--color-tron-cyan, #00ffff); color: #000">
					{data.readings.length}
				</span>
			{/if}
		</button>
		<button
			class="px-4 py-2"
			style="min-height: 44px; color: {activeTab === 'readings' ? 'var(--color-tron-cyan, #00ffff)' : 'var(--color-tron-text-secondary, #9ca3af)'}; border-bottom: 2px solid {activeTab === 'readings' ? 'var(--color-tron-cyan, #00ffff)' : 'transparent'}"
			onclick={() => (activeTab = 'readings')}
		>
			Raw Readings
		</button>
	</div>

	<!-- Overview Tab -->
	{#if activeTab === 'overview'}
		<div class="grid gap-6 lg:grid-cols-2">
			<div class="tron-card p-5">
				<h3 class="mb-4 text-lg font-semibold" style="color: var(--color-tron-cyan, #00ffff)">
					Test Metadata
				</h3>
				<dl class="space-y-3">
					<div class="flex justify-between">
						<dt style="color: var(--color-tron-text-secondary, #9ca3af)">Cartridge UUID</dt>
						<dd class="font-mono" style="color: var(--color-tron-cyan, #00ffff)">{data.result.cartridgeUuid ?? '—'}</dd>
					</div>
					<div class="flex justify-between">
						<dt style="color: var(--color-tron-text-secondary, #9ca3af)">Assay ID</dt>
						<dd>
							{#if data.result.assayId}
								<a href="/spu/assays/{data.result.assayId}" class="font-mono" style="color: var(--color-tron-cyan, #00ffff)">
									{data.result.assayId}
								</a>
							{:else}
								<span style="color: var(--color-tron-text-secondary, #9ca3af)">—</span>
							{/if}
						</dd>
					</div>
					<div class="flex justify-between">
						<dt style="color: var(--color-tron-text-secondary, #9ca3af)">Device ID</dt>
						<dd>
							{#if data.result.deviceId}
								<a href="/spu/devices/{data.result.deviceId}" class="font-mono" style="color: var(--color-tron-cyan, #00ffff)">
									{data.result.deviceId}
								</a>
							{:else}
								<span style="color: var(--color-tron-text-secondary, #9ca3af)">—</span>
							{/if}
						</dd>
					</div>
					<div class="flex justify-between">
						<dt style="color: var(--color-tron-text-secondary, #9ca3af)">Status</dt>
						<dd style="color: {getStatusColor(data.result.status)}">{data.result.status}</dd>
					</div>
				</dl>
			</div>

			<div class="tron-card p-5">
				<h3 class="mb-4 text-lg font-semibold" style="color: var(--color-tron-cyan, #00ffff)">
					Technical Parameters
				</h3>
				<dl class="space-y-3">
					<div class="flex justify-between">
						<dt style="color: var(--color-tron-text-secondary, #9ca3af)">Duration</dt>
						<dd class="font-mono" style="color: var(--color-tron-text-primary, #f3f4f6)">{formatDuration(data.result.duration)}</dd>
					</div>
					<div class="flex justify-between">
						<dt style="color: var(--color-tron-text-secondary, #9ca3af)">A-Step</dt>
						<dd class="font-mono" style="color: var(--color-tron-text-primary, #f3f4f6)">{data.result.astep ?? '—'}</dd>
					</div>
					<div class="flex justify-between">
						<dt style="color: var(--color-tron-text-secondary, #9ca3af)">A-Time</dt>
						<dd class="font-mono" style="color: var(--color-tron-text-primary, #f3f4f6)">{data.result.atime ?? '—'}</dd>
					</div>
					<div class="flex justify-between">
						<dt style="color: var(--color-tron-text-secondary, #9ca3af)">A-Gain</dt>
						<dd class="font-mono" style="color: var(--color-tron-text-primary, #f3f4f6)">{data.result.again ?? '—'}</dd>
					</div>
					<div class="flex justify-between">
						<dt style="color: var(--color-tron-text-secondary, #9ca3af)">Readings</dt>
						<dd class="font-mono" style="color: var(--color-tron-text-primary, #f3f4f6)">{data.result.numberOfReadings ?? '—'}</dd>
					</div>
					<div class="flex justify-between">
						<dt style="color: var(--color-tron-text-secondary, #9ca3af)">Baseline Scans</dt>
						<dd class="font-mono" style="color: var(--color-tron-text-primary, #f3f4f6)">{data.result.baselineScans ?? '—'}</dd>
					</div>
					<div class="flex justify-between">
						<dt style="color: var(--color-tron-text-secondary, #9ca3af)">Test Scans</dt>
						<dd class="font-mono" style="color: var(--color-tron-text-primary, #f3f4f6)">{data.result.testScans ?? '—'}</dd>
					</div>
				</dl>
			</div>

			<div class="tron-card p-5 lg:col-span-2">
				<h3 class="mb-4 text-lg font-semibold" style="color: var(--color-tron-cyan, #00ffff)">
					Timestamps
				</h3>
				<dl class="grid gap-3 sm:grid-cols-2">
					<div class="flex justify-between">
						<dt style="color: var(--color-tron-text-secondary, #9ca3af)">Created</dt>
						<dd style="color: var(--color-tron-text-primary, #f3f4f6)">{formatDate(data.result.createdAt)}</dd>
					</div>
					<div class="flex justify-between">
						<dt style="color: var(--color-tron-text-secondary, #9ca3af)">Checksum</dt>
						<dd class="font-mono" style="color: var(--color-tron-text-primary, #f3f4f6)">{data.result.checksum ?? '—'}</dd>
					</div>
				</dl>
			</div>
		</div>
	{/if}

	<!-- Spectro Chart Tab -->
	{#if activeTab === 'chart'}
		<div class="tron-card p-5">
			<h3 class="mb-4 text-lg font-semibold" style="color: var(--color-tron-cyan, #00ffff)">
				Spectrophotometer Data
			</h3>

			{#if data.readings.length === 0}
				<p style="color: var(--color-tron-text-secondary, #9ca3af)">No spectro readings available.</p>
			{:else}
				<!-- Channel Toggles -->
				<div class="mb-4 flex flex-wrap gap-2">
					{#each Object.entries(channelConfig) as [key, config] (key)}
						<label
							class="flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-xs"
							style="border: 1px solid {channels[key as keyof typeof channels] ? config.color : 'var(--color-tron-border, #374151)'}; background: {channels[key as keyof typeof channels] ? `color-mix(in srgb, ${config.color} 15%, transparent)` : 'transparent'}; min-height: 32px"
						>
							<input type="checkbox" bind:checked={channels[key as keyof typeof channels]} class="hidden" />
							<span class="inline-block h-2 w-2 rounded-full" style="background: {config.color}"></span>
							<span style="color: {channels[key as keyof typeof channels] ? config.color : 'var(--color-tron-text-secondary, #9ca3af)'}">
								{config.label} ({config.wavelength})
							</span>
						</label>
					{/each}
				</div>

				<!-- SVG Chart -->
				<div class="overflow-x-auto">
					<svg viewBox="0 0 {chartWidth} {chartHeight}" class="w-full" style="min-width: 600px; background: var(--color-tron-bg-secondary, #1f2937); border-radius: 0.5rem">
						<!-- Baseline indicator -->
						{#if data.result.baselineScans}
							<line
								x1={scaleX(data.result.baselineScans)}
								y1={padding.top}
								x2={scaleX(data.result.baselineScans)}
								y2={chartHeight - padding.bottom}
								stroke="var(--color-tron-text-secondary, #6b7280)"
								stroke-width="1"
								stroke-dasharray="4,4"
							/>
							<text
								x={scaleX(data.result.baselineScans) + 4}
								y={padding.top + 12}
								fill="var(--color-tron-text-secondary, #6b7280)"
								font-size="10"
							>
								Baseline
							</text>
						{/if}

						<!-- Grid lines -->
						{#each [0.25, 0.5, 0.75, 1] as fraction}
							<line
								x1={padding.left}
								y1={scaleY(maxY * fraction)}
								x2={chartWidth - padding.right}
								y2={scaleY(maxY * fraction)}
								stroke="var(--color-tron-border, #374151)"
								stroke-width="0.5"
							/>
							<text
								x={padding.left - 5}
								y={scaleY(maxY * fraction) + 4}
								fill="var(--color-tron-text-secondary, #6b7280)"
								font-size="9"
								text-anchor="end"
							>
								{Math.round(maxY * fraction)}
							</text>
						{/each}

						<!-- X axis label -->
						<text
							x={chartWidth / 2}
							y={chartHeight - 5}
							fill="var(--color-tron-text-secondary, #6b7280)"
							font-size="11"
							text-anchor="middle"
						>
							Reading Number
						</text>

						<!-- Channel lines -->
						{#each activeChannels as ch (ch)}
							{@const points = getChartData(ch)}
							{@const config = channelConfig[ch]}
							{#if points.length > 0}
								<path
									d={buildPath(points)}
									fill="none"
									stroke={config.color}
									stroke-width="1.5"
									stroke-linecap="round"
									stroke-linejoin="round"
								/>
							{/if}
						{/each}

						<!-- Axes -->
						<line x1={padding.left} y1={padding.top} x2={padding.left} y2={chartHeight - padding.bottom} stroke="var(--color-tron-border, #374151)" stroke-width="1" />
						<line x1={padding.left} y1={chartHeight - padding.bottom} x2={chartWidth - padding.right} y2={chartHeight - padding.bottom} stroke="var(--color-tron-border, #374151)" stroke-width="1" />
					</svg>
				</div>
			{/if}
		</div>
	{/if}

	<!-- Raw Readings Tab -->
	{#if activeTab === 'readings'}
		<div class="tron-card p-5">
			<h3 class="mb-4 text-lg font-semibold" style="color: var(--color-tron-cyan, #00ffff)">
				Spectro Readings ({data.readings.length})
			</h3>
			{#if data.readings.length === 0}
				<p style="color: var(--color-tron-text-secondary, #9ca3af)">No readings available.</p>
			{:else}
				<div class="overflow-x-auto">
					<table class="tron-table w-full text-xs">
						<thead>
							<tr>
								<th>#</th>
								<th>Ch</th>
								<th>Temp</th>
								<th style="color: #8b5cf6">F1</th>
								<th style="color: #3b82f6">F2</th>
								<th style="color: #00ffff">F3</th>
								<th style="color: #22c55e">F4</th>
								<th style="color: #eab308">F5</th>
								<th style="color: #f97316">F6</th>
								<th style="color: #ef4444">F7</th>
								<th style="color: #991b1b">F8</th>
								<th>Clear</th>
								<th>NIR</th>
							</tr>
						</thead>
						<tbody>
							{#each data.readings as r (r.id)}
								<tr>
									<td>{r.readingNumber}</td>
									<td>{r.channel}</td>
									<td>{r.temperature?.toFixed(1) ?? '—'}</td>
									<td style="font-family: monospace">{r.f1 ?? '—'}</td>
									<td style="font-family: monospace">{r.f2 ?? '—'}</td>
									<td style="font-family: monospace">{r.f3 ?? '—'}</td>
									<td style="font-family: monospace">{r.f4 ?? '—'}</td>
									<td style="font-family: monospace">{r.f5 ?? '—'}</td>
									<td style="font-family: monospace">{r.f6 ?? '—'}</td>
									<td style="font-family: monospace">{r.f7 ?? '—'}</td>
									<td style="font-family: monospace">{r.f8 ?? '—'}</td>
									<td style="font-family: monospace">{r.clearChannel ?? '—'}</td>
									<td style="font-family: monospace">{r.nirChannel ?? '—'}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
	{/if}
</div>

<!-- Status Update Modal -->
{#if showStatusModal}
	<!-- svelte-ignore a11y_interactive_supports_focus -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
		role="dialog"
		onclick={() => (showStatusModal = false)}
		onkeydown={(e) => e.key === 'Escape' && (showStatusModal = false)}
	>
		<div class="tron-card w-full max-w-md p-6" onclick={(e) => e.stopPropagation()} role="document">
			<h2 class="mb-4 text-lg font-bold" style="color: var(--color-tron-cyan, #00ffff)">
				Update Status
			</h2>
			<form
				method="POST"
				action="?/updateStatus"
				use:enhance={() => {
					return async ({ result, update }) => {
						if (result.type === 'success') showStatusModal = false;
						await update();
					};
				}}
				class="space-y-4"
			>
				<select name="status" class="tron-input w-full" style="min-height: 44px" bind:value={statusValue}>
					<option value="uploaded">Uploaded</option>
					<option value="processed">Processed</option>
					<option value="flagged">Flagged</option>
					<option value="archived">Archived</option>
				</select>
				<textarea
					name="notes"
					class="tron-input w-full"
					style="min-height: 88px"
					placeholder="Notes (optional)"
					bind:value={statusNotes}
				></textarea>
				<div class="flex justify-end gap-2">
					<button type="button" class="tron-button" style="min-height: 44px" onclick={() => (showStatusModal = false)}>
						Cancel
					</button>
					<button type="submit" class="tron-button" style="min-height: 44px; background: var(--color-tron-cyan, #00ffff); color: #000; font-weight: 600">
						Update
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}
