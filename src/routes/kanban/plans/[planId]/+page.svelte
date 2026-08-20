<script lang="ts">
	/** KB2-29 — plan detail. The markdown is shown VERBATIM (read-only, monospace). */
	import TaskStatusBadge from '$lib/components/kanban/TaskStatusBadge.svelte';
	import { tagColor } from '$lib/shared/tag-color';

	let { data } = $props();
	const fmt = (d: string) =>
		new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
	const doneCount = $derived(data.spawned.filter((t: any) => t.status === 'done').length);
</script>

<svelte:head><title>{data.plan.title} — Plans</title></svelte:head>

<div class="space-y-4">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div>
			<a href="/kanban/plans" class="text-xs tron-text-muted hover:underline">← Plans</a>
			<h2 class="tron-text-primary text-lg font-bold">
				{data.plan.title}
				{#if data.plan.version}<span class="ml-2 rounded bg-[var(--color-tron-bg-tertiary)] px-1.5 py-0.5 font-mono text-xs tron-text-muted">{data.plan.version}</span>{/if}
			</h2>
			<p class="text-xs tron-text-muted">
				Filed {fmt(data.plan.createdAt)} by {data.plan.authoredBy} via {data.plan.filedVia}
				{#if data.predecessor} · supersedes <a class="underline" href="/kanban/plans/{data.predecessor._id}">{data.predecessor.title} {data.predecessor.version ?? ''}</a>{/if}
				{#if data.successor} · <span class="text-yellow-300">superseded by <a class="underline" href="/kanban/plans/{data.successor._id}">{data.successor.title} {data.successor.version ?? ''}</a></span>{/if}
			</p>
			{#if data.plan.context}<p class="mt-1 max-w-3xl text-xs tron-text-muted">{data.plan.context}</p>{/if}
		</div>
		<div class="text-right text-sm tron-text-muted">{doneCount}/{data.spawned.length} spawned tasks done</div>
	</div>

	{#if data.spawned.length}
		<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
			<div class="border-b border-[var(--color-tron-border)] px-4 py-2 text-sm font-bold tron-text-primary">
				Spawned tasks <span class="tron-text-muted font-normal">— the plan as a lens on the board</span>
			</div>
			<div class="max-h-[420px] divide-y divide-[var(--color-tron-border)] overflow-y-auto">
				{#each data.spawned as t (t._id)}
					<div class="flex flex-wrap items-center gap-2 px-4 py-1.5 text-sm">
						<a href="/kanban/task/{t._id}" class="tron-text-primary min-w-[220px] flex-1 hover:underline">
							{#if t.itemType === 'milestone'}<span class="text-[var(--color-tron-cyan)]">◆</span>{/if}
							{#if t.trackingNumber}<span class="font-mono text-xs tron-text-muted">{t.trackingNumber}</span>{/if}
							{t.title}
						</a>
						{#each (t.tags ?? []).slice(0, 3) as tag (tag)}
							<span class="rounded-full px-1.5 py-0.5 text-[10px]" style="background: {tagColor(tag)}18; color: {tagColor(tag)};">{tag}</span>
						{/each}
						{#if t.estimateDays}<span class="font-mono text-[10px] tron-text-muted">{t.estimateDays}d</span>{/if}
						<TaskStatusBadge status={t.status} />
					</div>
				{/each}
			</div>
		</section>
	{/if}

	<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
		<pre class="max-w-full overflow-x-auto text-xs leading-relaxed whitespace-pre-wrap tron-text-primary" style="font-family: ui-monospace, monospace;">{data.plan.content}</pre>
	</section>
</div>
