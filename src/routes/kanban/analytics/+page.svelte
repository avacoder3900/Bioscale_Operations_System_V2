<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';

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

	<!-- KPI cards placeholder — KANBAN-ANALYTICS-KPI-CARDS PRD -->
	<section class="rounded-lg border border-dashed border-[var(--color-tron-border)] p-6">
		<p class="tron-text-muted text-sm">KPI cards row — PRD KANBAN-ANALYTICS-KPI-CARDS</p>
	</section>

	<!-- CFD placeholder — KANBAN-ANALYTICS-CFD PRD -->
	<section class="rounded-lg border border-dashed border-[var(--color-tron-border)] p-6">
		<p class="tron-text-muted text-sm">Cumulative Flow Diagram — PRD KANBAN-ANALYTICS-CFD</p>
	</section>

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
