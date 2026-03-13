<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import TaskStatusBadge from '$lib/components/kanban/TaskStatusBadge.svelte';
	import PriorityBadge from '$lib/components/kanban/PriorityBadge.svelte';

	let { data } = $props();

	type SortKey =
		| 'title'
		| 'status'
		| 'prioritized'
		| 'project'
		| 'assignee'
		| 'taskLength'
		| 'dueDate';
	type SortDir = 'asc' | 'desc';

	let sortColumn = $state<SortKey | null>(null);
	let sortDirection = $state<SortDir>('asc');

	const statusOrder: Record<string, number> = {
		backlog: 0,
		ready: 2,
		wip: 3,
		waiting: 4,
		done: 5
	};
	const sizeOrder: Record<string, number> = { short: 1, medium: 2, long: 3 };

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
				case 'status':
					av = statusOrder[a.status] ?? 0;
					bv = statusOrder[b.status] ?? 0;
					break;
				case 'prioritized':
					av = a.prioritized ? 1 : 0;
					bv = b.prioritized ? 1 : 0;
					break;
				case 'project':
					av = (a.projectName ?? '').toLowerCase();
					bv = (b.projectName ?? '').toLowerCase();
					break;
				case 'assignee':
					av = (a.assigneeName ?? 'zzz').toLowerCase();
					bv = (b.assigneeName ?? 'zzz').toLowerCase();
					break;
				case 'taskLength':
					av = sizeOrder[a.taskLength] ?? 0;
					bv = sizeOrder[b.taskLength] ?? 0;
					break;
				case 'dueDate':
					av = a.dueDate ? new Date(a.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
					bv = b.dueDate ? new Date(b.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
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

	let selectedProject = $derived($page.url.searchParams.get('project') ?? '');
	let selectedStatus = $derived($page.url.searchParams.get('status') ?? '');
	let selectedPrioritized = $derived($page.url.searchParams.get('prioritized') ?? '');
	let selectedAssignee = $derived($page.url.searchParams.get('assignee') ?? '');

	function updateFilter(key: string, value: string) {
		const params = new URLSearchParams($page.url.searchParams);
		if (value) {
			params.set(key, value);
		} else {
			params.delete(key);
		}
		const qs = params.toString();
		goto(`/kanban/list${qs ? `?${qs}` : ''}`, { replaceState: true });
	}

	function formatDate(date: Date | string | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
	}

	const sizeLabels: Record<string, string> = { short: 'Short', medium: 'Medium', long: 'Long' };
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex flex-wrap items-center justify-between gap-4">
		<div>
			<h2 class="tron-text-primary text-2xl font-bold">Task List</h2>
			<p class="tron-text-muted text-sm">
				{data.tasks.length} task{data.tasks.length !== 1 ? 's' : ''}
			</p>
		</div>
	</div>

	<!-- Filters -->
	<div class="grid grid-cols-2 gap-3 md:grid-cols-4">
		<select
			class="tron-select text-sm"
			value={selectedProject}
			onchange={(e) => updateFilter('project', (e.target as HTMLSelectElement).value)}
		>
			<option value="">All Projects</option>
			{#each data.projects as project}
				<option value={project.id}>{project.name}</option>
			{/each}
		</select>

		<select
			class="tron-select text-sm"
			value={selectedStatus}
			onchange={(e) => updateFilter('status', (e.target as HTMLSelectElement).value)}
		>
			<option value="">All Statuses</option>
			<option value="backlog">Backlog</option>
			<option value="ready">Ready</option>
			<option value="wip">WIP</option>
			<option value="waiting">Waiting</option>
			<option value="done">Done</option>
		</select>

		<select
			class="tron-select text-sm"
			value={selectedPrioritized}
			onchange={(e) => updateFilter('prioritized', (e.target as HTMLSelectElement).value)}
		>
			<option value="">All Tasks</option>
			<option value="true">Prioritized</option>
			<option value="false">Not Prioritized</option>
		</select>

		<select
			class="tron-select text-sm"
			value={selectedAssignee}
			onchange={(e) => updateFilter('assignee', (e.target as HTMLSelectElement).value)}
		>
			<option value="">All Assignees</option>
			{#each data.users as u}
				<option value={u.id}>{u.username}</option>
			{/each}
		</select>
	</div>

	<!-- Table -->
	<div class="overflow-x-auto">
		<table class="tron-table w-full">
			<thead>
				<tr>
					<th class="cursor-pointer select-none" onclick={() => handleSort('title')}>
						Title{sortIcon('title')}
					</th>
					<th class="cursor-pointer select-none" onclick={() => handleSort('status')}>
						Status{sortIcon('status')}
					</th>
					<th class="cursor-pointer select-none" onclick={() => handleSort('prioritized')}>
						Priority{sortIcon('prioritized')}
					</th>
					<th class="cursor-pointer select-none" onclick={() => handleSort('project')}>
						Project{sortIcon('project')}
					</th>
					<th class="cursor-pointer select-none" onclick={() => handleSort('assignee')}>
						Assignee{sortIcon('assignee')}
					</th>
					<th class="cursor-pointer select-none" onclick={() => handleSort('taskLength')}>
						Size{sortIcon('taskLength')}
					</th>
					<th class="cursor-pointer select-none" onclick={() => handleSort('dueDate')}>
						Due{sortIcon('dueDate')}
					</th>
					<th>Tags</th>
				</tr>
			</thead>
			<tbody>
				{#each sortedTasks as task (task.id)}
					<tr
						class="cursor-pointer transition-colors hover:bg-[var(--color-tron-bg-tertiary)]"
						onclick={() => goto(`/kanban/task/${task.id}`)}
					>
						<td class="tron-text-primary max-w-[250px] truncate font-medium">
							{task.title}
						</td>
						<td><TaskStatusBadge status={task.status} /></td>
						<td><PriorityBadge prioritized={task.prioritized} /></td>
						<td>
							{#if task.projectName}
								<span
									class="inline-flex items-center gap-1 text-xs"
									style="color: {task.projectColor};"
								>
									<span
										class="h-2 w-2 rounded-full"
										style="background: {task.projectColor};"
									></span>
									{task.projectName}
								</span>
							{:else}
								<span class="tron-text-muted text-xs">—</span>
							{/if}
						</td>
						<td>
							{#if task.assigneeName}
								<span class="text-xs" style="color: var(--color-tron-cyan);">
									{task.assigneeName}
								</span>
							{:else}
								<span class="tron-text-muted text-xs">—</span>
							{/if}
						</td>
						<td class="tron-text-muted text-xs">
							{sizeLabels[task.taskLength] ?? task.taskLength}
						</td>
						<td class="text-xs">
							{#if task.dueDate}
								{@const isOverdue =
									new Date(task.dueDate) < new Date() && task.status !== 'done'}
								<span
									class={isOverdue ? '' : 'tron-text-muted'}
									style={isOverdue ? 'color: var(--color-tron-red);' : ''}
								>
									{formatDate(task.dueDate)}
								</span>
							{:else}
								<span class="tron-text-muted">—</span>
							{/if}
						</td>
						<td>
							<div class="flex flex-wrap gap-1">
								{#each task.tags as tag (tag.id)}
									<span
										class="rounded-full px-1.5 py-0.5 text-[10px]"
										style="background: {tag.color}25; color: {tag.color};"
									>
										{tag.name}
									</span>
								{/each}
							</div>
						</td>
					</tr>
				{:else}
					<tr>
						<td colspan="8" class="tron-text-muted py-8 text-center text-sm">
							No tasks match the current filters.
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>
