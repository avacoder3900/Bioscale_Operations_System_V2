<script lang="ts">
	import { invalidate, invalidateAll } from '$app/navigation';
	import TronButton from '$lib/components/ui/TronButton.svelte';
	import KanbanColumn from '$lib/components/kanban/KanbanColumn.svelte';
	import CreateTaskModal from '$lib/components/kanban/CreateTaskModal.svelte';
	import WipLimitModal from '$lib/components/kanban/WipLimitModal.svelte';

	let { data, form } = $props();
	let showCreateModal = $state(false);
	let dragError = $state('');
	let showMyTasks = $state(false);
	let wipLimitInfo = $state<{
		assignee: string;
		assigneeId: string;
		limit: number;
		currentCount: number;
		currentTasks: { _id: string; title: string }[];
	} | null>(null);

	// Surface WIP-limit blocks from form actions (arrow buttons).
	$effect(() => {
		const err = (form as any)?.wipLimitError;
		if (err && err.kind === 'wip_limit_exceeded') wipLimitInfo = err;
	});

	// Filter tasks based on toggle
	let filteredTasks = $derived(
		showMyTasks ? data.tasks.filter((t) => t.assignedTo === data.currentUserId) : data.tasks
	);

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

		for (const task of filteredTasks) {
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

	/**
	 * Project section + backlog accordion collapse state are both persisted
	 * server-side on KanbanProject (collapsed / backlogCollapsed fields).
	 * Global state: every user sees and writes the same value. Optimistic
	 * update + revert on API failure.
	 *
	 * Defaults from server-side normalization:
	 *   - collapsed: false (project sections start expanded)
	 *   - backlogCollapsed: true (backlogs start collapsed)
	 */
	let collapsed = $state(new Set<string | null>(
		data.projects.filter((p) => p.collapsed).map((p) => p.id)
	));

	let collapsedBacklogs = $state(new Set<string | null>(
		data.projects.filter((p) => p.backlogCollapsed).map((p) => p.id)
	));

	async function persistProjectUiState(
		projectId: string,
		payload: { collapsed?: boolean; backlogCollapsed?: boolean }
	): Promise<boolean> {
		const url = `/api/kanban/projects/${projectId}/ui-state`;
		const opts: RequestInit = {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
			// Survive page unload — fold a bunch of chevrons then navigate away
			// and the in-flight POSTs still complete instead of getting dropped.
			keepalive: true
		};

		try {
			const res = await fetch(url, opts);
			if (res.ok) {
				// Refresh the layout's cached projects so sibling-route navigation
				// (/kanban → /kanban/list → /kanban) sees the new value.
				invalidate('kanban:projects');
				return true;
			}
			// 4xx won't be fixed by retry (auth, validation). 5xx might be a
			// Vercel cold-start or transient blip — fall through to retry.
			if (res.status < 500) return false;
		} catch {
			// Network error — fall through to retry.
		}

		await new Promise((r) => setTimeout(r, 500));
		try {
			const res = await fetch(url, opts);
			if (res.ok) {
				invalidate('kanban:projects');
				return true;
			}
			return false;
		} catch {
			return false;
		}
	}

	async function toggleCollapse(projectId: string | null) {
		if (projectId === null) return;
		const wasCollapsed = collapsed.has(projectId);
		const newState = !wasCollapsed;

		const next = new Set(collapsed);
		if (newState) next.add(projectId);
		else next.delete(projectId);
		collapsed = next;

		const ok = await persistProjectUiState(projectId, { collapsed: newState });
		if (!ok) {
			const revert = new Set(collapsed);
			if (wasCollapsed) revert.add(projectId);
			else revert.delete(projectId);
			collapsed = revert;
		}
	}

	async function toggleBacklog(projectId: string | null) {
		if (projectId === null) return;
		const wasCollapsed = collapsedBacklogs.has(projectId);
		const newState = !wasCollapsed;

		const next = new Set(collapsedBacklogs);
		if (newState) next.add(projectId);
		else next.delete(projectId);
		collapsedBacklogs = next;

		const ok = await persistProjectUiState(projectId, { backlogCollapsed: newState });
		if (!ok) {
			const revert = new Set(collapsedBacklogs);
			if (wasCollapsed) revert.add(projectId);
			else revert.delete(projectId);
			collapsedBacklogs = revert;
		}
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
			if (res.status === 409 && result.kind === 'wip_limit_exceeded') {
				wipLimitInfo = result;
				return;
			}
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
				{filteredTasks.length} task{filteredTasks.length !== 1 ? 's' : ''}{showMyTasks ? ' assigned to you' : ''} across {data.projects.length} project{data.projects.length !== 1 ? 's' : ''}
			</p>
		</div>

		<div class="flex items-center gap-3">
			<!-- My Tasks / All Tasks toggle -->
			<button
				type="button"
				class="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-all {showMyTasks
					? 'border-[var(--color-tron-cyan)] bg-[rgba(0,212,255,0.15)] text-[var(--color-tron-cyan)] shadow-[0_0_10px_rgba(0,212,255,0.2)]'
					: 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]'}"
				onclick={() => (showMyTasks = !showMyTasks)}
			>
				<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
						d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
				</svg>
				{showMyTasks ? 'My Tasks' : 'All Tasks'}
			</button>

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
								collapsible={col.key === 'backlog'}
								collapsed={col.key === 'backlog' && collapsedBacklogs.has(group.id)}
								onToggleCollapse={col.key === 'backlog' ? () => toggleBacklog(group.id) : undefined}
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

<!-- WIP limit hit modal -->
{#if wipLimitInfo}
	<WipLimitModal info={wipLimitInfo} onclose={() => (wipLimitInfo = null)} />
{/if}
