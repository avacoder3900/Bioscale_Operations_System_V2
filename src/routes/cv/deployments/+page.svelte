<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	let submitting = $state(false);

	const enhanceSubmit = () => {
		submitting = true;
		return async ({ update }: { update: () => Promise<void> }) => {
			await update();
			submitting = false;
		};
	};

	// Projects deploying at a phase / available to add there.
	function deployedAt(phase: string) {
		return data.projects.filter((p: any) => p.phases.includes(phase));
	}
	function availableFor(phase: string) {
		return data.projects.filter((p: any) => !p.phases.includes(phase));
	}

	function fmtAcc(v: number | null) {
		return v == null ? '—' : `${Math.round(v * 100)}%`;
	}
</script>

<svelte:head>
	<title>Stage Models — Computer Vision</title>
</svelte:head>

<div class="space-y-6">
	<header>
		<h2 class="tron-heading text-2xl font-bold text-[var(--color-tron-cyan)]">Stage Models</h2>
		<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
			Which model grades photos at each manufacturing stage. A capture at a stage runs every model
			deployed there (if it has an active version). Manage versions and training on each
			<a href="/cv/projects" class="text-[var(--color-tron-cyan)] hover:underline">model's page</a>.
		</p>
	</header>

	{#if form?.error}
		<div class="rounded border border-[var(--color-tron-red,#ff3366)] bg-[rgba(255,51,102,0.08)] p-3 text-sm text-[var(--color-tron-red,#ff3366)]">{form.error}</div>
	{/if}
	{#if form?.success}
		<div class="rounded border border-[var(--color-tron-green,#39ff14)] bg-[rgba(57,255,20,0.08)] p-3 text-sm text-[var(--color-tron-green,#39ff14)]">{form.message}</div>
	{/if}

	{#if data.phases.length === 0}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-12 text-center text-[var(--color-tron-text-secondary)]">
			No stages observed yet — stages appear here once photos are captured or a model declares its phases.
		</div>
	{/if}

	<div class="grid gap-4">
		{#each data.phases as phase (phase)}
			{@const deployed = deployedAt(phase)}
			{@const available = availableFor(phase)}
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
				<div class="flex flex-wrap items-center justify-between gap-2">
					<h3 class="font-mono text-lg font-semibold text-[var(--color-tron-cyan)]">{phase}</h3>
					<a
						href={`/cv/stream?phase=${encodeURIComponent(phase)}&review=reviewed`}
						class="text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)] hover:underline"
					>view photos →</a>
				</div>

				{#if deployed.length === 0}
					<p class="mt-2 text-sm text-[var(--color-tron-text-secondary)]">
						No model deployed — captures at this stage save without inference.
					</p>
				{:else}
					<div class="mt-3 space-y-2">
						{#each deployed as p (p.id)}
							<div class="flex flex-wrap items-center gap-3 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] p-3">
								<a href={`/cv/projects/${p.id}`} class="min-w-32 font-medium text-[var(--color-tron-cyan)] hover:underline">{p.name}</a>

								{#if p.versions.length === 0}
									<span class="text-xs text-[var(--color-tron-text-secondary)]">untrained — <a href={`/cv/projects/${p.id}`} class="text-[var(--color-tron-cyan)] hover:underline">train it</a></span>
								{:else}
									<form method="POST" action="?/setActive" use:enhance={enhanceSubmit} class="flex items-center gap-2">
										<input type="hidden" name="projectId" value={p.id} />
										<label for={`ver-${phase}-${p.id}`} class="text-xs uppercase text-[var(--color-tron-text-secondary)]">model</label>
										<select id={`ver-${phase}-${p.id}`} name="version" class="tron-input py-1 text-xs">
											<option value="" selected={!p.activeModelVersion}>— none (off) —</option>
											{#each [...p.versions].reverse() as v (v.version)}
												<option value={v.version} selected={v.version === p.activeModelVersion}>
													{v.version} · holdout {fmtAcc(v.holdoutAccuracy)}
												</option>
											{/each}
										</select>
										<button type="submit" disabled={submitting} class="rounded bg-[var(--color-tron-cyan)] px-3 py-1 text-xs font-medium text-[var(--color-tron-bg-primary)] disabled:opacity-40">Set</button>
									</form>
								{/if}

								{#if p.activeModelVersion}
									<span class="rounded bg-[rgba(57,255,20,0.12)] px-2 py-0.5 text-xs text-[var(--color-tron-green,#39ff14)]">active: {p.activeModelVersion}</span>
								{:else}
									<span class="rounded bg-[var(--color-tron-bg-secondary)] px-2 py-0.5 text-xs text-[var(--color-tron-text-secondary)]">inactive</span>
								{/if}
								{#if p.shadowModelVersion}
									<span class="rounded bg-[rgba(0,255,255,0.12)] px-2 py-0.5 text-xs text-[var(--color-tron-cyan)]">shadow: {p.shadowModelVersion}</span>
								{/if}
								{#if p.phases.length > 1}
									<span class="text-[10px] text-[var(--color-tron-text-secondary)]" title="The active version is a project-wide setting.">
										also at: {p.phases.filter((ph: string) => ph !== phase).join(', ')}
									</span>
								{/if}

								<form method="POST" action="?/unassign" use:enhance={enhanceSubmit} class="ml-auto">
									<input type="hidden" name="projectId" value={p.id} />
									<input type="hidden" name="phase" value={phase} />
									<button
										type="submit"
										disabled={submitting}
										class="rounded px-2 py-1 text-xs text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-bg-secondary)] hover:text-[var(--color-tron-red,#ff3366)] disabled:opacity-40"
										title="Stop this model from running at this stage"
									>remove</button>
								</form>
							</div>
						{/each}
					</div>
				{/if}

				{#if available.length > 0}
					<form method="POST" action="?/assign" use:enhance={enhanceSubmit} class="mt-3 flex items-center gap-2">
						<input type="hidden" name="phase" value={phase} />
						<label for={`add-${phase}`} class="text-xs uppercase text-[var(--color-tron-text-secondary)]">Add model</label>
						<select id={`add-${phase}`} name="projectId" class="tron-input py-1 text-xs">
							{#each available as p (p.id)}
								<option value={p.id}>{p.name}{p.activeModelVersion ? '' : ' (untrained/inactive)'}</option>
							{/each}
						</select>
						<button type="submit" disabled={submitting} class="rounded border border-[var(--color-tron-cyan)] px-3 py-1 text-xs font-medium text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)] hover:text-[var(--color-tron-bg-primary)] disabled:opacity-40">
							Deploy here
						</button>
					</form>
				{/if}
			</div>
		{/each}
	</div>
</div>
