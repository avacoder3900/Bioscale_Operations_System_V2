<script lang="ts">
	import { enhance } from '$app/forms';
	import TronButton from '$lib/components/ui/TronButton.svelte';
	import TronInput from '$lib/components/ui/TronInput.svelte';

	let { data, form } = $props();

	let showCreateForm = $state(false);
	let editingId = $state<string | null>(null);
	let submitting = $state(false);
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex flex-wrap items-center justify-between gap-4">
		<div>
			<h2 class="tron-text-primary text-2xl font-bold">Projects</h2>
			<p class="tron-text-muted text-sm">
				{data.allProjects.length} project{data.allProjects.length !== 1 ? 's' : ''}
			</p>
		</div>
		<TronButton variant="primary" onclick={() => (showCreateForm = !showCreateForm)}>
			<span class="flex items-center gap-2">
				<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M12 4v16m8-8H4"
					/>
				</svg>
				New Project
			</span>
		</TronButton>
	</div>

	<!-- Error/Success messages -->
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
			Changes saved.
		</div>
	{/if}

	<!-- Create form -->
	{#if showCreateForm}
		<div class="tron-card">
			<h3 class="tron-text-primary mb-4 text-lg font-bold">Create Project</h3>
			<form
				method="POST"
				action="?/create"
				use:enhance={() => {
					submitting = true;
					return async ({ result, update }) => {
						submitting = false;
						if (result.type === 'success') {
							showCreateForm = false;
						}
						await update();
					};
				}}
			>
				<div class="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
					<TronInput label="Project Name" name="name" placeholder="Project name..." required />
					<div>
						<label for="create-color" class="tron-label">Color</label>
						<div class="flex items-center gap-3">
							<input
								id="create-color"
								type="color"
								name="color"
								value="#00d4ff"
								class="h-10 w-14 cursor-pointer rounded border border-[var(--color-tron-border)] bg-transparent"
							/>
							<span class="tron-text-muted text-xs">Pick a project color</span>
						</div>
					</div>
				</div>
				<div class="mb-4">
					<label for="create-description" class="tron-label">Description</label>
					<textarea
						id="create-description"
						name="description"
						class="tron-input w-full"
						rows="2"
						placeholder="Optional description..."
					></textarea>
				</div>
				<div class="flex gap-3">
					<TronButton type="submit" variant="primary" disabled={submitting}>
						{submitting ? 'Creating...' : 'Create Project'}
					</TronButton>
					<TronButton type="button" onclick={() => (showCreateForm = false)}>Cancel</TronButton>
				</div>
			</form>
		</div>
	{/if}

	<!-- Projects list -->
	<div class="space-y-3">
		{#each data.allProjects as project (project.id)}
			<div
				class="tron-card flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
				style="border-left: 4px solid {project.color};"
			>
				{#if editingId === project.id}
					<!-- Edit form -->
					<form
						method="POST"
						action="?/update"
						class="flex w-full flex-col gap-4 sm:flex-row sm:items-end"
						use:enhance={() => {
							submitting = true;
							return async ({ result, update }) => {
								submitting = false;
								if (result.type === 'success') {
									editingId = null;
								}
								await update();
							};
						}}
					>
						<input type="hidden" name="projectId" value={project.id} />
						<div class="flex-1">
							<TronInput label="Name" name="name" value={project.name} required />
						</div>
						<div class="flex-1">
							<label for="edit-desc-{project.id}" class="tron-label">Description</label>
							<input
								id="edit-desc-{project.id}"
								name="description"
								class="tron-input w-full"
								value={project.description ?? ''}
								placeholder="Description..."
							/>
						</div>
						<div>
							<label for="edit-color-{project.id}" class="tron-label">Color</label>
							<input
								id="edit-color-{project.id}"
								type="color"
								name="color"
								value={project.color}
								class="h-10 w-14 cursor-pointer rounded border border-[var(--color-tron-border)] bg-transparent"
							/>
						</div>
						<div class="flex gap-2">
							<TronButton type="submit" variant="primary" disabled={submitting}>Save</TronButton>
							<TronButton type="button" onclick={() => (editingId = null)}>Cancel</TronButton>
						</div>
					</form>
				{:else}
					<!-- Display mode -->
					<div class="flex items-center gap-3">
						<div class="h-4 w-4 rounded-full" style="background: {project.color};"></div>
						<div>
							<h4 class="tron-text-primary font-medium">
								{project.name}
								{#if !project.isActive}
									<span class="tron-text-muted ml-2 text-xs">(inactive)</span>
								{/if}
							</h4>
							{#if project.description}
								<p class="tron-text-muted text-xs">{project.description}</p>
							{/if}
						</div>
					</div>
					<div class="flex items-center gap-2">
						<TronButton onclick={() => (editingId = project.id)}>
							<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
								/>
							</svg>
						</TronButton>
						<form method="POST" action="?/toggleActive" use:enhance>
							<input type="hidden" name="projectId" value={project.id} />
							<input type="hidden" name="isActive" value={project.isActive ? 'false' : 'true'} />
							<TronButton type="submit" variant={project.isActive ? 'danger' : 'primary'}>
								{project.isActive ? 'Deactivate' : 'Activate'}
							</TronButton>
						</form>
					</div>
				{/if}
			</div>
		{:else}
			<div class="tron-card text-center">
				<p class="tron-text-muted py-8 text-sm">
					No projects yet. Create one to organize your tasks.
				</p>
			</div>
		{/each}
	</div>
</div>
