<script lang="ts">
	import { enhance } from '$app/forms';
	import KanbanTaskCard from './KanbanTaskCard.svelte';

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

	interface StatusConfig {
		key: string;
		label: string;
		color: string;
		nextStatus?: string;
		prevStatus?: string;
	}

	interface Props {
		config: StatusConfig;
		tasks: TaskData[];
		onDrop?: (taskId: string, newStatus: string) => void;
	}

	let { config, tasks, onDrop }: Props = $props();
	let dragOver = $state(false);

	function handleDragOver(e: DragEvent) {
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		dragOver = true;
	}

	function handleDragLeave() {
		dragOver = false;
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		const taskId = e.dataTransfer?.getData('text/plain');
		if (taskId && onDrop) {
			onDrop(taskId, config.key);
		}
	}
</script>

<div
	class="flex min-w-[220px] flex-1 flex-col rounded-lg transition-all duration-200"
	class:ring-2={dragOver}
	class:ring-[var(--color-tron-cyan)]={dragOver}
	class:bg-[rgba(0,212,255,0.05)]={dragOver}
	role="listbox"
	aria-label="{config.label} column"
	ondragover={handleDragOver}
	ondragleave={handleDragLeave}
	ondrop={handleDrop}
>
	<!-- Column header -->
	<div
		class="mb-3 flex items-center justify-between rounded-t-lg px-3 py-2"
		style="background: {config.color}15; border-bottom: 2px solid {config.color};"
	>
		<h3 class="text-sm font-bold" style="color: {config.color};">
			{config.label}
		</h3>
		<span
			class="inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded-full px-1.5 text-xs font-bold"
			style="background: {config.color}25; color: {config.color};"
		>
			{tasks.length}
		</span>
	</div>

	<!-- Task cards -->
	<div class="flex flex-1 flex-col gap-2">
		{#each tasks as task (task.id)}
			<div class="group relative">
				<KanbanTaskCard {task} />

				<!-- Move buttons overlay -->
				<div
					class="absolute top-1 right-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100"
				>
					{#if config.prevStatus}
						<form method="POST" action="?/move" use:enhance>
							<input type="hidden" name="taskId" value={task.id} />
							<input type="hidden" name="newStatus" value={config.prevStatus} />
							<button
								type="submit"
								class="flex h-7 w-7 items-center justify-center rounded bg-[var(--color-tron-bg-primary)] text-[var(--color-tron-text-secondary)] shadow transition-colors hover:text-[var(--color-tron-cyan)]"
								title="Move to {config.prevStatus}"
							>
								<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M15 19l-7-7 7-7"
									/>
								</svg>
							</button>
						</form>
					{/if}
					{#if config.nextStatus}
						<form method="POST" action="?/move" use:enhance>
							<input type="hidden" name="taskId" value={task.id} />
							<input type="hidden" name="newStatus" value={config.nextStatus} />
							<button
								type="submit"
								class="flex h-7 w-7 items-center justify-center rounded bg-[var(--color-tron-bg-primary)] text-[var(--color-tron-text-secondary)] shadow transition-colors hover:text-[var(--color-tron-cyan)]"
								title="Move to {config.nextStatus}"
							>
								<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M9 5l7 7-7 7"
									/>
								</svg>
							</button>
						</form>
					{/if}
				</div>
			</div>
		{:else}
			<div
				class="flex flex-1 items-center justify-center rounded-lg border border-dashed border-[var(--color-tron-border)] py-8"
			>
				<p class="tron-text-muted text-xs">No tasks</p>
			</div>
		{/each}
	</div>
</div>
