<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';

	let { data } = $props();

	function updateRange(range: string) {
		const url = new URL($page.url);
		url.searchParams.set('range', range);
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- URL built from current page
		goto(url.toString(), { invalidateAll: true });
	}

	function pct(val: number): string {
		return (val * 100).toFixed(1) + '%';
	}
</script>

<div class="space-y-6">
	<!-- Filters -->
	<div class="flex items-center gap-3">
		<span class="text-sm text-[var(--color-tron-text-secondary)]">Period:</span>
		{#each [
			{ value: '7', label: '7 Days' },
			{ value: '30', label: '30 Days' },
			{ value: '90', label: '90 Days' },
			{ value: 'all', label: 'All Time' }
		] as opt (opt.value)}
			<button type="button" onclick={() => updateRange(opt.value)}
				class="min-h-[36px] rounded border px-3 py-1 text-xs font-medium transition-colors {data.rangeParam === opt.value
					? 'border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]'
					: 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}"
			>
				{opt.label}
			</button>
		{/each}
	</div>

	<!-- KPI Cards -->
	<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
		<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 text-center">
			<div class="text-3xl font-bold text-[var(--color-tron-cyan)]">{data.yieldStats.totalBacked}</div>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">Total Cartridges</div>
		</div>
		<div class="rounded border border-green-500/30 bg-green-900/10 p-4 text-center">
			<div class="text-3xl font-bold text-green-400">{data.throughput.totalCompleted}</div>
			<div class="text-xs text-green-300/70">Completed</div>
		</div>
		<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 text-center">
			<div class="text-3xl font-bold text-emerald-400">{pct(data.yieldStats.overallYield)}</div>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">Overall Yield</div>
		</div>
		<div class="rounded border border-amber-500/30 bg-amber-900/10 p-4 text-center">
			<div class="text-3xl font-bold text-amber-400">{data.throughput.totalInProgress}</div>
			<div class="text-xs text-amber-300/70">In Progress</div>
		</div>
	</div>

	<!-- Failure Rates -->
	<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
		<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Failure Rates</h3>
		<div class="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
			<div>
				<span class="text-xs text-[var(--color-tron-text-secondary)]">Total Inspected</span>
				<div class="text-lg font-bold text-[var(--color-tron-text)]">{data.failureRates.totalInspected}</div>
			</div>
			<div>
				<span class="text-xs text-red-400">Rejection Rate</span>
				<div class="text-lg font-bold text-red-400">{pct(data.failureRates.rejectionRate)}</div>
			</div>
			<div>
				<span class="text-xs text-amber-400">QA/QC Rate</span>
				<div class="text-lg font-bold text-amber-400">{pct(data.failureRates.qaqcRate)}</div>
			</div>
			<div>
				<span class="text-xs text-[var(--color-tron-text-secondary)]">Wax Rejected</span>
				<div class="text-lg font-bold text-[var(--color-tron-text)]">{data.failureRates.waxRejectedCount}</div>
			</div>
		</div>
	</div>

	<!-- Stage Falloff -->
	<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
		<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Stage-by-Stage Yield</h3>
		<div class="space-y-2">
			{#each data.yieldStats.stageFalloff as stage (stage.stage)}
				<div class="flex items-center gap-3">
					<span class="w-32 text-xs text-[var(--color-tron-text-secondary)]">{stage.stage}</span>
					<div class="flex-1">
						<div class="h-4 overflow-hidden rounded-full bg-[var(--color-tron-border)]">
							<div class="h-full rounded-full bg-[var(--color-tron-cyan)] transition-all" style="width: {stage.percentage}%"></div>
						</div>
					</div>
					<span class="w-12 text-right text-xs text-[var(--color-tron-text)]">{stage.percentage.toFixed(0)}%</span>
					<span class="w-10 text-right text-xs text-[var(--color-tron-text-secondary)]">{stage.count}</span>
				</div>
			{/each}
		</div>
	</div>

	<div class="grid gap-4 lg:grid-cols-2">
		<!-- Rejection Breakdown -->
		<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
			<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Rejection Breakdown</h3>
			{#if data.rejectionBreakdown.length === 0}
				<p class="text-xs text-[var(--color-tron-text-secondary)]">No rejections recorded</p>
			{:else}
				<div class="space-y-1">
					{#each data.rejectionBreakdown as item (item.reasonCode)}
						<div class="flex items-center justify-between rounded bg-[var(--color-tron-bg)] px-3 py-2">
							<div>
								<span class="font-mono text-xs text-red-400">{item.reasonCode}</span>
								<span class="ml-2 text-xs text-[var(--color-tron-text)]">{item.label}</span>
							</div>
							<span class="text-sm font-bold text-[var(--color-tron-text)]">{item.count}</span>
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Operator Stats -->
		<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
			<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Operator Performance</h3>
			{#if data.operatorStats.length === 0}
				<p class="text-xs text-[var(--color-tron-text-secondary)]">No operator data</p>
			{:else}
				<div class="space-y-1">
					{#each data.operatorStats as op (op.operatorId)}
						<div class="flex items-center justify-between rounded bg-[var(--color-tron-bg)] px-3 py-2">
							<span class="text-xs text-[var(--color-tron-text)]">{op.operatorName}</span>
							<div class="flex items-center gap-3">
								<span class="text-xs text-[var(--color-tron-text-secondary)]">{op.cartridgesProcessed} processed</span>
								<span class="text-xs {op.rejectionRate > 0.1 ? 'text-red-400' : 'text-green-400'}">
									{pct(op.rejectionRate)} rejected
								</span>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>

	<!-- Assay Type Stats -->
	<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
		<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Assay Type Breakdown</h3>
		{#if data.assayTypeStats.length === 0}
			<p class="text-xs text-[var(--color-tron-text-secondary)]">No data</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b border-[var(--color-tron-border)]">
							<th class="px-3 py-2 text-left text-xs font-medium text-[var(--color-tron-text-secondary)]">Assay Type</th>
							<th class="px-3 py-2 text-right text-xs font-medium text-[var(--color-tron-text-secondary)]">Total</th>
							<th class="px-3 py-2 text-right text-xs font-medium text-[var(--color-tron-text-secondary)]">Completed</th>
							<th class="px-3 py-2 text-right text-xs font-medium text-[var(--color-tron-text-secondary)]">Yield</th>
						</tr>
					</thead>
					<tbody>
						{#each data.assayTypeStats as stat (stat.assayTypeId)}
							<tr class="border-b border-[var(--color-tron-border)]/50">
								<td class="px-3 py-2 text-[var(--color-tron-text)]">{stat.assayTypeName}</td>
								<td class="px-3 py-2 text-right text-[var(--color-tron-text)]">{stat.totalCartridges}</td>
								<td class="px-3 py-2 text-right text-green-400">{stat.completedCartridges}</td>
								<td class="px-3 py-2 text-right text-[var(--color-tron-cyan)]">{pct(stat.yieldRate)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>

	<!-- Daily Throughput Chart (CSS bar chart) -->
	{#if data.throughput.dailyCounts.length > 0}
		{@const maxCount = Math.max(...data.throughput.dailyCounts.map((d) => d.count), 1)}
		<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
			<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Daily Throughput</h3>
			<div class="flex items-end gap-1" style="height: 120px">
				{#each data.throughput.dailyCounts as day (day.date)}
					<div class="group relative flex-1" style="height: 100%">
						<div
							class="absolute bottom-0 w-full rounded-t bg-[var(--color-tron-cyan)]"
							style="height: {(day.count / maxCount) * 100}%"
						></div>
						<div class="absolute -top-6 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded bg-[var(--color-tron-bg)] px-1.5 py-0.5 text-[10px] text-[var(--color-tron-text)] shadow group-hover:block">
							{day.date}: {day.count}
						</div>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
