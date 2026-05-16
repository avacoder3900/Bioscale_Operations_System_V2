<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	type Tab = 'members' | 'composition' | 'deployment' | 'history';
	let activeTab = $state<Tab>('members');

	let submitting = $state(false);

	// Composition picker state
	let composedOfSelections = $state<Set<string>>(new Set(data.project.composedOf));
	let liveCompositionToggle = $state(data.project.isLiveComposition);

	// Deployment state
	let deploySelections = $state<Set<string>>(new Set(data.project.deployAtPhases));
	let activeVersion = $state<string>(data.project.activeModelVersion ?? '');
	let shadowVersion = $state<string>(data.project.shadowModelVersion ?? '');

	function toggleSet<T>(set: Set<T>, val: T): Set<T> {
		const next = new Set(set);
		if (next.has(val)) next.delete(val); else next.add(val);
		return next;
	}

	function fmt(d: string | Date | null): string {
		if (!d) return '—';
		return new Date(d).toLocaleString();
	}
</script>

<div class="space-y-4">
	<header class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<a href="/cv/projects" class="text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]">← all projects</a>
			<h1 class="mt-1 text-2xl font-bold text-[var(--color-tron-cyan)]">{data.project.name}</h1>
			{#if data.project.description}<p class="text-sm text-[var(--color-tron-text-secondary)]">{data.project.description}</p>{/if}
		</div>
		<div class="text-right text-xs text-[var(--color-tron-text-secondary)]">
			<div>created {fmt(data.project.createdAt)}</div>
			<div>updated {fmt(data.project.updatedAt)}</div>
		</div>
	</header>

	{#if form?.error}
		<div class="rounded border border-[var(--color-tron-red,#ff3366)] bg-[rgba(255,51,102,0.08)] p-3 text-sm text-[var(--color-tron-red,#ff3366)]">{form.error}</div>
	{/if}
	{#if form?.success}
		<div class="rounded border border-[var(--color-tron-green,#39ff14)] bg-[rgba(57,255,20,0.08)] p-3 text-sm text-[var(--color-tron-green,#39ff14)]">Saved.</div>
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

	<!-- Tabs -->
	<div class="flex gap-1 border-b border-[var(--color-tron-border)]">
		{#each ['members', 'composition', 'deployment', 'history'] as t (t)}
			<button
				type="button"
				class="px-4 py-2 text-sm font-medium
					{activeTab === t
						? 'border-b-2 border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
						: 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}"
				onclick={() => (activeTab = t as Tab)}
			>
				{t.charAt(0).toUpperCase() + t.slice(1)}
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

	{:else if activeTab === 'deployment'}
		<form
			method="POST"
			action="?/updateDeployment"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update();
					submitting = false;
				};
			}}
			class="space-y-4 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4"
		>
			<div>
				<div class="mb-2 text-xs uppercase text-[var(--color-tron-text-secondary)]">Deploy at phases</div>
				<p class="mb-2 text-xs text-[var(--color-tron-text-secondary)]">
					When a capture lands at any selected phase and this project has an active model, the model runs inference automatically.
				</p>
				<div class="grid gap-2 sm:grid-cols-3">
					{#each data.observedPhases as ph (ph)}
						{@const checked = deploySelections.has(ph)}
						<label class="flex items-center gap-2 rounded border border-[var(--color-tron-border)] p-2 text-sm">
							<input
								type="checkbox"
								name="phase"
								value={ph}
								{checked}
								onchange={() => (deploySelections = toggleSet(deploySelections, ph))}
							/>
							<span>{ph}</span>
						</label>
					{/each}
				</div>
			</div>

			<div class="grid gap-3 sm:grid-cols-2">
				<div>
					<label for="d-active" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">Active model version</label>
					<select id="d-active" name="activeModelVersion" bind:value={activeVersion} class="tron-input w-full">
						<option value="">— none —</option>
						{#each data.project.trainedModels as m (m.version)}
							<option value={m.version}>{m.version} (n={m.sampleCount ?? '?'})</option>
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

			<div class="flex gap-2">
				<button type="submit" disabled={submitting} class="rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-[var(--color-tron-bg-primary)] disabled:opacity-40">
					{submitting ? 'Saving…' : 'Save deployment'}
				</button>
			</div>
		</form>

	{:else if activeTab === 'history'}
		<div class="space-y-4">
			<div>
				<h3 class="mb-2 text-sm font-semibold uppercase text-[var(--color-tron-text-secondary)]">Trained models</h3>
				{#if data.project.trainedModels.length === 0}
					<p class="text-sm text-[var(--color-tron-text-secondary)]">No models trained yet.</p>
				{:else}
					<div class="overflow-x-auto rounded border border-[var(--color-tron-border)]">
						<table class="w-full text-sm">
							<thead class="bg-[var(--color-tron-bg-tertiary)] text-xs uppercase text-[var(--color-tron-text-secondary)]">
								<tr>
									<th class="px-3 py-2 text-left">Version</th>
									<th class="px-3 py-2 text-left">Trained at</th>
									<th class="px-3 py-2 text-left">By</th>
									<th class="px-3 py-2 text-right">Samples</th>
									<th class="px-3 py-2 text-right">Threshold</th>
									<th class="px-3 py-2"></th>
								</tr>
							</thead>
							<tbody>
								{#each data.project.trainedModels as m (m.version)}
									<tr class="border-t border-[var(--color-tron-border)]">
										<td class="px-3 py-2 font-mono text-[var(--color-tron-cyan)]">{m.version}</td>
										<td class="px-3 py-2 text-[var(--color-tron-text-secondary)]">{fmt(m.trainedAt)}</td>
										<td class="px-3 py-2 text-[var(--color-tron-text-secondary)]">{m.trainedBy?.username ?? '—'}</td>
										<td class="px-3 py-2 text-right">{m.sampleCount ?? '—'}</td>
										<td class="px-3 py-2 text-right">{m.confidenceThreshold ?? '—'}</td>
										<td class="px-3 py-2 text-right text-xs">
											{#if m.version === data.project.activeModelVersion}<span class="text-[var(--color-tron-green,#39ff14)]">ACTIVE</span>{/if}
											{#if m.version === data.project.shadowModelVersion}<span class="text-[var(--color-tron-cyan)]">SHADOW</span>{/if}
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
