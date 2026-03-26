<script lang="ts">
	let { data } = $props();
	let showCreate = $state(false);
	let creating = $state(false);
	let createError = $state('');

	const statusColors: Record<string, string> = {
		untrained: 'var(--color-tron-text-secondary)',
		training: 'var(--color-tron-yellow)',
		trained: 'var(--color-tron-green)',
		failed: 'var(--color-tron-red)'
	};

	const typeLabels: Record<string, string> = {
		classification: 'Classification',
		anomaly_detection: 'Anomaly Detection',
		object_detection: 'Object Detection'
	};

	async function handleCreate(e: SubmitEvent) {
		e.preventDefault();
		creating = true;
		createError = '';
		const form = e.target as HTMLFormElement;
		const fd = new FormData(form);

		try {
			const res = await fetch('/api/cv/projects', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: fd.get('name'),
					description: fd.get('description'),
					projectType: fd.get('projectType')
				})
			});
			const json = await res.json();
			if (!res.ok) { createError = json.error; return; }
			window.location.href = `/cv/projects/${json.data._id}`;
		} catch (err: any) {
			createError = err.message;
		} finally {
			creating = false;
		}
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<h2 class="text-2xl font-bold text-[var(--color-tron-cyan)]">CV Projects</h2>
		<button
			class="rounded-lg bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-black hover:opacity-90"
			onclick={() => showCreate = true}
		>
			+ New Project
		</button>
	</div>

	<!-- Stats -->
	<div class="grid grid-cols-2 gap-4 sm:grid-cols-4">
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4 text-center">
			<div class="text-2xl font-bold text-[var(--color-tron-cyan)]">{data.projects.length}</div>
			<div class="text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Projects</div>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4 text-center">
			<div class="text-2xl font-bold text-[var(--color-tron-green)]">{data.projects.filter((p: any) => p.modelStatus === 'trained').length}</div>
			<div class="text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Trained</div>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4 text-center">
			<div class="text-2xl font-bold text-[var(--color-tron-yellow)]">{data.projects.filter((p: any) => p.modelStatus === 'training').length}</div>
			<div class="text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Training</div>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4 text-center">
			<div class="text-2xl font-bold text-[var(--color-tron-text-primary)]">{data.projects.reduce((s: number, p: any) => s + (p.imageCount || 0), 0)}</div>
			<div class="text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Total Images</div>
		</div>
	</div>

	<!-- Project Cards Grid -->
	{#if data.projects.length === 0}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-12 text-center">
			<p class="text-[var(--color-tron-text-secondary)]">No projects yet. Create your first CV project to get started.</p>
		</div>
	{:else}
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{#each data.projects as project (project._id)}
				<a
					href="/cv/projects/{project._id}"
					class="group rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4 transition-all hover:border-[var(--color-tron-cyan)]/50 hover:shadow-[0_0_20px_rgba(0,212,255,0.15)]"
				>
					<div class="mb-3 flex items-start justify-between">
						<h3 class="text-lg font-semibold text-[var(--color-tron-text-primary)] group-hover:text-[var(--color-tron-cyan)]">
							{project.name}
						</h3>
						<span
							class="rounded-full px-2 py-0.5 text-xs font-semibold"
							style="color: {statusColors[project.modelStatus] || statusColors.untrained}; background: color-mix(in srgb, {statusColors[project.modelStatus] || statusColors.untrained} 20%, transparent)"
						>
							{project.modelStatus?.toUpperCase() || 'UNTRAINED'}
						</span>
					</div>

					{#if project.description}
						<p class="mb-3 line-clamp-2 text-sm text-[var(--color-tron-text-secondary)]">{project.description}</p>
					{/if}

					<div class="flex items-center gap-4 text-xs text-[var(--color-tron-text-secondary)]">
						<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-2 py-0.5">
							{typeLabels[project.projectType] || project.projectType || 'Unset'}
						</span>
						<span>{project.imageCount || 0} images</span>
						<span>{project.annotatedCount || 0} labeled</span>
					</div>

					{#if project.tags?.length}
						<div class="mt-2 flex flex-wrap gap-1">
							{#each project.tags.slice(0, 3) as tag}
								<span class="rounded bg-[var(--color-tron-cyan)]/10 px-1.5 py-0.5 text-xs text-[var(--color-tron-cyan)]">{tag}</span>
							{/each}
						</div>
					{/if}
				</a>
			{/each}
		</div>
	{/if}
</div>

<!-- Create Project Modal -->
{#if showCreate}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
		<div class="w-full max-w-lg rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-6">
			<div class="mb-4 flex items-center justify-between">
				<h3 class="text-lg font-bold text-[var(--color-tron-cyan)]">Create Project</h3>
				<button class="text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text-primary)]" onclick={() => showCreate = false}>&times;</button>
			</div>

			{#if createError}
				<div class="mb-4 rounded border border-[var(--color-tron-red)]/30 bg-[var(--color-tron-red)]/10 p-3 text-sm text-[var(--color-tron-red)]">{createError}</div>
			{/if}

			<form onsubmit={handleCreate} class="space-y-4">
				<div>
					<label for="name" class="mb-1 block text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Name *</label>
					<input id="name" name="name" required class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text-primary)] focus:border-[var(--color-tron-cyan)] focus:outline-none" />
				</div>
				<div>
					<label for="description" class="mb-1 block text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Description</label>
					<textarea id="description" name="description" rows="3" class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text-primary)] focus:border-[var(--color-tron-cyan)] focus:outline-none"></textarea>
				</div>
				<div>
					<label for="projectType" class="mb-1 block text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Type *</label>
					<select id="projectType" name="projectType" required class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text-primary)]">
						<option value="">Select type...</option>
						<option value="classification">Classification</option>
						<option value="anomaly_detection">Anomaly Detection</option>
						<option value="object_detection">Object Detection</option>
					</select>
				</div>
				<div class="flex justify-end gap-3 pt-2">
					<button type="button" onclick={() => showCreate = false} class="rounded-lg border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text-primary)]">Cancel</button>
					<button type="submit" disabled={creating} class="rounded-lg bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-black hover:opacity-90 disabled:opacity-50">
						{creating ? 'Creating...' : 'Create Project'}
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}
