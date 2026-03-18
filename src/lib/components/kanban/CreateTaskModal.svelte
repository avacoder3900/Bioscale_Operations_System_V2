<script lang="ts">
	import { enhance } from '$app/forms';
	import TronButton from '$lib/components/ui/TronButton.svelte';
	import TronInput from '$lib/components/ui/TronInput.svelte';

	interface Project {
		id: string;
		name: string;
		color: string;
	}

	interface UserItem {
		id: string;
		username: string;
	}

	interface Props {
		projects: Project[];
		users: UserItem[];
		onclose: () => void;
		defaultProjectId?: string;
	}

	let { projects, users, onclose, defaultProjectId }: Props = $props();
	let submitting = $state(false);
	let error = $state('');
</script>

<!-- Backdrop -->
<div
	class="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
	role="dialog"
	aria-modal="true"
>
	<!-- Modal -->
	<div class="tron-card w-full max-w-lg" style="max-height: 90vh; overflow-y: auto;">
		<div class="mb-4 flex items-center justify-between">
			<h2 class="tron-text-primary text-lg font-bold">Create Task</h2>
			<button
				onclick={onclose}
				class="flex h-8 w-8 items-center justify-center rounded text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-red)]"
				title="Close"
			>
				<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M6 18L18 6M6 6l12 12"
					/>
				</svg>
			</button>
		</div>

		{#if error}
			<div
				class="mb-4 rounded border border-[rgba(255,51,102,0.3)] bg-[rgba(255,51,102,0.1)] px-3 py-2 text-sm"
				style="color: var(--color-tron-red);"
			>
				{error}
			</div>
		{/if}

		<form
			method="POST"
			action="?/create"
			use:enhance={() => {
				submitting = true;
				error = '';
				return async ({ result, update }) => {
					submitting = false;
					if (result.type === 'success') {
						onclose();
						await update();
					} else if (result.type === 'failure') {
						error = (result.data as { error?: string })?.error ?? 'Failed to create task';
					}
				};
			}}
		>
			<!-- Title -->
			<div class="mb-4">
				<TronInput label="Title" name="title" placeholder="Task title..." required />
			</div>

			<!-- Description -->
			<div class="mb-4">
				<label for="description" class="tron-label">Description</label>
				<textarea
					id="description"
					name="description"
					class="tron-input w-full"
					rows="3"
					placeholder="Optional description..."
				></textarea>
			</div>

			<!-- Prioritized & Task Length -->
			<div class="mb-4 grid grid-cols-2 gap-4">
				<div class="flex items-end">
					<label class="flex cursor-pointer items-center gap-2">
						<input type="checkbox" name="prioritized" value="true"
							class="h-4 w-4 rounded border-gray-600 bg-gray-800" />
						<span class="text-sm" style="color: var(--color-tron-text-secondary);">★ Prioritized</span>
					</label>
				</div>
				<div>
					<label for="taskLength" class="tron-label">Size</label>
					<select id="taskLength" name="taskLength" class="tron-select w-full">
						<option value="short">Short</option>
						<option value="medium" selected>Medium</option>
						<option value="long">Long</option>
					</select>
				</div>
			</div>

			<!-- Project (required) -->
			<div class="mb-4">
				<label for="projectId" class="tron-label">Project <span style="color: var(--color-tron-red);">*</span></label>
				<select id="projectId" name="projectId" class="tron-select w-full" required>
					<option value="" disabled selected={!defaultProjectId}>Select a project</option>
					{#each projects as project}
						<option value={project.id} selected={defaultProjectId === project.id}>{project.name}</option>
					{/each}
				</select>
			</div>

			<!-- Assigned To -->
			<div class="mb-4">
				<label for="assignedTo" class="tron-label">Assign To</label>
				<select id="assignedTo" name="assignedTo" class="tron-select w-full">
					<option value="">Unassigned</option>
					{#each users as u}
						<option value={u.id}>{u.username}</option>
					{/each}
				</select>
			</div>

			<!-- Due Date -->
			<div class="mb-6">
				<TronInput label="Due Date" name="dueDate" type="date" />
			</div>

			<!-- Actions -->
			<div class="flex justify-end gap-3">
				<TronButton type="button" onclick={onclose}>Cancel</TronButton>
				<TronButton type="submit" variant="primary" disabled={submitting}>
					{submitting ? 'Creating...' : 'Create Task'}
				</TronButton>
			</div>
		</form>
	</div>
</div>
