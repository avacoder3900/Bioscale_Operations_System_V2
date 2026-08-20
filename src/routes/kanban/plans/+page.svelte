<script lang="ts">
	/** KB2-29 — plan index. Plans are filed via MCP (kanban_file_plan); read-only here. */
	let { data } = $props();
	const fmt = (d: string) =>
		new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
</script>

<svelte:head><title>Plans — Kanban</title></svelte:head>

<div class="space-y-4">
	<p class="text-xs tron-text-muted">
		Immortalized strategy documents — each filed verbatim from a finalized Claude-app workshop via
		<span class="font-mono text-[var(--color-tron-cyan)]">kanban_file_plan</span>, then linked to every task it spawned.
		Content is never edited after filing; new versions supersede old ones.
	</p>

	{#if data.plans.length === 0}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-6 text-sm tron-text-muted">
			No plans filed yet.
		</div>
	{:else}
		<div class="space-y-2">
			{#each data.plans as p (p._id)}
				<a href="/kanban/plans/{p._id}"
					class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] px-4 py-3 transition-all hover:border-[var(--color-tron-cyan)]/50">
					<div class="min-w-[240px] flex-1">
						<div class="flex items-center gap-2">
							<span class="tron-text-primary text-sm font-bold">{p.title}</span>
							{#if p.version}<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-1.5 py-0.5 font-mono text-[10px] tron-text-muted">{p.version}</span>{/if}
							{#if p.status === 'superseded'}
								<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-1.5 py-0.5 text-[10px] uppercase tron-text-muted">superseded</span>
							{:else}
								<span class="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase" style="background: rgba(52,211,153,0.15); color: #34d399;">active</span>
							{/if}
						</div>
						{#if p.context}<p class="mt-0.5 text-xs tron-text-muted">{p.context}</p>{/if}
					</div>
					<div class="flex items-center gap-4 text-xs tron-text-muted">
						<span>{p.spawnedDone}/{p.spawnedTasks} tasks done</span>
						<span>{p.authoredBy}</span>
						<span class="font-mono">{fmt(p.createdAt)}</span>
					</div>
				</a>
			{/each}
		</div>
	{/if}
</div>
