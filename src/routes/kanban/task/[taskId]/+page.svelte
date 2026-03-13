<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import TronButton from '$lib/components/ui/TronButton.svelte';
	import TronInput from '$lib/components/ui/TronInput.svelte';
	import TaskStatusBadge from '$lib/components/kanban/TaskStatusBadge.svelte';
	import PriorityBadge from '$lib/components/kanban/PriorityBadge.svelte';
	import CommentList from '$lib/components/kanban/CommentList.svelte';
	import TagPicker from '$lib/components/kanban/TagPicker.svelte';
	import ActivityLog from '$lib/components/kanban/ActivityLog.svelte';

	let { data, form } = $props();

	let saving = $state(false);
	let archiving = $state(false);

	const statusFlow: Record<string, { prev?: string; next?: string }> = {
		backlog: { next: 'ready' },
		ready: { prev: 'backlog', next: 'wip' },
		wip: { prev: 'ready', next: 'waiting' },
		waiting: { prev: 'wip', next: 'wip' },
		done: {}
	};

	const statusLabels: Record<string, string> = {
		backlog: 'Backlog',
		ready: 'Ready',
		wip: 'WIP',
		waiting: 'Waiting',
		done: 'Done'
	};

	let flow = $derived(statusFlow[data.task.status] ?? {});

	let dueDateValue = $derived.by(() => {
		if (!data.task.dueDate) return '';
		const d = new Date(data.task.dueDate);
		return d.toISOString().split('T')[0];
	});

	let selectedTagIds = $derived(data.taskTags.map((t: { id: string }) => t.id));

	function formatDate(date: Date | string | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
	}
</script>

<div class="space-y-6">
	<!-- Breadcrumb -->
	<div class="flex items-center gap-3">
		<a
			href="/kanban"
			class="flex items-center gap-1 text-sm text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-cyan)]"
		>
			<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
			</svg>
			Back to Board
		</a>
		<span class="tron-text-muted text-sm">/</span>
		<span class="tron-text-muted text-sm">Task Detail</span>
	</div>

	<!-- Messages -->
	{#if form?.error}
		<div
			class="rounded border border-[rgba(255,51,102,0.3)] bg-[rgba(255,51,102,0.1)] px-4 py-3 text-sm"
			style="color: var(--color-tron-red);"
		>
			{form.error}
		</div>
	{/if}
	{#if form?.success}
		<div
			class="rounded border border-[rgba(0,255,136,0.3)] bg-[rgba(0,255,136,0.1)] px-4 py-3 text-sm"
			style="color: var(--color-tron-green);"
		>
			Changes saved successfully.
		</div>
	{/if}

	<div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
		<!-- Left column: main form -->
		<div class="lg:col-span-2">
			<div class="tron-card">
				<!-- Status & actions header -->
				<div class="mb-6 flex flex-wrap items-center justify-between gap-3">
					<div class="flex items-center gap-3">
						<TaskStatusBadge status={data.task.status} />
						{#if data.task.projectName}
							<span
								class="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium"
								style="background: {data.task.projectColor}20; color: {data.task.projectColor};"
							>
								<span class="h-2 w-2 rounded-full" style="background: {data.task.projectColor};"
								></span>
								{data.task.projectName}
							</span>
						{/if}
					</div>
					<div class="flex items-center gap-2">
						{#if flow.prev}
							<form method="POST" action="?/move" use:enhance>
								<input type="hidden" name="taskId" value={data.task.id} />
								<input type="hidden" name="newStatus" value={flow.prev} />
								<TronButton type="submit">
									<span class="flex items-center gap-1">
										<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
											<path
												stroke-linecap="round"
												stroke-linejoin="round"
												stroke-width="2"
												d="M15 19l-7-7 7-7"
											/>
										</svg>
										{statusLabels[flow.prev] ?? flow.prev}
									</span>
								</TronButton>
							</form>
						{/if}
						{#if flow.next}
							<form method="POST" action="?/move" use:enhance>
								<input type="hidden" name="taskId" value={data.task.id} />
								<input type="hidden" name="newStatus" value={flow.next} />
								<TronButton type="submit" variant="primary">
									<span class="flex items-center gap-1">
										{statusLabels[flow.next] ?? flow.next}
										<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
											<path
												stroke-linecap="round"
												stroke-linejoin="round"
												stroke-width="2"
												d="M9 5l7 7-7 7"
											/>
										</svg>
									</span>
								</TronButton>
							</form>
						{/if}
						{#if data.task.status === 'done'}
							<TronButton variant="primary" disabled>Completed</TronButton>
						{/if}
					</div>
				</div>

				<!-- Edit form -->
				<form
					method="POST"
					action="?/update"
					use:enhance={() => {
						saving = true;
						return async ({ update }) => {
							saving = false;
							await update();
						};
					}}
				>
					<div class="mb-4">
						<TronInput
							label="Title"
							name="title"
							value={data.task.title}
							placeholder="Task title..."
							required
						/>
					</div>

					<div class="mb-4">
						<label for="description" class="tron-label">Description</label>
						<textarea
							id="description"
							name="description"
							class="tron-input w-full"
							rows="4"
							placeholder="Task description...">{data.task.description ?? ''}</textarea
						>
					</div>

					<div class="mb-4 grid grid-cols-2 gap-4">
						<div>
							<label class="tron-label">Priority</label>
							<label class="flex cursor-pointer items-center gap-2 pt-2">
								<input
									type="checkbox"
									name="prioritized"
									value="true"
									checked={data.task.prioritized}
									class="h-4 w-4 rounded"
								/>
								<span class="text-sm" style="color: var(--color-tron-text);">Prioritized</span>
							</label>
						</div>
						<div>
							<label for="taskLength" class="tron-label">Size</label>
							<select
								id="taskLength"
								name="taskLength"
								class="tron-select w-full"
								value={data.task.taskLength}
							>
								<option value="short">Short</option>
								<option value="medium">Medium</option>
								<option value="long">Long</option>
							</select>
						</div>
					</div>

					<div class="mb-4">
						<label for="projectId" class="tron-label">Project</label>
						<select
							id="projectId"
							name="projectId"
							class="tron-select w-full"
							value={data.task.projectId ?? ''}
						>
							<option value="">No project</option>
							{#each data.projects as project}
								<option value={project.id}>{project.name}</option>
							{/each}
						</select>
					</div>

					<div class="mb-4">
						<label for="assignedTo" class="tron-label">Assign To</label>
						<select
							id="assignedTo"
							name="assignedTo"
							class="tron-select w-full"
							value={data.task.assignedTo ?? ''}
						>
							<option value="">Unassigned</option>
							{#each data.users as u}
								<option value={u.id}>{u.username}</option>
							{/each}
						</select>
					</div>

					<div class="mb-4">
						<TronInput label="Due Date" name="dueDate" type="date" value={dueDateValue} />
					</div>

					{#if data.task.status === 'waiting'}
						<div
							class="mb-4 rounded border border-[rgba(255,51,102,0.3)] bg-[rgba(255,51,102,0.05)] p-4"
						>
							<h3 class="mb-3 text-sm font-bold" style="color: var(--color-tron-red);">
								Waiting Details
							</h3>
							<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
								<div>
									<TronInput
										label="Waiting Reason"
										name="waitingReason"
										value={data.task.waitingReason ?? ''}
										placeholder="Why is this blocked?"
									/>
								</div>
								<div>
									<TronInput
										label="Waiting On"
										name="waitingOn"
										value={data.task.waitingOn ?? ''}
										placeholder="Person or thing..."
									/>
								</div>
							</div>
						</div>
					{:else}
						<input type="hidden" name="waitingReason" value={data.task.waitingReason ?? ''} />
						<input type="hidden" name="waitingOn" value={data.task.waitingOn ?? ''} />
					{/if}

					<div class="flex items-center justify-between">
						<TronButton type="submit" variant="primary" disabled={saving}>
							{saving ? 'Saving...' : 'Save Changes'}
						</TronButton>
					</div>
				</form>

				<!-- Archive -->
				<div class="mt-4 flex justify-end border-t border-[var(--color-tron-border)] pt-4">
					<form
						method="POST"
						action="?/archive"
						use:enhance={() => {
							archiving = true;
							return async ({ result, update }) => {
								archiving = false;
								if (result.type === 'success') {
									goto('/kanban');
								} else {
									await update();
								}
							};
						}}
					>
						<input type="hidden" name="taskId" value={data.task.id} />
						<TronButton type="submit" variant="danger" disabled={archiving}>
							{archiving ? 'Archiving...' : 'Archive Task'}
						</TronButton>
					</form>
				</div>
			</div>
		</div>

		<!-- Right column: metadata + tags + comments + activity -->
		<div class="space-y-6">
			<!-- Task metadata -->
			<div class="tron-card">
				<h3 class="tron-text-primary mb-4 text-sm font-bold">Task Info</h3>
				<dl class="space-y-3 text-sm">
					<div class="flex justify-between">
						<dt class="tron-text-muted">Status</dt>
						<dd><TaskStatusBadge status={data.task.status} /></dd>
					</div>
					<div class="flex justify-between">
						<dt class="tron-text-muted">Priority</dt>
						<dd><PriorityBadge prioritized={data.task.prioritized} /></dd>
					</div>
					<div class="flex justify-between">
						<dt class="tron-text-muted">Size</dt>
						<dd class="tron-text-primary">
							{{ short: 'Short', medium: 'Medium', long: 'Long' }[data.task.taskLength] ??
								data.task.taskLength}
						</dd>
					</div>
					{#if data.task.assigneeName}
						<div class="flex justify-between">
							<dt class="tron-text-muted">Assigned To</dt>
							<dd style="color: var(--color-tron-cyan);">{data.task.assigneeName}</dd>
						</div>
					{/if}
					<div class="flex justify-between">
						<dt class="tron-text-muted">Created</dt>
						<dd class="tron-text-primary">{formatDate(data.task.createdAt)}</dd>
					</div>
					<div class="flex justify-between">
						<dt class="tron-text-muted">Updated</dt>
						<dd class="tron-text-primary">{formatDate(data.task.updatedAt)}</dd>
					</div>
					{#if data.task.statusChangedAt}
						<div class="flex justify-between">
							<dt class="tron-text-muted">Status Changed</dt>
							<dd class="tron-text-primary">{formatDate(data.task.statusChangedAt)}</dd>
						</div>
					{/if}
					{#if data.task.completedDate}
						<div class="flex justify-between">
							<dt class="tron-text-muted">Completed</dt>
							<dd style="color: var(--color-tron-green);">
								{formatDate(data.task.completedDate)}
							</dd>
						</div>
					{/if}
				</dl>
			</div>

			<!-- Tags -->
			<div class="tron-card">
				<h3 class="tron-text-primary mb-3 text-sm font-bold">Tags</h3>
				<TagPicker allTags={data.allTags} {selectedTagIds} taskId={data.task.id} />
			</div>

			<!-- Comments -->
			<div class="tron-card">
				<h3 class="tron-text-primary mb-4 text-sm font-bold">
					Comments ({data.comments.length})
				</h3>
				<CommentList comments={data.comments} taskId={data.task.id} />
			</div>

			<!-- Activity Log -->
			<div class="tron-card">
				<h3 class="tron-text-primary mb-4 text-sm font-bold">Activity</h3>
				<ActivityLog entries={data.activityLog} />
			</div>
		</div>
	</div>
</div>
