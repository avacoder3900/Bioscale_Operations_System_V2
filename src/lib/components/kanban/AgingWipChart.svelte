<script lang="ts">
	import { AGING_THRESHOLDS, STATUS_META, type KanbanStatus, type AgingLevel } from '$lib/shared/kanban-status';

	interface AgingWipRow {
		taskId: string;
		title: string;
		status: string;
		daysInStatus: number;
		severity: AgingLevel;
		statusColor: string;
	}

	interface Props {
		rows: AgingWipRow[];
	}

	let { rows }: Props = $props();

	let maxDays = $derived(rows.reduce((m, r) => Math.max(m, r.daysInStatus), 1));

	// Only statuses that age appear in the legend.
	const statusLegend = (Object.keys(AGING_THRESHOLDS) as KanbanStatus[]).map((status) => ({
		status,
		label: STATUS_META[status].label,
		color: STATUS_META[status].color
	}));
</script>

<div class="tron-card p-4">
	<h3 class="tron-text-primary mb-3 text-sm font-bold">Aging Tasks (top 20)</h3>
	{#if rows.length === 0}
		<p class="tron-text-muted text-xs">No aging tasks.</p>
	{:else}
		<div class="space-y-1 text-xs">
			{#each rows as r (r.taskId)}
				<a
					href="/kanban/task/{r.taskId}"
					class="flex items-center gap-2 hover:opacity-80"
				>
					<span class="tron-text-primary w-48 truncate" title={r.title}>{r.title}</span>
					<div class="flex h-4 flex-1 items-center rounded bg-[var(--color-tron-bg-tertiary)]">
						<div
							class="h-full rounded"
							style="width: {(r.daysInStatus / maxDays) * 100}%; background: {r.statusColor}; outline: {r.severity === 'critical' ? '1px solid #ef4444' : 'none'};"
						></div>
					</div>
					<span class="tron-text-muted w-12 text-right">{r.daysInStatus}d</span>
				</a>
			{/each}
		</div>

		<!-- Color key -->
		<div class="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--color-tron-border)]/40 pt-2 text-[10px]">
			<span class="tron-text-muted uppercase tracking-wide">Bar color:</span>
			{#each statusLegend as s (s.status)}
				<span class="inline-flex items-center gap-1">
					<span class="h-2 w-2 rounded-full" style="background: {s.color};"></span>
					<span class="tron-text-muted">{s.label}</span>
				</span>
			{/each}
			<span class="inline-flex items-center gap-1">
				<span class="h-2 w-2 rounded-sm border" style="border-color: #ef4444;"></span>
				<span class="tron-text-muted">red outline = critical age</span>
			</span>
		</div>
	{/if}
</div>
