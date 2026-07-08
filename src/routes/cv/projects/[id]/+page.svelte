<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	type Tab = 'members' | 'composition' | 'training' | 'deployment' | 'history';
	const TAB_LABELS: Record<Tab, string> = {
		members: 'Members',
		composition: 'Composition',
		training: 'Training setup',
		deployment: 'Deployment',
		history: 'History'
	};
	let activeTab = $state<Tab>('members');

	let submitting = $state(false);

	// Composition picker state
	let composedOfSelections = $state<Set<string>>(new Set(data.project.composedOf));
	let liveCompositionToggle = $state(data.project.isLiveComposition);

	// Training-setup state
	let phaseSelections = $state<Set<string>>(new Set(data.project.phases));
	let masterToggle = $state(data.project.isMasterModel);
	// View scope (CV-PIPELINE-V2 top/bottom split) — '' = any view.
	let viewSelection = $state<string>(data.project.view ?? '');
	let statusSelections = $state<Set<string>>(new Set(data.project.trainingFilter.cartridgeStatuses));

	// Deployment state
	let deploySelections = $state<Set<string>>(new Set(data.project.deployAtPhases));
	let activeVersion = $state<string>(data.project.activeModelVersion ?? '');
	let shadowVersion = $state<string>(data.project.shadowModelVersion ?? '');

	// Latest trained version (append-only array — last entry) for the stepper.
	const latestVersion = $derived(
		data.project.trainedModels.length > 0
			? data.project.trainedModels[data.project.trainedModels.length - 1]
			: null
	);
	// Train-button gating from the trainer-truth eligible pool (not member stats).
	const trainBlockedReason = $derived(
		data.trainPool.total < 5
			? `Need at least 5 eligible labeled images to train (have ${data.trainPool.total})`
			: data.trainPool.approved === 0 || data.trainPool.rejected === 0
				? `Need both classes labeled (have ${data.trainPool.approved} approved, ${data.trainPool.rejected} rejected)`
				: null
	);

	function toggleSet<T>(set: Set<T>, val: T): Set<T> {
		const next = new Set(set);
		if (next.has(val)) next.delete(val); else next.add(val);
		return next;
	}

	function fmt(d: string | Date | null): string {
		if (!d) return '—';
		return new Date(d).toLocaleString();
	}

	// Format a 0..1 metric as a percentage.
	function pct01(n: number | null | undefined): string {
		if (typeof n !== 'number') return '—';
		return `${(n * 100).toFixed(1)}%`;
	}

	// Tailwind classes for a version's lifecycle status pill.
	function statusPill(status: string): string {
		switch (status) {
			case 'deployed':
				return 'border-[var(--color-tron-green,#39ff14)] text-[var(--color-tron-green,#39ff14)] bg-[rgba(57,255,20,0.08)]';
			case 'verified':
				return 'border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)] bg-[rgba(0,229,255,0.08)]';
			case 'retired':
				return 'border-[var(--color-tron-text-secondary)] text-[var(--color-tron-text-secondary)]';
			default: // trained
				return 'border-[var(--color-tron-amber,#ffb300)] text-[var(--color-tron-amber,#ffb300)] bg-[rgba(255,179,0,0.08)]';
		}
	}
</script>

<div class="space-y-4">
	<header class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<a href="/cv/projects" class="text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]">← all projects</a>
			<h1 class="mt-1 text-2xl font-bold text-[var(--color-tron-cyan)]">{data.project.name}</h1>
			{#if data.project.description}<p class="text-sm text-[var(--color-tron-text-secondary)]">{data.project.description}</p>{/if}
		</div>
		<div class="flex flex-col items-end gap-2">
			<a
				href={`/capture?projectId=${encodeURIComponent(data.project.id)}${data.project.deployAtPhases[0] ? `&phase=${encodeURIComponent(data.project.deployAtPhases[0])}` : ''}`}
				class="rounded bg-[var(--color-tron-green,#39ff14)] px-4 py-2 text-sm font-medium text-black"
				title={data.project.activeModelVersion
					? `Inference will auto-run for this project at phase ${data.project.deployAtPhases.join(', ') || '(none deployed)'}`
					: 'No active model yet — capture will save images but not run inference for this project'}
			>
				Capture cartridges →
			</a>
			<div class="text-right text-xs text-[var(--color-tron-text-secondary)]">
				<div>created {fmt(data.project.createdAt)}</div>
				<div>updated {fmt(data.project.updatedAt)}</div>
			</div>
		</div>
	</header>

	{#if form?.error}
		<div class="rounded border border-[var(--color-tron-red,#ff3366)] bg-[rgba(255,51,102,0.08)] p-3 text-sm text-[var(--color-tron-red,#ff3366)]">{form.error}</div>
	{/if}
	{#if form?.success}
		<div class="rounded border border-[var(--color-tron-green,#39ff14)] bg-[rgba(57,255,20,0.08)] p-3 text-sm text-[var(--color-tron-green,#39ff14)]">
			{form.message ?? 'Saved.'}
		</div>
	{/if}

	<!-- Summary bar -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3">
		<div class="grid gap-3 sm:grid-cols-4">
			<div>
				<div class="text-xs uppercase text-[var(--color-tron-text-secondary)]">Members</div>
				<div class="font-mono text-lg text-[var(--color-tron-cyan)]">{data.effectiveTotal}</div>
				<div class="text-[10px] text-[var(--color-tron-text-secondary)]">
					{data.project.memberCount} direct
					{#if data.liveAdditionCount > 0} + {data.liveAdditionCount} via composition{/if}
				</div>
			</div>
			<div>
				<div class="text-xs uppercase text-[var(--color-tron-text-secondary)]">Labels</div>
				<div class="font-mono text-lg">
					<span class="text-[var(--color-tron-green,#39ff14)]">{data.labelStats.approved}</span> /
					<span class="text-[var(--color-tron-red,#ff3366)]">{data.labelStats.rejected}</span>
				</div>
				<div class="text-[10px] text-[var(--color-tron-text-secondary)]">approved / rejected · {data.labelStats.unlabeled} unlabeled</div>
			</div>
			<div>
				<div class="text-xs uppercase text-[var(--color-tron-text-secondary)]">Active model</div>
				<div class="font-mono text-sm text-[var(--color-tron-green,#39ff14)]">{data.project.activeModelVersion ?? '—'}</div>
				{#if data.project.shadowModelVersion}
					<div class="text-[10px] text-[var(--color-tron-cyan)]">shadow: {data.project.shadowModelVersion}</div>
				{/if}
			</div>
			<div>
				<div class="text-xs uppercase text-[var(--color-tron-text-secondary)]">Deploys at</div>
				<div class="flex flex-wrap gap-1 text-xs">
					{#each data.project.deployAtPhases as ph (ph)}
						<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-2 py-0.5">{ph}</span>
					{:else}
						<span class="text-[10px] text-[var(--color-tron-text-secondary)]">no phases configured</span>
					{/each}
				</div>
			</div>
		</div>
	</div>

	<!-- Pipeline stepper: labeled pool → latest version vs gate → deployed -->
	<div class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] px-3 py-2 text-xs">
		<span class="text-[var(--color-tron-text-secondary)]">
			<span class="uppercase">1 · Label</span>
			<span class="ml-1 font-mono text-[var(--color-tron-text)]">{data.trainPool.total}</span> eligible
			(<span class="text-[var(--color-tron-green,#39ff14)]">{data.trainPool.approved}✓</span>/<span class="text-[var(--color-tron-red,#ff3366)]">{data.trainPool.rejected}✗</span>)
			{#if latestVersion}· <span class="font-mono text-[var(--color-tron-cyan)]">{data.trainPool.newSinceLastVersion}</span> new since last train{/if}
		</span>
		<span class="text-[var(--color-tron-border)]">→</span>
		<span class="text-[var(--color-tron-text-secondary)]">
			<span class="uppercase">2 · Train + verify</span>
			{#if latestVersion}
				<span class="ml-1 font-mono text-[var(--color-tron-cyan)]">{latestVersion.version}</span>
				{#if !latestVersion.verification}
					<span class="text-[var(--color-tron-amber,#ffb300)]">unverified</span>
				{:else if latestVersion.verification.passed}
					<span class="text-[var(--color-tron-green,#39ff14)]">gate PASS</span>
				{:else}
					<span class="text-[var(--color-tron-red,#ff3366)]">gate FAIL</span>
				{/if}
			{:else}
				<span class="ml-1 italic">no versions yet</span>
			{/if}
		</span>
		<span class="text-[var(--color-tron-border)]">→</span>
		<span class="text-[var(--color-tron-text-secondary)]">
			<span class="uppercase">3 · Deployed</span>
			{#if data.project.activeModelVersion}
				<span class="ml-1 font-mono text-[var(--color-tron-green,#39ff14)]">{data.project.activeModelVersion}</span>
				at {data.project.deployAtPhases.join(', ') || '(no phases)'}
			{:else}
				<span class="ml-1 italic">nothing deployed</span>
			{/if}
		</span>
	</div>

	<!-- Tabs -->
	<div class="flex gap-1 border-b border-[var(--color-tron-border)]">
		{#each ['members', 'composition', 'training', 'deployment', 'history'] as t (t)}
			<button
				type="button"
				class="px-4 py-2 text-sm font-medium
					{activeTab === t
						? 'border-b-2 border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
						: 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}"
				onclick={() => (activeTab = t as Tab)}
			>
				{TAB_LABELS[t as Tab]}
			</button>
		{/each}
	</div>

	{#if activeTab === 'members'}
		<div class="space-y-3">
			<div class="flex items-center justify-between text-sm">
				<div class="text-[var(--color-tron-text-secondary)]">
					Showing first {data.previewImages.length} of {data.effectiveTotal} effective members.
				</div>
				<a href="/cv/label" class="rounded bg-[var(--color-tron-cyan)] px-3 py-1.5 text-xs font-medium text-[var(--color-tron-bg-primary)]">
					Add images via /cv/label
				</a>
			</div>

			{#if data.previewImages.length === 0}
				<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-12 text-center">
					<p class="text-[var(--color-tron-text-secondary)]">No members yet.</p>
					<p class="mt-2 text-xs text-[var(--color-tron-text-secondary)]">
						Use <a class="text-[var(--color-tron-cyan)] underline" href="/cv/label">/cv/label</a> to assemble a training set, or set up live composition under the Composition tab.
					</p>
				</div>
			{:else}
				<div class="grid gap-3 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
					{#each data.previewImages as img (img.id)}
						<div class="overflow-hidden rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
							{#if img.thumbnailUrl}
								<img src={img.thumbnailUrl} alt={img.cartridgeImageNumber ?? 'capture'} class="aspect-square w-full object-cover" />
							{:else}
								<div class="aspect-square w-full bg-[var(--color-tron-bg-tertiary)]"></div>
							{/if}
							<div class="p-2 text-xs">
								<div class="truncate font-mono text-[var(--color-tron-cyan)]">{img.cartridgeImageNumber ?? '—'}</div>
								<div class="flex items-center justify-between text-[var(--color-tron-text-secondary)]">
									<span class="truncate">{img.phase ?? '—'}</span>
									{#if img.qcLabel === 'approved'}<span class="text-[var(--color-tron-green,#39ff14)]">✓</span>
									{:else if img.qcLabel === 'rejected'}<span class="text-[var(--color-tron-red,#ff3366)]">✗</span>{/if}
								</div>
								{#if data.project.members.includes(img.id)}
									<form
										method="POST"
										action="?/removeMember"
										class="mt-1"
										use:enhance={() => {
											submitting = true;
											return async ({ update }) => {
												await update();
												submitting = false;
											};
										}}
									>
										<input type="hidden" name="imageId" value={img.id} />
										<button type="submit" disabled={submitting} class="w-full rounded border border-[var(--color-tron-red,#ff3366)] px-1.5 py-0.5 text-[10px] text-[var(--color-tron-red,#ff3366)] disabled:opacity-40">
											Remove
										</button>
									</form>
								{:else}
									<div class="mt-1 text-[10px] text-[var(--color-tron-text-secondary)] italic">via composition</div>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>

	{:else if activeTab === 'composition'}
		<form
			method="POST"
			action="?/updateComposition"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update();
					submitting = false;
				};
			}}
			class="space-y-3 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4"
		>
			<div>
				<label class="flex items-center gap-2 text-sm">
					<input type="checkbox" name="isLiveComposition" bind:checked={liveCompositionToggle} />
					<span class="text-[var(--color-tron-text)]">Live composition</span>
				</label>
				<p class="ml-6 text-xs text-[var(--color-tron-text-secondary)]">
					When on, this project's effective members union with every selected child project's current members at training time. When off, composedOf is informational only — members[] is the frozen training set.
				</p>
			</div>
			<div>
				<div class="mb-2 text-xs uppercase text-[var(--color-tron-text-secondary)]">Compose from</div>
				{#if data.otherProjects.length === 0}
					<p class="text-xs text-[var(--color-tron-text-secondary)]">No other projects exist yet.</p>
				{:else}
					<div class="grid gap-1 sm:grid-cols-2">
						{#each data.otherProjects as p (p.id)}
							{@const checked = composedOfSelections.has(p.id)}
							<label class="flex items-center gap-2 rounded border border-[var(--color-tron-border)] p-2 text-sm">
								<input
									type="checkbox"
									name="composedOf"
									value={p.id}
									{checked}
									onchange={() => (composedOfSelections = toggleSet(composedOfSelections, p.id))}
								/>
								<span class="flex-1 truncate text-[var(--color-tron-text)]">{p.name}</span>
								<span class="text-xs text-[var(--color-tron-text-secondary)]">{p.memberCount}</span>
							</label>
						{/each}
					</div>
				{/if}
			</div>
			<button type="submit" disabled={submitting} class="rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-[var(--color-tron-bg-primary)] disabled:opacity-40">
				{submitting ? 'Saving…' : 'Save composition'}
			</button>
		</form>

	{:else if activeTab === 'training'}
		<form
			method="POST"
			action="?/updateTrainingSetup"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update();
					submitting = false;
				};
			}}
			class="space-y-4 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4"
		>
			<!-- Master toggle + phase scope -->
			<div>
				<label class="flex items-center gap-2 text-sm">
					<input type="checkbox" name="isMasterModel" bind:checked={masterToggle} />
					<span class="text-[var(--color-tron-text)]">Master model</span>
					{#if masterToggle}
						<span class="rounded border border-[var(--color-tron-amber,#ffb300)] px-2 py-0.5 text-[10px] uppercase text-[var(--color-tron-amber,#ffb300)]">MASTER</span>
					{/if}
				</label>
				<p class="ml-6 text-xs text-[var(--color-tron-text-secondary)]">
					A master model trains on labeled images from every phase — the phase scope below is ignored (and left untouched).
				</p>
			</div>

			<!-- View scope (CV-PIPELINE-V2 top/bottom split) -->
			<div>
				<label for="ts-view" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">View</label>
				<p class="mb-2 text-xs text-[var(--color-tron-text-secondary)]">
					Top and bottom cartridge photos look completely different. Pin a view to train on and grade only that view (untagged photos are excluded); leave as Any view for existing behavior. Applies even to master models.
				</p>
				<select id="ts-view" name="view" bind:value={viewSelection} class="tron-input w-full sm:w-64">
					<option value="">Any view</option>
					<option value="top">Top</option>
					<option value="bottom">Bottom</option>
				</select>
			</div>

			<div>
				<div class="mb-2 flex items-center gap-2 text-xs uppercase text-[var(--color-tron-text-secondary)]">
					<span>Phase scope</span>
					{#if masterToggle}
						<span class="rounded border border-[var(--color-tron-amber,#ffb300)] px-2 py-0.5 text-[10px] text-[var(--color-tron-amber,#ffb300)]">MASTER — all phases</span>
					{/if}
				</div>
				<p class="mb-2 text-xs text-[var(--color-tron-text-secondary)]">
					Only images captured at these manufacturing phases are eligible for training. None selected = all phases.
				</p>
				<div class="grid gap-2 sm:grid-cols-3 md:grid-cols-4">
					{#each data.canonicalPhases as ph (ph)}
						{@const checked = phaseSelections.has(ph)}
						<label class="flex items-center gap-2 rounded border border-[var(--color-tron-border)] p-2 text-sm {masterToggle ? 'opacity-40' : ''}">
							<input
								type="checkbox"
								name="phases"
								value={ph}
								{checked}
								disabled={masterToggle}
								onchange={() => (phaseSelections = toggleSet(phaseSelections, ph))}
							/>
							<span class="font-mono text-xs">{ph}</span>
						</label>
					{/each}
				</div>
			</div>

			<!-- Verify gate -->
			<div>
				<div class="mb-2 text-xs uppercase text-[var(--color-tron-text-secondary)]">Verify gate</div>
				<p class="mb-2 text-xs text-[var(--color-tron-text-secondary)]">
					A trained version must clear these on its holdout before it can be deployed.
				</p>
				<div class="grid gap-3 sm:grid-cols-2">
					<div>
						<label for="ts-holdout" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">Min holdout count <span class="normal-case">(default 10)</span></label>
						<input id="ts-holdout" name="minHoldoutCount" type="number" step="1" min="1" value={data.project.verifyGate.minHoldoutCount} class="tron-input w-full" />
					</div>
					<div>
						<label for="ts-balacc" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">Min balanced accuracy <span class="normal-case">(default 0.80)</span></label>
						<input id="ts-balacc" name="minBalancedAccuracy" type="number" step="0.01" min="0.01" max="1" value={data.project.verifyGate.minBalancedAccuracy} class="tron-input w-full" />
					</div>
				</div>
			</div>

			<!-- Training filter -->
			<div>
				<div class="mb-2 text-xs uppercase text-[var(--color-tron-text-secondary)]">Training filter</div>
				<p class="mb-2 text-xs text-[var(--color-tron-text-secondary)]">
					Narrows the eligible pool by cartridge status (e.g. exclude voided/scrapped carts) and failure-label tags. Empty = no restriction.
				</p>
				<div class="mb-3">
					<div class="mb-1 text-[10px] uppercase text-[var(--color-tron-text-secondary)]">Cartridge statuses (only train on images from carts in these statuses)</div>
					<div class="grid gap-1 sm:grid-cols-3 md:grid-cols-4">
						{#each data.cartridgeStatusOptions as st (st)}
							{@const checked = statusSelections.has(st)}
							<label class="flex items-center gap-2 rounded border border-[var(--color-tron-border)] p-1.5 text-xs">
								<input
									type="checkbox"
									name="cartridgeStatuses"
									value={st}
									{checked}
									onchange={() => (statusSelections = toggleSet(statusSelections, st))}
								/>
								<span class="font-mono">{st}</span>
							</label>
						{/each}
					</div>
				</div>
				<div class="grid gap-3 sm:grid-cols-2">
					<div>
						<label for="ts-required" class="mb-1 block text-[10px] uppercase text-[var(--color-tron-text-secondary)]">Required tags (comma-separated)</label>
						<input id="ts-required" name="requiredTags" type="text" value={data.project.trainingFilter.requiredTags.join(', ')} placeholder="e.g. wax_bridge, underfill" class="tron-input w-full" />
					</div>
					<div>
						<label for="ts-exclude" class="mb-1 block text-[10px] uppercase text-[var(--color-tron-text-secondary)]">Exclude tags (comma-separated)</label>
						<input id="ts-exclude" name="excludeTags" type="text" value={data.project.trainingFilter.excludeTags.join(', ')} placeholder="e.g. blurry, test_shot" class="tron-input w-full" />
					</div>
				</div>
			</div>

			<button type="submit" disabled={submitting} class="rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-[var(--color-tron-bg-primary)] disabled:opacity-40">
				{submitting ? 'Saving…' : 'Save training setup'}
			</button>
		</form>

	{:else if activeTab === 'deployment'}
		<div class="space-y-4">
			<!-- Deploy-at phases: the routing targets applied when you Deploy a version. -->
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
				<div class="mb-2 text-xs uppercase text-[var(--color-tron-text-secondary)]">Deploy-at phases</div>
				<p class="mb-2 text-xs text-[var(--color-tron-text-secondary)]">
					A capture at any selected phase is graded by whichever version you Deploy below. Select the target phases first, then press Deploy on a verified version.
				</p>
				<div class="grid gap-2 sm:grid-cols-3">
					{#each data.observedPhases as ph (ph)}
						{@const checked = deploySelections.has(ph)}
						<label class="flex items-center gap-2 rounded border border-[var(--color-tron-border)] p-2 text-sm">
							<input
								type="checkbox"
								{checked}
								onchange={() => (deploySelections = toggleSet(deploySelections, ph))}
							/>
							<span>{ph}</span>
						</label>
					{/each}
					{#if data.observedPhases.length === 0}
						<span class="text-xs text-[var(--color-tron-text-secondary)]">No phases observed in the data yet.</span>
					{/if}
				</div>
			</div>

			<!-- Version history: Deploy / Roll back / Verify / Shadow per version. -->
			<div>
				<div class="mb-2 flex items-center justify-between">
					<h3 class="text-sm font-semibold uppercase text-[var(--color-tron-text-secondary)]">Model versions</h3>
					<span class="text-xs text-[var(--color-tron-text-secondary)]">
						gate: n ≥ {data.project.verifyGate.minHoldoutCount}, balanced acc ≥ {pct01(data.project.verifyGate.minBalancedAccuracy)}
					</span>
				</div>
				{#if data.project.trainedModels.length === 0}
					<p class="text-sm text-[var(--color-tron-text-secondary)]">No models trained yet — train one under the History tab.</p>
				{:else}
					<div class="overflow-x-auto rounded border border-[var(--color-tron-border)]">
						<table class="w-full text-sm">
							<thead class="bg-[var(--color-tron-bg-tertiary)] text-xs uppercase text-[var(--color-tron-text-secondary)]">
								<tr>
									<th class="px-3 py-2 text-left">Version</th>
									<th class="px-3 py-2 text-left">Status</th>
									<th class="px-3 py-2 text-left">Trained</th>
									<th class="px-3 py-2 text-right">Images</th>
									<th class="px-3 py-2 text-right">Holdout bal. acc</th>
									<th class="px-3 py-2 text-right">Threshold</th>
									<th class="px-3 py-2 text-center">Gate</th>
									<th class="px-3 py-2 text-right">Actions</th>
								</tr>
							</thead>
							<tbody>
								{#each data.project.trainedModels as m (m.version)}
									{@const isActive = m.version === data.project.activeModelVersion}
									{@const isShadow = m.version === data.project.shadowModelVersion}
									{@const passed = m.verification?.passed === true}
									<tr class="border-t border-[var(--color-tron-border)] align-top">
										<td class="px-3 py-2 font-mono text-[var(--color-tron-cyan)]">
											{m.version}
											{#if isActive}<span class="ml-1 text-[10px] text-[var(--color-tron-green,#39ff14)]">ACTIVE</span>{/if}
											{#if isShadow}<span class="ml-1 text-[10px] text-[var(--color-tron-cyan)]">SHADOW</span>{/if}
											{#if m.legacy}<span class="ml-1 text-[10px] text-[var(--color-tron-text-secondary)]">legacy</span>{/if}
										</td>
										<td class="px-3 py-2">
											<span class="rounded border px-2 py-0.5 text-[10px] uppercase {statusPill(m.status)}">{m.status}</span>
										</td>
										<td class="px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">
											{fmt(m.trainedAt)}<br />{m.trainedBy?.username ?? '—'}
										</td>
										<td class="px-3 py-2 text-right">
											{m.trainingSet?.count ?? '—'}
											{#if m.trainingSet?.newSincePrevious}
												<div class="text-[10px] text-[var(--color-tron-green,#39ff14)]">+{m.trainingSet.newSincePrevious} new</div>
											{/if}
										</td>
										<td class="px-3 py-2 text-right">
											{#if m.verification}
												{pct01(m.verification.balancedAccuracy)}
												<div class="text-[10px] text-[var(--color-tron-text-secondary)]">n={m.verification.holdoutCount ?? '—'}{#if m.verification.mode === 'full-pool'} · full pool{/if}</div>
											{:else}
												<span class="text-[var(--color-tron-text-secondary)]">—</span>
											{/if}
										</td>
										<td class="px-3 py-2 text-right">{m.confidenceThreshold ?? '—'}</td>
										<td class="px-3 py-2 text-center">
											{#if !m.verification}
												<span class="text-[var(--color-tron-text-secondary)]">—</span>
											{:else if passed}
												<span class="text-[var(--color-tron-green,#39ff14)]">PASS</span>
											{:else}
												<span class="text-[var(--color-tron-red,#ff3366)]">FAIL</span>
											{/if}
										</td>
										<td class="px-3 py-2">
											<div class="flex flex-wrap items-center justify-end gap-1">
												<!-- Deploy / Roll back -->
												{#if isActive}
													<span class="text-[10px] text-[var(--color-tron-green,#39ff14)]">deployed</span>
												{:else}
													<form
														method="POST"
														action="?/deployVersion"
														use:enhance={() => {
															submitting = true;
															return async ({ update }) => { await update(); submitting = false; };
														}}
													>
														<input type="hidden" name="version" value={m.version} />
														{#each [...deploySelections] as ph}<input type="hidden" name="phase" value={ph} />{/each}
														<button
															type="submit"
															disabled={submitting || !passed}
															class="rounded border border-[var(--color-tron-green,#39ff14)] px-2 py-1 text-[10px] font-medium text-[var(--color-tron-green,#39ff14)] disabled:opacity-30"
															title={passed ? 'Point the station at this version' : 'Must pass verification before deploy'}
														>
															{m.status === 'retired' ? 'Roll back' : 'Deploy'}
														</button>
													</form>
												{/if}

												<!-- Verify / re-verify -->
												<form
													method="POST"
													action="?/verifyVersion"
													use:enhance={() => {
														submitting = true;
														return async ({ update }) => { await update(); submitting = false; };
													}}
												>
													<input type="hidden" name="version" value={m.version} />
													<button
														type="submit"
														disabled={submitting}
														class="rounded border border-[var(--color-tron-cyan)] px-2 py-1 text-[10px] font-medium text-[var(--color-tron-cyan)] disabled:opacity-30"
														title="Re-score this version against the current labeled pool"
													>
														{m.verification ? 'Re-verify' : 'Verify'}
													</button>
												</form>

												<!-- Shadow set / clear -->
												{#if isShadow}
													<form
														method="POST"
														action="?/clearShadow"
														use:enhance={() => {
															submitting = true;
															return async ({ update }) => { await update(); submitting = false; };
														}}
													>
														<button type="submit" disabled={submitting} class="rounded border border-[var(--color-tron-border)] px-2 py-1 text-[10px] text-[var(--color-tron-text-secondary)] disabled:opacity-30">
															Clear shadow
														</button>
													</form>
												{:else}
													<form
														method="POST"
														action="?/setShadow"
														use:enhance={() => {
															submitting = true;
															return async ({ update }) => { await update(); submitting = false; };
														}}
													>
														<input type="hidden" name="version" value={m.version} />
														<button type="submit" disabled={submitting} class="rounded border border-[var(--color-tron-border)] px-2 py-1 text-[10px] text-[var(--color-tron-text-secondary)] disabled:opacity-30">
															Shadow
														</button>
													</form>
												{/if}
											</div>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</div>

			<!-- Advanced: manual override of the routing fields (updateDeployment). -->
			<details class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
				<summary class="cursor-pointer px-4 py-3 text-xs uppercase text-[var(--color-tron-text-secondary)]">Advanced — manual override</summary>
				<form
					method="POST"
					action="?/updateDeployment"
					use:enhance={() => {
						submitting = true;
						return async ({ update }) => { await update(); submitting = false; };
					}}
					class="space-y-4 px-4 pb-4"
				>
					<p class="text-xs text-[var(--color-tron-text-secondary)]">
						Directly set the routing fields without the deploy gate. Uses the Deploy-at phases selected above.
					</p>
					{#each [...deploySelections] as ph}<input type="hidden" name="phase" value={ph} />{/each}
					<div class="grid gap-3 sm:grid-cols-2">
						<div>
							<label for="d-active" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">Active model version</label>
							<select id="d-active" name="activeModelVersion" bind:value={activeVersion} class="tron-input w-full">
								<option value="">— none —</option>
								{#each data.project.trainedModels as m (m.version)}
									<option value={m.version}>{m.version} (n={m.trainingSet?.count ?? '?'})</option>
								{/each}
							</select>
						</div>
						<div>
							<label for="d-shadow" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">Shadow model version</label>
							<select id="d-shadow" name="shadowModelVersion" bind:value={shadowVersion} class="tron-input w-full">
								<option value="">— none —</option>
								{#each data.project.trainedModels as m (m.version)}
									<option value={m.version}>{m.version}</option>
								{/each}
							</select>
						</div>
					</div>
					<button type="submit" disabled={submitting} class="rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-[var(--color-tron-bg-primary)] disabled:opacity-40">
						{submitting ? 'Saving…' : 'Save (manual override)'}
					</button>
				</form>
			</details>
		</div>

	{:else if activeTab === 'history'}
		<div class="space-y-4">
			<div class="flex flex-wrap items-end justify-between gap-3 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
				<div>
					<h3 class="text-sm font-semibold uppercase text-[var(--color-tron-text-secondary)]">Train a new model</h3>
					<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
						Fits a logistic-regression classifier in-process on the labeled images (needs ≥ 5, both classes present) and auto-scores a holdout against the verify gate. Append-only — every run produces a new immutable version. Verify + Deploy it under the Deployment tab.
					</p>
					<p class="mt-1 text-xs text-[var(--color-tron-text)]">
						Eligible for training (phase scope + filter applied):
						<span class="font-mono text-[var(--color-tron-green,#39ff14)]">{data.trainPool.approved}</span> approved,
						<span class="font-mono text-[var(--color-tron-red,#ff3366)]">{data.trainPool.rejected}</span> rejected
						— <span class="font-mono text-[var(--color-tron-cyan)]">{data.trainPool.newSinceLastVersion}</span> new since
						{#if data.trainPool.latestVersion}<span class="font-mono">{data.trainPool.latestVersion}</span>{:else}ever (no versions yet){/if}.
					</p>
					{#if trainBlockedReason}
						<p class="mt-1 text-xs text-[var(--color-tron-amber,#ffb300)]">{trainBlockedReason} — adjust the scope under Training setup or label more images.</p>
					{:else if data.trainPool.latestVersion && data.trainPool.newSinceLastVersion === 0}
						<p class="mt-1 text-xs text-[var(--color-tron-amber,#ffb300)]">No new labeled images since {data.trainPool.latestVersion} — retraining will reuse the same pool.</p>
					{/if}
					<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
						Project members: {data.labelStats.approved} approved, {data.labelStats.rejected} rejected, {data.labelStats.unlabeled} unlabeled.
					</p>
				</div>
				<form
					method="POST"
					action="?/train"
					use:enhance={() => {
						submitting = true;
						return async ({ update }) => {
							await update();
							submitting = false;
						};
					}}
					class="flex items-end gap-2"
				>
					<div>
						<label for="train-threshold" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">Confidence threshold</label>
						<input id="train-threshold" name="confidenceThreshold" type="number" step="0.01" min="0" max="1" value="0.5" class="tron-input w-28" />
					</div>
					<button
						type="submit"
						disabled={submitting || trainBlockedReason !== null}
						class="rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-[var(--color-tron-bg-primary)] disabled:opacity-40"
						title={trainBlockedReason ?? 'Train a new immutable version on the eligible labeled pool'}
					>
						{submitting ? 'Starting…' : 'Train new version'}
					</button>
				</form>
			</div>

			<div>
				<h3 class="mb-1 text-sm font-semibold uppercase text-[var(--color-tron-text-secondary)]">Per-version scorecard</h3>
				<p class="mb-2 text-xs text-[var(--color-tron-text-secondary)]">
					How each version's live verdicts held up against human review. Low agreement is the signal that it's time to label more and retrain. See the full version table under the Deployment tab.
				</p>
				{#if data.scorecard.length === 0}
					<p class="text-sm text-[var(--color-tron-text-secondary)]">No inspection verdicts recorded yet.</p>
				{:else}
					<div class="overflow-x-auto rounded border border-[var(--color-tron-border)]">
						<table class="w-full text-sm">
							<thead class="bg-[var(--color-tron-bg-tertiary)] text-xs uppercase text-[var(--color-tron-text-secondary)]">
								<tr>
									<th class="px-3 py-2 text-left">Version</th>
									<th class="px-3 py-2 text-right">Total runs</th>
									<th class="px-3 py-2 text-right">Shadow</th>
									<th class="px-3 py-2 text-right">Human-reviewed</th>
									<th class="px-3 py-2 text-right">Agreement</th>
								</tr>
							</thead>
							<tbody>
								{#each data.scorecard as s (s.version)}
									<tr class="border-t border-[var(--color-tron-border)]">
										<td class="px-3 py-2 font-mono text-[var(--color-tron-cyan)]">
											{s.version}
											{#if s.version === data.project.activeModelVersion}<span class="ml-1 text-[10px] text-[var(--color-tron-green,#39ff14)]">ACTIVE</span>{/if}
										</td>
										<td class="px-3 py-2 text-right">{s.totalRuns}</td>
										<td class="px-3 py-2 text-right text-[var(--color-tron-text-secondary)]">{s.shadowRuns}</td>
										<td class="px-3 py-2 text-right">{s.reviewed}</td>
										<td class="px-3 py-2 text-right">
											{#if s.agreementPct === null}
												<span class="text-[var(--color-tron-text-secondary)]">—</span>
											{:else}
												<span class={s.agreementPct >= 80 ? 'text-[var(--color-tron-green,#39ff14)]' : 'text-[var(--color-tron-red,#ff3366)]'}>{s.agreementPct}%</span>
												<span class="text-[10px] text-[var(--color-tron-text-secondary)]"> ({s.agreed}/{s.reviewed})</span>
											{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</div>

			<div>
				<h3 class="mb-2 text-sm font-semibold uppercase text-[var(--color-tron-text-secondary)]">Recent inspections</h3>
				{#if data.recentInspections.length === 0}
					<p class="text-sm text-[var(--color-tron-text-secondary)]">No inspections have been recorded for this project yet.</p>
				{:else}
					<div class="overflow-x-auto rounded border border-[var(--color-tron-border)]">
						<table class="w-full text-sm">
							<thead class="bg-[var(--color-tron-bg-tertiary)] text-xs uppercase text-[var(--color-tron-text-secondary)]">
								<tr>
									<th class="px-3 py-2 text-left">When</th>
									<th class="px-3 py-2 text-left">Cartridge</th>
									<th class="px-3 py-2 text-left">Phase</th>
									<th class="px-3 py-2 text-left">Version</th>
									<th class="px-3 py-2 text-left">Result</th>
									<th class="px-3 py-2 text-right">Confidence</th>
									<th class="px-3 py-2"></th>
								</tr>
							</thead>
							<tbody>
								{#each data.recentInspections as r (r._id)}
									<tr class="border-t border-[var(--color-tron-border)]">
										<td class="px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">{fmt(r.triggeredAt ?? r.completedAt ?? r.createdAt)}</td>
										<td class="px-3 py-2 font-mono text-[var(--color-tron-cyan)]">{r.cartridgeRecordId}</td>
										<td class="px-3 py-2">{r.phase}</td>
										<td class="px-3 py-2 font-mono text-xs">{r.modelVersion ?? '—'}</td>
										<td class="px-3 py-2">
											{#if r.result === 'pass'}<span class="text-[var(--color-tron-green,#39ff14)]">PASS</span>
											{:else if r.result === 'fail'}<span class="text-[var(--color-tron-red,#ff3366)]">FAIL</span>
											{:else}<span class="text-[var(--color-tron-text-secondary)]">{r.status}</span>{/if}
										</td>
										<td class="px-3 py-2 text-right">{r.confidenceScore != null ? (r.confidenceScore * 100).toFixed(1) + '%' : '—'}</td>
										<td class="px-3 py-2 text-xs">{r.isShadow ? 'shadow' : ''}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Danger zone -->
	<div class="mt-6 rounded-lg border border-[var(--color-tron-red,#ff3366)] bg-[rgba(255,51,102,0.05)] p-3">
		<div class="flex items-center justify-between">
			<div>
				<div class="text-sm font-medium text-[var(--color-tron-red,#ff3366)]">Delete project</div>
				<div class="text-xs text-[var(--color-tron-text-secondary)]">Removes this project. Member images are NOT deleted.</div>
			</div>
			<form method="POST" action="?/deleteProject">
				<button
					type="submit"
					onclick={(e) => { if (!confirm('Delete this project? Images are kept.')) e.preventDefault(); }}
					class="rounded border border-[var(--color-tron-red,#ff3366)] px-3 py-1.5 text-xs font-medium text-[var(--color-tron-red,#ff3366)]"
				>
					Delete
				</button>
			</form>
		</div>
	</div>
</div>
