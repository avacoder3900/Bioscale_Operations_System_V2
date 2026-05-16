<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import KpiCard from '$lib/components/kanban/KpiCard.svelte';
	import CfdChart from '$lib/components/kanban/CfdChart.svelte';

	let { data } = $props();

	const ranges: { key: '7d' | '30d' | '90d' | 'all'; label: string }[] = [
		{ key: '7d', label: '7 days' },
		{ key: '30d', label: '30 days' },
		{ key: '90d', label: '90 days' },
		{ key: 'all', label: 'All' }
	];

	function setRange(key: '7d' | '30d' | '90d' | 'all') {
		const params = new URLSearchParams($page.url.searchParams);
		params.set('range', key);
		goto(`/kanban/analytics?${params.toString()}`, { replaceState: true });
	}

	function fmt(value: number | null, suffix = ''): string {
		if (value === null) return '—';
		return `${Math.round(value * 10) / 10}${suffix}`;
	}

	let kpi = $derived(data.analytics.kpi);
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex flex-wrap items-center justify-between gap-4">
		<div>
			<h2 class="tron-text-primary text-2xl font-bold">Analytics</h2>
			<p class="tron-text-muted text-sm">
				{data.analytics.taskCount.active} active · {data.analytics.taskCount.archivedInRange} archived in range
			</p>
		</div>

		<!-- Date range selector -->
		<div class="flex items-center gap-1 rounded-lg border border-[var(--color-tron-border)] p-1">
			{#each ranges as r}
				{@const active = data.analytics.range === r.key}
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

	<!-- KPI cards row — PRD KANBAN-ANALYTICS-KPI-CARDS -->
	<section class="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
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
			label="Median cycle"
			value={kpi.medianCycleTimeDays === null ? '—' : fmt(kpi.medianCycleTimeDays, 'd')}
			subline={kpi.p85CycleTimeDays === null ? 'no completions' : `85th: ${fmt(kpi.p85CycleTimeDays, 'd')}`}
			accent="#a855f7"
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

	<!-- CFD — PRD KANBAN-ANALYTICS-CFD -->
	<CfdChart points={data.analytics.cfd} />

	<!-- WIP Timeline placeholder — KANBAN-WIP-TIMELINE PRD -->
	<section class="rounded-lg border border-dashed border-[var(--color-tron-border)] p-6">
		<p class="tron-text-muted text-sm">Daily WIP Timeline — PRD KANBAN-WIP-TIMELINE</p>
	</section>

	<!-- Flow charts placeholder — KANBAN-ANALYTICS-FLOW-CHARTS PRD -->
	<section class="rounded-lg border border-dashed border-[var(--color-tron-border)] p-6">
		<p class="tron-text-muted text-sm">Throughput / Cycle / Aging / Time-in-Status — PRD KANBAN-ANALYTICS-FLOW-CHARTS</p>
	</section>

	<!-- Breakdowns placeholder — KANBAN-ANALYTICS-BREAKDOWNS PRD -->
	<section class="rounded-lg border border-dashed border-[var(--color-tron-border)] p-6">
		<p class="tron-text-muted text-sm">Per-project / Per-assignee / Source mix — PRD KANBAN-ANALYTICS-BREAKDOWNS</p>
	</section>
</div>
