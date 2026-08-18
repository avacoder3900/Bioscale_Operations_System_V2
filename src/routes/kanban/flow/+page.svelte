<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import TaskStatusBadge from '$lib/components/kanban/TaskStatusBadge.svelte';
	import KpiCard from '$lib/components/kanban/KpiCard.svelte';
	import CfdChart from '$lib/components/kanban/CfdChart.svelte';
	import WipTimelineWidget from '$lib/components/kanban/WipTimelineWidget.svelte';
	import ThroughputChart from '$lib/components/kanban/ThroughputChart.svelte';
	import CycleScatterChart from '$lib/components/kanban/CycleScatterChart.svelte';
	import AgingWipChart from '$lib/components/kanban/AgingWipChart.svelte';
	import TimeInStatusChart from '$lib/components/kanban/TimeInStatusChart.svelte';
	import PerTagTable from '$lib/components/kanban/PerTagTable.svelte';
	import SourceMixDonut from '$lib/components/kanban/SourceMixDonut.svelte';
	import { TIER1_STATUSES, TIER2_STATUSES } from '$lib/shared/kanban-status';

	let { data } = $props();

	let age = $derived(data.metrics.workItemAge.items as any[]);
	let sle = $derived(data.metrics.workItemAge.sle);
	let ratio = $derived(data.metrics.discoveredRatio);
	let expedite = $derived(data.metrics.expedite);
	let efficiency = $derived(data.metrics.flowEfficiency);
	let kpi = $derived(data.history.kpi);

	// KB2-14 — capacity + replenishment history, moved from the retired Replenish page.
	let wipByClass = $derived(data.capacity.wipByClassOfService as Record<string, number>);
	let allocation = $derived(data.capacity.allocationTargetsPct as Record<string, number>);
	let wipTotal = $derived(Object.values(wipByClass).reduce((a, b) => a + b, 0));
	const classOrder = ['standard', 'fixed_date', 'chore', 'expedite'];

	// KB2-15 — range selector for the historical charts. Flow's signal cards
	// keep their policy-defined windows; range is for exploration.
	const ranges: { key: '7d' | '30d' | '90d' | 'all'; label: string }[] = [
		{ key: '7d', label: '7 days' },
		{ key: '30d', label: '30 days' },
		{ key: '90d', label: '90 days' },
		{ key: 'all', label: 'All' }
	];

	function setRange(key: '7d' | '30d' | '90d' | 'all') {
		const params = new URLSearchParams($page.url.searchParams);
		params.set('range', key);
		goto(`${$page.url.pathname}?${params.toString()}`, { replaceState: true, noScroll: true });
	}

	function fmtWhen(d: string): string {
		return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
	}

	const flowDebtExplanation =
		'Aged past its SLE while newer items finished — the measurable cherry-picking signature. Diagnosed in the work, not in people.';

	const sizeClasses = ['short', 'medium', 'long'];

	function sleSourceLabel(s: { n: number; source: string }): string {
		if (s.source === 'measured') return `measured n=${s.n}`;
		if (s.source === 'seed') return `seed (n=${s.n} < ${sle.minSamples})`;
		return 'insufficient data';
	}
</script>

<div class="space-y-6">
	<div class="flex flex-wrap items-center justify-between gap-4">
		<div>
			<h2 class="tron-text-primary text-2xl font-bold">Flow</h2>
			<p class="tron-text-muted text-sm">
				How work moves —
				{data.history.taskCount.active} active · {data.history.taskCount.archivedInRange} archived in range.
				The pathology is diagnosed in the work, not in people.
			</p>
		</div>

		<!-- Date range selector — drives the historical charts below -->
		<div class="flex items-center gap-1 rounded-lg border border-[var(--color-tron-border)] p-1">
			{#each ranges as r}
				{@const active = data.history.range === r.key}
				<button
					type="button"
					class="rounded px-3 py-1 text-xs font-medium transition-all {active
						? 'bg-[var(--color-tron-cyan)] text-[var(--color-tron-bg-primary)]'
						: 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]'}"
					onclick={() => setRange(r.key)}
				>
					{r.label}
				</button>
			{/each}
		</div>
	</div>

	<!-- KPI cards (KB2-15, ported from Analytics; person-free) -->
	<section class="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
		<KpiCard
			label="Active tasks"
			value={String(kpi.activeTasks)}
			subline="not archived, not done"
			accent="#00d4ff"
		/>
		<KpiCard
			label="Throughput"
			value={String(kpi.throughputInRange)}
			subline="completed in range"
			accent="#00ff88"
		/>
		<KpiCard
			label="WIP right now"
			value={String(kpi.wipCount)}
			subline="across {kpi.wipAssignees} {kpi.wipAssignees === 1 ? 'person' : 'people'}"
			accent="#ff6600"
		/>
		<KpiCard
			label="Stuck in Waiting"
			value={String(kpi.waitingCount)}
			subline={kpi.oldestWaitingDays === null ? 'none' : `oldest: ${kpi.oldestWaitingDays}d`}
			accent="#ff3366"
		/>
		<KpiCard
			label="Aging tasks"
			value={String(kpi.agingCount)}
			subline="{kpi.criticalAgingCount} critical"
			accent="#f59e0b"
		/>
	</section>

	<!-- Signal cards -->
	<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
		<!-- Discovered ratio -->
		<div class="tron-card !p-4">
			<p class="tron-text-muted text-xs uppercase tracking-wide">Discovered work ({ratio.windowDays}d)</p>
			<p class="tron-text-primary mt-1 text-2xl font-bold">
				{ratio.ratioPct === null ? '—' : `${ratio.ratioPct}%`}
			</p>
			<p class="tron-text-muted mt-1 text-xs">
				{ratio.discovered} discovered / {ratio.planned} planned among committed items.
			</p>
			<p class="mt-2 text-xs" style="color: var(--color-tron-cyan);">{ratio.suggestion}</p>
		</div>

		<!-- Expedite rate -->
		<div class="tron-card !p-4" style={expedite.alert ? 'border-color: var(--color-tron-red); box-shadow: 0 0 8px rgba(255,51,102,0.2);' : ''}>
			<p class="tron-text-muted text-xs uppercase tracking-wide">Expedite rate (30d)</p>
			<p class="mt-1 text-2xl font-bold" style="color: {expedite.alert ? 'var(--color-tron-red)' : 'var(--color-tron-text-primary)'};">
				{expedite.pctOfCommitted}%
			</p>
			<p class="tron-text-muted mt-1 text-xs">{expedite.last30d} expedite item{expedite.last30d === 1 ? '' : 's'} committed.</p>
			{#if expedite.note}
				<p class="mt-2 text-xs font-bold" style="color: var(--color-tron-red);">{expedite.note}</p>
			{/if}
		</div>

		<!-- Flow efficiency -->
		<div class="tron-card !p-4">
			<p class="tron-text-muted text-xs uppercase tracking-wide">Flow efficiency ({efficiency.windowDays}d)</p>
			<p class="tron-text-primary mt-1 text-2xl font-bold">
				{efficiency.efficiencyPct === null ? '—' : `${efficiency.efficiencyPct}%`}
			</p>
			<p class="tron-text-muted mt-1 text-xs">n = {efficiency.n} finished items.</p>
			<p class="tron-text-muted mt-2 text-xs">{efficiency.note}</p>
		</div>

		<!-- SLE per size class -->
		<div class="tron-card !p-4">
			<p class="tron-text-muted text-xs uppercase tracking-wide">SLE (p{sle.percentile})</p>
			<div class="mt-2 space-y-1">
				{#each sizeClasses as sc (sc)}
					{@const s = sle.perSizeClass[sc]}
					<div class="flex items-baseline justify-between gap-2 text-sm">
						<span class="tron-text-primary capitalize">{sc}</span>
						<span class="tron-text-primary font-bold">{s?.days == null ? '—' : `${s.days}d`}</span>
						<span class="tron-text-muted text-[10px]">{s ? sleSourceLabel(s) : ''}</span>
					</div>
				{/each}
			</div>
		</div>
	</div>

	<!-- Work Item Age — THE leading indicator -->
	<section class="tron-card !p-4">
		<h3 class="tron-text-primary mb-1 text-sm font-bold uppercase tracking-wide">Work Item Age</h3>
		<p class="tron-text-muted mb-3 text-xs">
			Age = time since first WIP entry, for every unfinished committed item. Cycle time only describes
			finished work; age shows what is quietly stuck now.
		</p>
		{#if age.length === 0}
			<p class="tron-text-muted text-xs">No active committed items.</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead>
						<tr class="tron-text-muted text-left text-xs uppercase">
							<th class="pb-2 pr-3">Item</th>
							<th class="pb-2 pr-3">Status</th>
							<th class="pb-2 pr-3">Tags</th>
							<th class="pb-2 pr-3">Size</th>
							<th class="pb-2 pr-3 text-right">Age (d)</th>
							<th class="pb-2 pr-3 text-right">SLE (d)</th>
							<th class="pb-2">Signals</th>
						</tr>
					</thead>
					<tbody>
						{#each age as item (item.taskId)}
							<tr class="border-t border-[var(--color-tron-border)] {item.overSle ? 'bg-[rgba(255,51,102,0.05)]' : ''}">
								<td class="py-2 pr-3">
									<a href="/kanban/task/{item.taskId}" class="tron-text-primary hover:underline">{item.title}</a>
									{#if item.blockedReason}
										<span class="block text-xs" style="color: var(--color-tron-red);">{item.blockedReason}</span>
									{:else if item.waitingOn}
										<span class="tron-text-muted block text-xs">waiting on {item.waitingOn}</span>
									{/if}
								</td>
								<td class="py-2 pr-3"><TaskStatusBadge status={item.status} /></td>
								<td class="tron-text-muted py-2 pr-3 text-xs">{(item.tags ?? []).join(', ') || '—'}</td>
								<td class="tron-text-muted py-2 pr-3 text-xs uppercase">{item.sizeClass ?? '—'}</td>
								<td class="py-2 pr-3 text-right font-bold" style="color: {item.overSle ? 'var(--color-tron-red)' : 'var(--color-tron-text-primary)'};">
									{item.ageDays ?? '—'}
								</td>
								<td class="tron-text-muted py-2 pr-3 text-right">{item.sleDays ?? '—'}</td>
								<td class="py-2">
									{#if item.flowDebt}
										<span
											class="cursor-help rounded-full px-2 py-0.5 text-[10px] font-bold"
											style="background: rgba(255,51,102,0.15); color: var(--color-tron-red);"
											title={flowDebtExplanation}
										>
											FLOW DEBT (overtaken ×{item.overtakenBy})
										</span>
									{:else if item.overSle}
										<span class="rounded-full px-2 py-0.5 text-[10px] font-bold" style="background: rgba(245,158,11,0.15); color: #f59e0b;">OVER SLE</span>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	<!-- CFDs (KB2-15, ported; range aware) — split by tier so the
	     unbounded Tier 1 inventory can't drown the committed-flow signal.
	     Tier 2 (the delivery pipeline) first; Tier 1 (inventory) below it. -->
	<CfdChart
		points={data.history.cfd}
		title="Cumulative Flow — Board (committed: ready → done)"
		statuses={TIER2_STATUSES}
	/>
	<CfdChart
		points={data.history.cfd}
		title="Cumulative Flow — Tier 1 (inventory: captured / processed / icebox / declined)"
		statuses={TIER1_STATUSES}
	/>

	<!-- Daily WIP timeline (KB2-15, ported) — coordination view: who is on what.
	     One human, one limit. No totals, ever. -->
	<WipTimelineWidget data={data.wipTimeline} />

	<!-- Historical flow charts (KB2-15, ported; range aware) -->
	<section class="grid grid-cols-1 gap-4 lg:grid-cols-2">
		<ThroughputChart points={data.history.throughput} />
		<CycleScatterChart block={data.history.cycleScatter} />
		<AgingWipChart rows={data.history.agingWip} />
		<TimeInStatusChart rows={data.history.timeInStatus} />
	</section>

	<!-- Entry mix + per-tag breakdown (KB2-15, ported; person-free. KB2-16: tags replaced projects) -->
	<section class="grid grid-cols-1 gap-4 lg:grid-cols-2">
		<SourceMixDonut slices={data.history.sourceMix} />
		<PerTagTable rows={data.history.perTag} />
	</section>

	<!-- KB2-14: capacity + replenishment history (moved from the retired Replenish page) -->
	<div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
		<!-- WIP share per class of service vs allocation targets -->
		<section class="tron-card !p-4">
			<h3 class="tron-text-primary mb-3 text-sm font-bold uppercase tracking-wide">Capacity — WIP by class of service</h3>
			<table class="w-full text-sm">
				<thead>
					<tr class="tron-text-muted text-left text-xs uppercase">
						<th class="pb-2">Class</th>
						<th class="pb-2 text-right">WIP</th>
						<th class="pb-2 text-right">Share</th>
						<th class="pb-2 text-right">Target</th>
					</tr>
				</thead>
				<tbody>
					{#each classOrder as cos (cos)}
						{@const n = wipByClass[cos] ?? 0}
						{@const share = wipTotal ? Math.round((n / wipTotal) * 100) : 0}
						{@const target = allocation?.[cos] ?? null}
						<tr class="border-t border-[var(--color-tron-border)]">
							<td class="tron-text-primary py-1.5 capitalize">{cos.replace('_', ' ')}</td>
							<td class="tron-text-primary py-1.5 text-right">{n}</td>
							<td class="py-1.5 text-right {target !== null && share > target ? 'font-bold' : 'tron-text-primary'}" style={target !== null && share > target ? 'color: #f59e0b;' : ''}>{share}%</td>
							<td class="tron-text-muted py-1.5 text-right">{target === null ? '—' : `${target}%`}</td>
						</tr>
					{/each}
				</tbody>
			</table>
			<p class="tron-text-muted mt-2 text-[11px]">
				Allocation is advisory at commit time — except the chore ceiling, which is enforced (chore is a floor AND a ceiling).
			</p>
		</section>

		<!-- Recent replenishment events -->
		<section class="tron-card !p-4">
			<h3 class="tron-text-primary mb-3 text-sm font-bold uppercase tracking-wide">Recent replenishment events</h3>
			{#if data.events.length === 0}
				<p class="tron-text-muted text-xs">No replenishment events yet.</p>
			{:else}
				<ul class="space-y-1.5">
					{#each data.events as e (e.id)}
						<li class="text-sm">
							<span class="tron-text-primary font-bold">{e.by}</span>
							<span class="tron-text-muted"> — {fmtWhen(e.at)} — </span>
							<span class="tron-text-primary">{e.promotedCount} promoted</span>
							{#if e.rejectedCount}
								<span style="color: var(--color-tron-red);">, {e.rejectedCount} rejected</span>
							{/if}
							{#if e.note}
								<span class="tron-text-muted block text-xs">“{e.note}”</span>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	</div>
</div>
