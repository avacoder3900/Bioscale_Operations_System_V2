<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	let showCreate = $state(false);
	let creating = $state(false);

	// Create-form phase scoping: a project trains on labeled images from the
	// selected phases, OR on everything as a master model — never both.
	let selectedPhases = $state<string[]>([]);
	let isMasterModel = $state(false);
	let canSubmit = $derived(isMasterModel || selectedPhases.length > 0);
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

	<!-- How a model comes to life — one-line pipeline hint (CV-PIPELINE-V2) -->
	<div class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">
		<span class="font-semibold uppercase tracking-wide text-[var(--color-tron-cyan)]">How a model comes to life</span>
		<span class="opacity-50">·</span>
		<a href="/capture" class="text-[var(--color-tron-cyan)] hover:underline">Capture</a>
		<span>→</span>
		<a href="/cv/label" class="text-[var(--color-tron-cyan)] hover:underline">Label</a>
		<span>→</span>
		<span>Train</span>
		<span>→</span>
		<span>Verify</span>
		<span>→</span>
		<span>Deploy</span>
		<span class="opacity-70">(on the project page)</span>
		<span>→</span>
		<a href="/cv/review" class="text-[var(--color-tron-cyan)] hover:underline">Review</a>
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

				<input type="hidden" name="projectType" value="classification" />

				<fieldset class="rounded border border-[var(--color-tron-border)] p-3">
					<legend class="px-1 text-xs uppercase text-[var(--color-tron-text-secondary)]">
						Training phases <span class="normal-case">— which manufacturing steps' labeled photos this model trains on</span>
					</legend>
					<div class="flex flex-wrap gap-x-4 gap-y-2">
						{#each data.canonicalPhases as ph (ph)}
							<label class="flex items-center gap-1.5 text-sm {isMasterModel ? 'opacity-40' : ''}">
								<input
									type="checkbox"
									name="phases"
									value={ph}
									bind:group={selectedPhases}
									disabled={isMasterModel}
									class="accent-[var(--color-tron-cyan)]"
								/>
								<span class="font-mono text-xs">{ph}</span>
							</label>
						{/each}
					</div>
					<label class="mt-3 flex items-center gap-1.5 border-t border-[var(--color-tron-border)] pt-3 text-sm">
						<input
							type="checkbox"
							name="isMasterModel"
							bind:checked={isMasterModel}
							onchange={() => { if (isMasterModel) selectedPhases = []; }}
							class="accent-[var(--color-tron-cyan)]"
						/>
						<span>Master model — trains on <em>all</em> labeled images, every phase (disables phase selection)</span>
					</label>
					{#if !canSubmit}
						<p class="mt-2 text-xs text-[var(--color-tron-text-secondary)]">Select at least one phase, or check Master model.</p>
					{/if}
				</fieldset>

				<button type="submit" disabled={creating || !canSubmit} class="rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-[var(--color-tron-bg-primary)] disabled:opacity-40">
					{creating ? 'Creating…' : 'Create'}
				</button>
			</form>
		</div>
	{/if}

	{#if data.projects.length === 0}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-12 text-center">
			<p class="text-[var(--color-tron-text-secondary)]">No projects yet.</p>
			<p class="mt-2 text-xs text-[var(--color-tron-text-secondary)]">
				Create a project with the <span class="font-medium text-[var(--color-tron-cyan)]">+ New project</span> button above, then assemble its training set from <a class="text-[var(--color-tron-cyan)] underline" href="/cv/label">/cv/label</a>.
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
							<div class="flex flex-wrap items-center gap-2">
								<h3 class="text-lg font-semibold text-[var(--color-tron-cyan)]">{p.name}</h3>
								{#if p.isMasterModel}
									<span class="rounded border border-[var(--color-tron-cyan)] bg-[rgba(0,255,255,0.10)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--color-tron-cyan)]">Master</span>
								{/if}
							</div>
							{#if p.description}
								<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">{p.description}</p>
							{/if}
							<div class="mt-2 flex flex-wrap gap-2 text-xs">
								{#if p.isMasterModel}
									<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-2 py-0.5">trains on all phases</span>
								{:else if p.phases.length > 0}
									{#each p.phases as ph (ph)}
										<span class="rounded bg-[rgba(0,255,255,0.10)] px-2 py-0.5 font-mono text-[var(--color-tron-cyan)]">trains @ {ph}</span>
									{/each}
								{:else}
									<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-2 py-0.5 text-[var(--color-tron-text-secondary)]">no training phases set</span>
								{/if}
								<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-2 py-0.5">{p.memberCount} member{p.memberCount === 1 ? '' : 's'}</span>
								{#if p.composedOfCount > 0}
									<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-2 py-0.5">+{p.composedOfCount} composed {p.isLiveComposition ? '(live)' : '(snap)'}</span>
								{/if}
								<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-2 py-0.5">{p.trainedModelCount} trained version{p.trainedModelCount === 1 ? '' : 's'}</span>
								{#if p.activeModelVersion}
									<span class="rounded bg-[var(--color-tron-green,#39ff14)] px-2 py-0.5 text-black">deployed: {p.activeModelVersion}</span>
								{:else}
									<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-2 py-0.5 text-[var(--color-tron-text-secondary)]">not deployed</span>
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
