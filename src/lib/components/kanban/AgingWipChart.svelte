<script lang="ts">
	interface AgingWipRow {
		taskId: string;
		title: string;
		status: string;
		daysInStatus: number;
		severity: 'normal' | 'warning' | 'critical';
		statusColor: string;
	}

	interface Props {
		rows: AgingWipRow[];
	}

	let { rows }: Props = $props();

	let maxDays = $derived(rows.reduce((m, r) => Math.max(m, r.daysInStatus), 1));
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
	{/if}
</div>
