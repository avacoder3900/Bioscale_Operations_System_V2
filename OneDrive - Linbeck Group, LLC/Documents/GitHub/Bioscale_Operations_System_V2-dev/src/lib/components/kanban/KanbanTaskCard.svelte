<script lang="ts">
	import PriorityBadge from './PriorityBadge.svelte';

	interface TagInfo {
		id: string;
		name: string;
		color: string;
	}

	interface TaskData {
		id: string;
		title: string;
		description: string | null;
		status: string;
		prioritized: boolean;
		taskLength: string;
		assignedTo: string | null;
		assigneeName: string | null;
		projectId: string | null;
		projectName: string | null;
		projectColor: string | null;
		dueDate: Date | string | null;
		waitingReason: string | null;
		waitingOn: string | null;
		tags?: TagInfo[];
		source?: string | null;
		daysInStatus?: number;
	}

	interface Props {
		task: TaskData;
	}

	let { task }: Props = $props();

	let isOverdue = $derived.by(() => {
		if (!task.dueDate) return false;
		const due = new Date(task.dueDate);
		return due < new Date() && task.status !== 'done';
	});

	let dueDateLabel = $derived.by(() => {
		if (!task.dueDate) return null;
		const due = new Date(task.dueDate);
		return due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
	});

	// Source badge config
	const sourceBadges: Record<string, { icon: string; label: string }> = {
		'operations-trigger': { icon: '🤖', label: 'ops' },
		telegram: { icon: '💬', label: 'telegram' },
		'meeting-synthesis': { icon: '🎙️', label: 'meeting' },
		agent: { icon: '🔧', label: 'agent' }
	};

	let sourceBadge = $derived(task.source && task.source !== 'manual' ? sourceBadges[task.source] ?? null : null);

	// Aging thresholds by status
	const agingThresholds: Record<string, { warning: number; critical: number }> = {
		backlog: { warning: 14, critical: 30 },
		ready: { warning: 5, critical: 10 },
		wip: { warning: 3, critical: 7 },
		waiting: { warning: 3, critical: 7 }
	};

	let agingSeverity = $derived.by(() => {
		if (task.status === 'done' || task.daysInStatus == null) return null;
		const thresholds = agingThresholds[task.status];
		if (!thresholds) return null;
		if (task.daysInStatus > thresholds.critical) return 'critical';
		if (task.daysInStatus > thresholds.warning) return 'warning';
		return null;
	});

	let agingBorderColor = $derived(
		agingSeverity === 'critical' ? '#ef4444' : agingSeverity === 'warning' ? '#f59e0b' : null
	);

	const lengthLabels: Record<string, string> = {
		short: 'S',
		medium: 'M',
		long: 'L'
	};

	let dragging = $state(false);

	function handleDragStart(e: DragEvent) {
		if (e.dataTransfer) {
			e.dataTransfer.setData('text/plain', task.id);
			e.dataTransfer.effectAllowed = 'move';
		}
		dragging = true;
	}

	function handleDragEnd() {
		dragging = false;
	}
</script>

<a
	href="/kanban/task/{task.id}"
	class="tron-card group block cursor-pointer transition-all duration-200 hover:border-[var(--color-tron-cyan)]"
	class:opacity-50={dragging}
	style="padding: 0.75rem; text-decoration: none;{agingBorderColor ? ` border-left: 3px solid ${agingBorderColor};` : ''}"
	draggable="true"
	ondragstart={handleDragStart}
	ondragend={handleDragEnd}
>
	<!-- Project indicator bar -->
	{#if task.projectColor}
		<div
			class="mb-2 h-1 w-full rounded-full"
			style="background: {task.projectColor};"
			title={task.projectName ?? ''}
		></div>
	{/if}

	<!-- Title row -->
	<div class="mb-2 flex items-start justify-between gap-2">
		<h4 class="tron-text-primary text-sm leading-tight font-medium">{task.title}</h4>
		<PriorityBadge prioritized={task.prioritized} />
	</div>

	<!-- Description preview -->
	{#if task.description}
		<p class="tron-text-muted mb-2 line-clamp-2 text-xs">{task.description}</p>
	{/if}

	<!-- Tags -->
	{#if task.tags && task.tags.length > 0}
		<div class="mb-2 flex flex-wrap gap-1">
			{#each task.tags as tag (tag.id)}
				<span
					class="rounded-full px-1.5 py-0.5 text-[10px] font-medium"
					style="background: {tag.color}25; color: {tag.color};"
				>
					{tag.name}
				</span>
			{/each}
		</div>
	{/if}

	<!-- Waiting info -->
	{#if task.status === 'waiting' && task.waitingReason}
		<div
			class="mb-2 rounded border border-[rgba(255,51,102,0.3)] bg-[rgba(255,51,102,0.08)] px-2 py-1"
		>
			<p class="text-xs" style="color: var(--color-tron-red);">
				Waiting: {task.waitingReason}
				{#if task.waitingOn}
					(on {task.waitingOn})
				{/if}
			</p>
		</div>
	{/if}

	<!-- Source badge + aging badge -->
	{#if sourceBadge || agingSeverity === 'critical'}
		<div class="mb-2 flex flex-wrap items-center gap-1">
			{#if sourceBadge}
				<span
					class="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
					style="background: rgba(0, 212, 255, 0.1); color: var(--color-tron-text-secondary); border: 1px solid rgba(0, 212, 255, 0.2);"
				>
					{sourceBadge.icon} {sourceBadge.label}
				</span>
			{/if}
			{#if agingSeverity === 'critical' && task.daysInStatus != null}
				<span
					class="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold"
					style="background: rgba(239, 68, 68, 0.15); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.3);"
				>
					⏰ {task.daysInStatus}d
				</span>
			{/if}
		</div>
	{/if}

	<!-- Footer row: assignee, due date, task length -->
	<div class="flex items-center justify-between gap-2">
		<div class="flex items-center gap-2">
			<!-- Assignee -->
			{#if task.assigneeName}
				<span
					class="inline-flex h-6 items-center rounded bg-[var(--color-tron-bg-tertiary)] px-2 text-xs"
					style="color: var(--color-tron-cyan);"
					title={task.assigneeName}
				>
					{task.assigneeName.slice(0, 8)}
				</span>
			{/if}

			<!-- Task length -->
			<span
				class="tron-text-muted inline-flex h-6 w-6 items-center justify-center rounded bg-[var(--color-tron-bg-tertiary)] text-xs"
				title="Task size: {task.taskLength}"
			>
				{lengthLabels[task.taskLength] ?? 'M'}
			</span>
		</div>

		<!-- Due date -->
		{#if dueDateLabel}
			<span
				class="text-xs {isOverdue ? '' : 'tron-text-muted'}"
				style={isOverdue ? 'color: var(--color-tron-red);' : ''}
			>
				{dueDateLabel}
			</span>
		{/if}
	</div>
</a>
