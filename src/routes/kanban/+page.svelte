<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import TronButton from '$lib/components/ui/TronButton.svelte';
	import KanbanColumn from '$lib/components/kanban/KanbanColumn.svelte';
	import CreateTaskModal from '$lib/components/kanban/CreateTaskModal.svelte';

	let { data, form } = $props();
	let showCreateModal = $state(false);
	let dragError = $state('');

	const columns = [
		{ key: 'backlog', label: 'Backlog', color: '#a0a0a0', nextStatus: 'ready' },
		{
			key: 'ready',
			label: 'Ready',
			color: '#00d4ff',
			prevStatus: 'backlog',
			nextStatus: 'wip'
		},
		{
			key: 'wip',
			label: 'WIP',
			color: '#ff6600',
			prevStatus: 'ready',
			nextStatus: 'waiting'
		},
		{
			key: 'waiting',
			label: 'Waiting',
			color: '#ff3366',
			prevStatus: 'wip',
			nextStatus: 'wip'
		},
		{ key: 'done', label: 'Done', color: '#00ff88', prevStatus: 'wip' }
	];

	interface ProjectGroup {
		id: string | null;
		name: string;
		color: string;
		tasks: typeof data.tasks;
	}

	let createModalProjectId = $state<string | undefined>(undefined);

	let projectGroups = $derived.by(() => {
		const groups: ProjectGroup[] = [];
		const byProject = new Map<string | null, typeof data.tasks>();

		for (const task of data.tasks) {
			const key = task.projectId;
			if (!byProject.has(key)) byProject.set(key, []);
			byProject.get(key)!.push(task);
		}

		// Show ALL active projects, sorted alphabetically — even if they have 0 tasks
		const sortedProjects = [...data.projects].sort((a, b) => a.name.localeCompare(b.name));

		for (const proj of sortedProjects) {
			groups.push({
				id: proj.id,
				name: proj.name,
				color: proj.color,
				tasks: byProject.get(proj.id) ?? []
			});
		}

		return groups;
	});

	function tasksByStatus(tasks: typeof data.tasks) {
		const grouped: Record<string, typeof data.tasks> = {};
		for (const col of columns) {
			grouped[col.key] = tasks.filter((t) => {
				if (col.key === 'backlog') {
					return t.status === 'backlog';
				}
				return t.status === col.key;
			});
		}
		return grouped;
	}

	/** Track which project sections are collapsed */
	let collapsed = $state(new Set<string | null>(
		data.projects.filter((p) => !data.tasks.some((t) => t.projectId === p.id)).map((p) => p.id)
	));

	function toggleCollapse(projectId: string | null) {
		const next = new Set(collapsed);
		const key = projectId;
		if (next.has(key)) {
			next.delete(key);
		} else {
			next.add(key);
		}
		collapsed = next;
	}

	async function handleDrop(taskId: string, newStatus: string) {
		dragError = '';
		try {
			const res = await fetch('/api/kanban/move', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ taskId, newStatus })
			});
			const result = await res.json();
			if (!result.success) {
				dragError = result.error ?? 'Failed to move task';
			}
			await invalidateAll();
		} catch {
			dragError = 'Failed to move task. Please try again.';
		}
	}
</script>

<div class="space-y-6">
	<!-- Header row -->
	<div class="flex flex-wrap items-center justify-between gap-4">
		<div>
			<h2 class="tron-text-primary text-2xl font-bold">Task Board</h2>
			<p class="tron-text-muted text-sm">
				{data.tasks.length} task{data.tasks.length !== 1 ? 's' : ''} across {data.projects.length} project{data.projects.length !== 1 ? 's' : ''}
			</p>
		</div>

		<div class="flex items-center gap-3">
			<TronButton variant="primary" onclick={() => (showCreateModal = true)}>
				<span class="flex items-center gap-2">
					<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M12 4v16m8-8H4"
						/>
					</svg>
					New Task
				</span>
			</TronButton>
		</div>
	</div>

	<!-- Error display -->
	{#if form?.error || dragError}
		<div
			class="rounded border border-[rgba(255,51,102,0.3)] bg-[rgba(255,51,102,0.1)] px-4 py-3 text-sm"
			style="color: var(--color-tron-red);"
		>
			{form?.error ?? dragError}
		</div>
	{/if}

	<!-- Project-grouped board -->
	{#if projectGroups.length === 0}
		<div
			class="flex items-center justify-center rounded-lg border border-dashed border-[var(--color-tron-border)] py-16"
		>
			<div class="text-center">
				<p class="tron-text-muted mb-2 text-sm">No tasks yet</p>
				<TronButton variant="primary" onclick={() => (showCreateModal = true)}>
					Create First Task
				</TronButton>
			</div>
		</div>
	{:else}
		{#each projectGroups as group (group.id ?? '__none')}
			{@const isCollapsed = collapsed.has(group.id)}
			{@const grouped = tasksByStatus(group.tasks)}
			{@const statusCounts = columns.map((c) => ({ label: c.label, color: c.color, count: (grouped[c.key] ?? []).length }))}

			<div
				class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]"
			>
				<!-- Project header -->
			<div class="flex items-center">
				<button
					type="button"
					class="flex flex-1 items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--color-tron-bg-tertiary)]"
					onclick={() => toggleCollapse(group.id)}
				>
					<div class="flex items-center gap-3">
						<!-- Collapse chevron -->
						<svg
							class="h-4 w-4 transition-transform duration-200 {isCollapsed
								? '-rotate-90'
								: 'rotate-0'}"
							style="color: {group.color};"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M19 9l-7 7-7-7"
							/>
						</svg>
						<!-- Color dot + name -->
						<span
							class="h-3 w-3 rounded-full"
							style="background: {group.color};"
						></span>
						<span class="text-sm font-bold" style="color: {group.color};">
							{group.name}
						</span>
						<span class="tron-text-muted text-xs">
							({group.tasks.length} task{group.tasks.length !== 1 ? 's' : ''})
						</span>
					</div>

					<!-- Mini status summary when collapsed -->
					{#if isCollapsed}
						<div class="flex items-center gap-2">
							{#each statusCounts as sc}
								{#if sc.count > 0}
									<span
										class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold"
										style="background: {sc.color}15; color: {sc.color};"
									>
										{sc.label}: {sc.count}
									</span>
								{/if}
							{/each}
						</div>
					{/if}
				</button>

				<!-- Per-project new task button -->
				{#if group.id}
					<button
						type="button"
						class="mr-3 flex h-7 w-7 shrink-0 items-center justify-center rounded border border-[var(--color-tron-accent)] text-[var(--color-tron-accent)] transition-all hover:bg-[var(--color-tron-accent)] hover:text-[var(--color-tron-bg)] hover:shadow-[0_0_8px_var(--color-tron-accent)]"
						title="New task in {group.name}"
						aria-label="New task in {group.name}"
						onclick={(e) => { e.stopPropagation(); createModalProjectId = group.id ?? undefined; showCreateModal = true; }}
					>
						<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
						</svg>
					</button>
				{/if}
			</div>

				<!-- Columns (expandable) -->
				{#if !isCollapsed}
					<div
						class="flex gap-4 overflow-x-auto border-t border-[var(--color-tron-border)] px-4 py-4"
						style="min-height: 180px;"
					>
						{#each columns as col}
							<KanbanColumn
								config={col}
								tasks={grouped[col.key] ?? []}
								onDrop={handleDrop}
							/>
						{/each}
					</div>
				{/if}
			</div>
		{/each}
	{/if}
</div>

<!-- Create task modal -->
{#if showCreateModal}
	<CreateTaskModal
		projects={data.projects}
		users={data.users}
		defaultProjectId={createModalProjectId}
		onclose={() => { showCreateModal = false; createModalProjectId = undefined; }}
	/>
{/if}
