<script lang="ts">
	interface TimeInStatusSegment {
		status: string;
		days: number;
		color: string;
	}

	interface TimeInStatusRow {
		taskId: string;
		title: string;
		totalDays: number;
		segments: TimeInStatusSegment[];
	}

	interface Props {
		rows: TimeInStatusRow[];
	}

	let { rows }: Props = $props();

	let maxTotal = $derived(rows.reduce((m, r) => Math.max(m, r.totalDays), 1));
</script>

<div class="tron-card p-4">
	<h3 class="tron-text-primary mb-3 text-sm font-bold">Time-in-status (top 20)</h3>
	{#if rows.length === 0}
		<p class="tron-text-muted text-xs">No completed tasks in range.</p>
	{:else}
		<div class="space-y-1 text-xs">
			{#each rows as r (r.taskId)}
				<a
					href="/kanban/task/{r.taskId}"
					class="flex items-center gap-2 hover:opacity-80"
				>
					<span class="tron-text-primary w-48 truncate" title={r.title}>{r.title}</span>
					<div class="flex h-4 flex-1 overflow-hidden rounded bg-[var(--color-tron-bg-tertiary)]">
						{#each r.segments as seg, i (i)}
							<div
								class="h-full"
								style="width: {(seg.days / maxTotal) * 100}%; background: {seg.color};"
								title="{seg.status}: {seg.days}d"
							></div>
						{/each}
					</div>
					<span class="tron-text-muted w-12 text-right">{Math.round(r.totalDays * 10) / 10}d</span>
				</a>
			{/each}
		</div>
	{/if}
</div>
