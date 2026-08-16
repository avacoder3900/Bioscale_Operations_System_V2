<script lang="ts">
	import { enhance } from '$app/forms';
	import TronButton from '$lib/components/ui/TronButton.svelte';
	import TaskStatusBadge from '$lib/components/kanban/TaskStatusBadge.svelte';
	import { ALL_STATUSES } from '$lib/shared/kanban-status';

	let { data, form } = $props();

	type SortKey = 'title' | 'tags' | 'assignee' | 'status' | 'completed';
	type SortDir = 'asc' | 'desc';

	let sortColumn = $state<SortKey | null>(null);
	let sortDirection = $state<SortDir>('asc');

	const statusOrder: Record<string, number> = Object.fromEntries(
		ALL_STATUSES.map((s, i) => [s, i])
	);

	let sortedTasks = $derived.by(() => {
		if (!sortColumn) return data.tasks;

		const col = sortColumn;
		const dir = sortDirection === 'asc' ? 1 : -1;

		return [...data.tasks].sort((a, b) => {
			let av: number | string = '';
			let bv: number | string = '';

			switch (col) {
				case 'title':
					av = a.title.toLowerCase();
					bv = b.title.toLowerCase();
					break;
				case 'tags':
					av = (a.tags?.[0]?.name ?? 'zzz').toLowerCase();
					bv = (b.tags?.[0]?.name ?? 'zzz').toLowerCase();
					break;
				case 'assignee':
					av = (a.assigneeName ?? 'zzz').toLowerCase();
					bv = (b.assigneeName ?? 'zzz').toLowerCase();
					break;
				case 'status':
					av = statusOrder[a.status] ?? 0;
					bv = statusOrder[b.status] ?? 0;
					break;
				case 'completed':
					av = a.statusChangedAt ? new Date(a.statusChangedAt).getTime() : Number.MAX_SAFE_INTEGER;
					bv = b.statusChangedAt ? new Date(b.statusChangedAt).getTime() : Number.MAX_SAFE_INTEGER;
					break;
			}

			if (av < bv) return -1 * dir;
			if (av > bv) return 1 * dir;
			return 0;
		});
	});

	function handleSort(col: SortKey) {
		if (sortColumn === col) {
			if (sortDirection === 'asc') {
				sortDirection = 'desc';
			} else {
				sortColumn = null;
				sortDirection = 'asc';
			}
		} else {
			sortColumn = col;
			sortDirection = 'asc';
		}
	}

	function sortIcon(col: SortKey): string {
		if (sortColumn !== col) return '';
		return sortDirection === 'asc' ? ' ▲' : ' ▼';
	}

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
						<th class="cursor-pointer select-none px-4 py-3 text-left font-medium" style="color: var(--color-tron-text-muted);" onclick={() => handleSort('title')}>
							Title{sortIcon('title')}
						</th>
						<th class="cursor-pointer select-none px-4 py-3 text-left font-medium" style="color: var(--color-tron-text-muted);" onclick={() => handleSort('tags')}>
							Tags{sortIcon('tags')}
						</th>
						<th class="cursor-pointer select-none px-4 py-3 text-left font-medium" style="color: var(--color-tron-text-muted);" onclick={() => handleSort('assignee')}>
							Assignee{sortIcon('assignee')}
						</th>
						<th class="cursor-pointer select-none px-4 py-3 text-left font-medium" style="color: var(--color-tron-text-muted);" onclick={() => handleSort('status')}>
							Status{sortIcon('status')}
						</th>
						<th class="cursor-pointer select-none px-4 py-3 text-left font-medium" style="color: var(--color-tron-text-muted);" onclick={() => handleSort('completed')}>
							Completed{sortIcon('completed')}
						</th>
					</tr>
				</thead>
				<tbody>
					{#each sortedTasks as task, i (task.id)}
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
								{(task.tags ?? []).map((t: any) => t.name).join(', ') || '—'}
							</td>
							<td class="px-4 py-3" style="color: var(--color-tron-text);">
								{task.assigneeName ?? '—'}
							</td>
							<td class="px-4 py-3">
								<TaskStatusBadge status={task.status ?? 'captured'} />
							</td>
							<td class="px-4 py-3" style="color: var(--color-tron-text-muted);">
								{formatDate(task.statusChangedAt)}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
