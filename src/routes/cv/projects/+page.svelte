<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	let showCreate = $state(false);
	let creating = $state(false);
</script>

<div class="space-y-4">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold text-[var(--color-tron-cyan)]">Projects</h1>
			<p class="text-sm text-[var(--color-tron-text-secondary)]">
				Training sets and deployable models. A project is a collection of cartridge images plus the
				model trained on them.
			</p>
		</div>
		<button
			type="button"
			onclick={() => (showCreate = !showCreate)}
			class="rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-[var(--color-tron-bg-primary)]"
		>
			{showCreate ? 'Cancel' : '+ New project'}
		</button>
	</div>

	{#if form?.error}
		<div class="rounded border border-[var(--color-tron-red,#ff3366)] bg-[rgba(255,51,102,0.08)] p-3 text-sm text-[var(--color-tron-red,#ff3366)]">
			{form.error}
		</div>
	{/if}

	{#if showCreate}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			<form
				method="POST"
				action="?/create"
				use:enhance={() => {
					creating = true;
					return async ({ update }) => {
						await update();
						creating = false;
					};
				}}
				class="space-y-3"
			>
				<div>
					<label for="np-name" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">Name</label>
					<input id="np-name" name="name" type="text" required placeholder="e.g. Wax Fill QC" class="tron-input w-full" />
				</div>
				<div>
					<label for="np-desc" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">Description</label>
					<input id="np-desc" name="description" type="text" placeholder="What this project covers" class="tron-input w-full" />
				</div>
				<div>
					<label for="np-purp" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">Purpose</label>
					<input id="np-purp" name="purpose" type="text" placeholder="What problem this model is for" class="tron-input w-full" />
				</div>
				<button type="submit" disabled={creating} class="rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-[var(--color-tron-bg-primary)] disabled:opacity-40">
					{creating ? 'Creating…' : 'Create'}
				</button>
			</form>
		</div>
	{/if}

	{#if data.projects.length === 0}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-12 text-center">
			<p class="text-[var(--color-tron-text-secondary)]">No projects yet.</p>
			<p class="mt-2 text-xs text-[var(--color-tron-text-secondary)]">
				Create a project, then assemble its training set from <a class="text-[var(--color-tron-cyan)] underline" href="/cv/label">/cv/label</a>.
			</p>
		</div>
	{:else}
		<div class="grid gap-3">
			{#each data.projects as p (p.id)}
				<a
					href={`/cv/projects/${p.id}`}
					class="block rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4 transition-colors hover:border-[var(--color-tron-cyan)]"
				>
					<div class="flex flex-wrap items-start justify-between gap-3">
						<div class="min-w-0 flex-1">
							<h3 class="text-lg font-semibold text-[var(--color-tron-cyan)]">{p.name}</h3>
							{#if p.description}
								<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">{p.description}</p>
							{/if}
							<div class="mt-2 flex flex-wrap gap-2 text-xs">
								<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-2 py-0.5">{p.memberCount} member{p.memberCount === 1 ? '' : 's'}</span>
								{#if p.composedOfCount > 0}
									<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-2 py-0.5">+{p.composedOfCount} composed {p.isLiveComposition ? '(live)' : '(snap)'}</span>
								{/if}
								{#if p.trainedModelCount > 0}
									<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-2 py-0.5">{p.trainedModelCount} version{p.trainedModelCount === 1 ? '' : 's'}</span>
								{/if}
								{#if p.activeModelVersion}
									<span class="rounded bg-[var(--color-tron-green,#39ff14)] px-2 py-0.5 text-black">active: {p.activeModelVersion}</span>
								{:else}
									<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-2 py-0.5 text-[var(--color-tron-text-secondary)]">no active model</span>
								{/if}
								{#if p.shadowModelVersion}
									<span class="rounded bg-[rgba(0,255,255,0.15)] px-2 py-0.5 text-[var(--color-tron-cyan)]">shadow: {p.shadowModelVersion}</span>
								{/if}
								{#each p.deployAtPhases as ph (ph)}
									<span class="rounded bg-[rgba(57,255,20,0.10)] px-2 py-0.5 text-[var(--color-tron-green,#39ff14)]">deploys @ {ph}</span>
								{/each}
							</div>
						</div>
						<div class="text-right text-xs text-[var(--color-tron-text-secondary)]">
							{p.updatedAt ? new Date(p.updatedAt).toLocaleDateString() : '—'}
						</div>
					</div>
				</a>
			{/each}
		</div>
	{/if}
</div>
