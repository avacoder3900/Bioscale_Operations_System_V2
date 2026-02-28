<script lang="ts">
	import { enhance } from '$app/forms';
	import TronButton from '$lib/components/ui/TronButton.svelte';
	import TaskStatusBadge from '$lib/components/kanban/TaskStatusBadge.svelte';

	let { data, form } = $props();

	const priorityLabels: Record<string, string> = {
		high: 'High',
		medium: 'Medium',
		low: 'Low'
	};

	function formatDate(date: string | Date | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		});
	}
</script>

<div class="min-h-screen p-6" style="background: var(--color-tron-bg);">
	<!-- Header -->
	<div class="mb-6 flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold" style="color: var(--color-tron-accent);">Archive</h1>
			<p class="mt-1 text-sm" style="color: var(--color-tron-text-muted);">
				{data.tasks.length} archived task{data.tasks.length !== 1 ? 's' : ''}
			</p>
		</div>
		<form method="POST" action="?/archiveDone" use:enhance>
			<TronButton type="submit" variant="default">
				Archive All Done Tasks
			</TronButton>
		</form>
	</div>

	<!-- Success message -->
	{#if form?.success}
		<div class="mb-4 rounded border px-4 py-3 text-sm"
			style="border-color: var(--color-tron-accent); color: var(--color-tron-accent); background: color-mix(in srgb, var(--color-tron-accent) 10%, transparent);">
			{form.count} task{form.count !== 1 ? 's' : ''} archived successfully.
		</div>
	{/if}

	<!-- Table -->
	{#if data.tasks.length === 0}
		<div class="rounded-lg border py-16 text-center"
			style="border-color: var(--color-tron-border); background: var(--color-tron-surface);">
			<p class="text-lg font-medium" style="color: var(--color-tron-text-muted);">No archived tasks yet</p>
			<p class="mt-1 text-sm" style="color: var(--color-tron-text-muted);">
				Tasks move here when archived manually or when done tasks are cleared weekly.
			</p>
		</div>
	{:else}
		<div class="overflow-hidden rounded-lg border" style="border-color: var(--color-tron-border);">
			<table class="w-full text-sm">
				<thead>
					<tr style="background: var(--color-tron-surface); border-bottom: 1px solid var(--color-tron-border);">
						<th class="px-4 py-3 text-left font-medium" style="color: var(--color-tron-text-muted);">Title</th>
						<th class="px-4 py-3 text-left font-medium" style="color: var(--color-tron-text-muted);">Project</th>
						<th class="px-4 py-3 text-left font-medium" style="color: var(--color-tron-text-muted);">Assignee</th>
						<th class="px-4 py-3 text-left font-medium" style="color: var(--color-tron-text-muted);">Status</th>
						<th class="px-4 py-3 text-left font-medium" style="color: var(--color-tron-text-muted);">Archived</th>
					</tr>
				</thead>
				<tbody>
					{#each data.tasks as task, i}
						<tr style="background: {i % 2 === 0 ? 'var(--color-tron-surface)' : 'color-mix(in srgb, var(--color-tron-surface) 30%, transparent)'}; border-bottom: 1px solid var(--color-tron-border);">
							<td class="px-4 py-3">
								<a
									href="/kanban/task/{task.id}"
									class="font-medium hover:underline"
									style="color: var(--color-tron-accent);"
								>
									{task.title}
								</a>
							</td>
							<td class="px-4 py-3" style="color: var(--color-tron-text);">
								{task.projectName ?? '—'}
							</td>
							<td class="px-4 py-3" style="color: var(--color-tron-text);">
								{task.assigneeName ?? '—'}
							</td>
							<td class="px-4 py-3">
								<TaskStatusBadge status={task.status ?? 'backlog'} />
							</td>
							<td class="px-4 py-3" style="color: var(--color-tron-text-muted);">
								{formatDate(task.archivedAt)}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
