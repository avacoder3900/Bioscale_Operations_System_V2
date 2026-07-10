<script lang="ts">
	import { enhance } from '$app/forms';
	import { browser } from '$app/environment';

	let { data, form } = $props();

	let showCreate = $state(false);
	let creating = $state(false);

	// Create-form phase scoping: a project trains on labeled images from the
	// selected phases, OR on everything as a master model — never both.
	let selectedPhases = $state<string[]>([]);
	let isMasterModel = $state(false);
	let canSubmit = $derived(isMasterModel || selectedPhases.length > 0);

	// Step-by-step "how to create a model" guide. Same persistence pattern as
	// the Image Stream guide: collapsed state sticks per browser so it teaches
	// new users without nagging daily ones.
	let showGuide = $state(browser ? localStorage.getItem('cv-projects-guide-collapsed') !== '1' : true);
	function toggleGuide() {
		showGuide = !showGuide;
		if (browser) localStorage.setItem('cv-projects-guide-collapsed', showGuide ? '0' : '1');
	}

	// Every step names the exact page/tab where it happens — this page and the
	// project detail tabs (History / Deployment / Needs review).
	const guideSteps = [
		{
			n: 1,
			title: 'Build the training data',
			where: 'Capture → Image Stream',
			desc: 'Photos from Capture and the inline inspect steps land in the Image Stream. Review each one Pass / Fail there — only reviewed photos can train a model. Aim for at least 5 of each verdict in the phases you care about; more is better.',
			href: '/cv/stream',
			linkText: 'Open Image Stream'
		},
		{
			n: 2,
			title: 'Create a project',
			where: 'This page → + New project',
			desc: 'A project defines what one model learns: pick the training phases (wax_filled / reagent_filled / post_mortem) — or Master model for all phases — and optionally scope it to the top or bottom camera view. The project then collects every reviewed photo matching that scope as its training pool.',
			href: null,
			linkText: null
		},
		{
			n: 3,
			title: 'Train a version',
			where: 'Project page → History tab',
			desc: 'Press "Train new version". It needs at least 5 labeled photos with both Pass and Fail present, fits the classifier in-process, and auto-scores a holdout. Every run creates a new immutable version — nothing is overwritten.',
			href: null,
			linkText: null
		},
		{
			n: 4,
			title: 'Verify it passes the gate',
			where: 'Project page → Deployment tab',
			desc: 'A version must pass the verify gate (enough holdout photos + minimum balanced accuracy) before it can deploy. Use Verify to re-score a version against the current labeled pool at any time.',
			href: null,
			linkText: null
		},
		{
			n: 5,
			title: 'Deploy',
			where: 'Project page → Deployment tab',
			desc: 'Deploy points the capture stations at that version for the deploy-at phases you pick — from then on, new photos at those steps are auto-graded Pass / Fail. You can also set a shadow version that scores silently alongside for comparison.',
			href: null,
			linkText: null
		},
		{
			n: 6,
			title: 'Review verdicts & retrain',
			where: 'Project page → Needs review tab',
			desc: 'Agree or overrule the model’s verdicts as they come in — overrules are the highest-value training data for the next version. When "new since last version" grows, train again and deploy the better version.',
			href: null,
			linkText: null
		}
	];
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
		<div class="flex items-center gap-2">
			<button
				type="button"
				onclick={toggleGuide}
				class="flex items-center gap-1.5 rounded border border-[var(--color-tron-border)] px-3 py-2 text-xs font-medium text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-cyan)]"
			>
				<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
				</svg>
				{showGuide ? 'Hide guide' : 'How do I create a model?'}
			</button>
			<button
				type="button"
				onclick={() => (showCreate = !showCreate)}
				class="rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-[var(--color-tron-bg-primary)]"
			>
				{showCreate ? 'Cancel' : '+ New project'}
			</button>
		</div>
	</div>

	{#if showGuide}
		<!-- Step-by-step model-creation guide: each step names the exact page/tab
		     where it happens. The stream page has the matching data-flow banner. -->
		<div class="rounded-lg border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-bg-secondary)] p-4">
			<div class="mb-1 flex items-center justify-between">
				<h2 class="text-sm font-semibold uppercase tracking-wide text-[var(--color-tron-cyan)]">
					How to create a CV model
				</h2>
				<button
					type="button"
					onclick={toggleGuide}
					class="text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]"
				>✕ hide</button>
			</div>
			<p class="mb-3 text-xs text-[var(--color-tron-text-secondary)]">
				<a href="/capture" class="text-[var(--color-tron-cyan)] hover:underline">Capture</a>
				→ <a href="/cv/stream" class="text-[var(--color-tron-cyan)] hover:underline">Review in the Image Stream</a>
				→ create a project here → train → verify → deploy → keep reviewing its verdicts.
			</p>
			<ol class="grid gap-2 lg:grid-cols-2">
				{#each guideSteps as step (step.n)}
					<li class="flex gap-3 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] p-3">
						<span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-tron-bg-tertiary)] text-xs font-bold text-[var(--color-tron-cyan)]">{step.n}</span>
						<div class="min-w-0">
							<div class="flex flex-wrap items-center gap-2">
								<span class="text-sm font-semibold text-[var(--color-tron-text-primary,#e5faff)]">{step.title}</span>
								<span class="rounded bg-[var(--color-tron-cyan)]/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-tron-cyan)]">{step.where}</span>
							</div>
							<p class="mt-1 text-xs leading-relaxed text-[var(--color-tron-text-secondary)]">{step.desc}</p>
							{#if step.href}
								<a href={step.href} class="mt-1 inline-block text-xs font-medium text-[var(--color-tron-cyan)] underline hover:opacity-80">{step.linkText} →</a>
							{/if}
						</div>
					</li>
				{/each}
			</ol>
		</div>
	{/if}

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

				<div>
					<label for="np-view" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">
						View <span class="normal-case">— top and bottom cartridge photos look different; a view-scoped model trains on and grades only that view</span>
					</label>
					<select id="np-view" name="view" class="tron-input w-full">
						<option value="">Any view (default — grades every photo)</option>
						<option value="top">Top</option>
						<option value="bottom">Bottom</option>
					</select>
				</div>

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
								{#if p.view}
									<span class="rounded border border-[var(--color-tron-amber,#ffb300)] bg-[rgba(255,179,0,0.10)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--color-tron-amber,#ffb300)]">{p.view}</span>
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
