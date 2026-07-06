<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	type Tab = 'deployment' | 'history';
	let activeTab = $state<Tab>('deployment');

	let submitting = $state(false);

	// Deployment state
	let phaseSelections = $state<Set<string>>(new Set(data.project.phases));
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

	function pct(v: number | null | undefined): string {
		return v == null ? '—' : `${(v * 100).toFixed(1)}%`;
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
				href={`/capture?projectId=${encodeURIComponent(data.project.id)}${data.project.phases[0] ? `&phase=${encodeURIComponent(data.project.phases[0])}` : ''}`}
				class="rounded bg-[var(--color-tron-green,#39ff14)] px-4 py-2 text-sm font-medium text-black"
				title={data.project.activeModelVersion
					? `Inference will auto-run for this project at phase ${data.project.phases.join(', ') || '(none configured)'}`
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
		<div class="grid gap-3 sm:grid-cols-3">
			<div>
				<div class="text-xs uppercase text-[var(--color-tron-text-secondary)]">Labeled photos (this scope)</div>
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
				<div class="text-xs uppercase text-[var(--color-tron-text-secondary)]">Phases</div>
				<div class="flex flex-wrap gap-1 text-xs">
					{#each data.project.phases as ph (ph)}
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
		{#each ['deployment', 'history'] as t (t)}
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

	{#if activeTab === 'deployment'}
		<div class="space-y-4">
			<!-- Phases: training + inference scope (one field) -->
			<form
				method="POST"
				action="?/updatePhases"
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
					<div class="mb-2 text-xs uppercase text-[var(--color-tron-text-secondary)]">Phases (training + inference scope)</div>
					<p class="mb-2 text-xs text-[var(--color-tron-text-secondary)]">
						The training set is every labeled photo captured at these phases. When a capture lands at any selected phase and this project has an active model, the model runs inference automatically.
					</p>
					<div class="grid gap-2 sm:grid-cols-3">
						{#each data.observedPhases as ph (ph)}
							{@const checked = phaseSelections.has(ph)}
							<label class="flex items-center gap-2 rounded border border-[var(--color-tron-border)] p-2 text-sm">
								<input
									type="checkbox"
									name="phase"
									value={ph}
									{checked}
									onchange={() => (phaseSelections = toggleSet(phaseSelections, ph))}
								/>
								<span>{ph}</span>
							</label>
						{/each}
					</div>
				</div>
				<button type="submit" disabled={submitting} class="rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-[var(--color-tron-bg-primary)] disabled:opacity-40">
					{submitting ? 'Saving…' : 'Save phases'}
				</button>
			</form>

			<!-- Active / shadow model selection -->
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
				<div class="grid gap-3 sm:grid-cols-2">
					<div>
						<label for="d-active" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">Active model version</label>
						<select id="d-active" name="activeModelVersion" bind:value={activeVersion} class="tron-input w-full">
							<option value="">— none —</option>
							{#each data.project.trainedModels as m (m.version)}
								<option value={m.version}>{m.version} (n={m.samplesUsed ?? '?'})</option>
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

			{#if data.project.shadowModelVersion}
				<form method="POST" action="?/clearShadow" use:enhance>
					<button type="submit" class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)]">
						Clear shadow model
					</button>
				</form>
			{/if}
		</div>

	{:else if activeTab === 'history'}
		<div class="space-y-4">
			<div class="flex flex-wrap items-end justify-between gap-3 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
				<div>
					<h3 class="text-sm font-semibold uppercase text-[var(--color-tron-text-secondary)]">Train a new model</h3>
					<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
						Fits a logistic-regression classifier in-process on the labeled photos in this project's phases. Needs ≥ 5 labeled photos with both classes present. Append-only — every run produces a new version and activates it.
					</p>
					<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
						Currently: <span class="font-mono text-[var(--color-tron-green,#39ff14)]">{data.labelStats.approved}</span> approved, <span class="font-mono text-[var(--color-tron-red,#ff3366)]">{data.labelStats.rejected}</span> rejected, {data.labelStats.unlabeled} unlabeled.
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
						<input id="train-threshold" name="confidenceThreshold" type="number" step="0.01" min="0" max="1" value={data.project.confidenceThreshold ?? 0.5} class="tron-input w-28" />
					</div>
					<button
						type="submit"
						disabled={submitting || data.labelStats.approved + data.labelStats.rejected < 5}
						class="rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-[var(--color-tron-bg-primary)] disabled:opacity-40"
						title={data.labelStats.approved + data.labelStats.rejected < 5
							? 'Need at least 5 labeled photos before training'
							: 'Train a new model version now'}
					>
						{submitting ? 'Training…' : 'Train new version'}
					</button>
				</form>
			</div>

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
									<th class="px-3 py-2 text-right">Holdout acc</th>
									<th class="px-3 py-2 text-right">Holdout F1</th>
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
										<td class="px-3 py-2 text-right">{m.samplesUsed ?? '—'}</td>
										<td class="px-3 py-2 text-right">{pct(m.holdoutAccuracy)}</td>
										<td class="px-3 py-2 text-right">{pct(m.holdoutF1)}</td>
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
				<div class="text-xs text-[var(--color-tron-text-secondary)]">Removes this project. Cartridge photos and their labels are NOT deleted.</div>
			</div>
			<form method="POST" action="?/deleteProject">
				<button
					type="submit"
					onclick={(e) => { if (!confirm('Delete this project? Photos and labels are kept.')) e.preventDefault(); }}
					class="rounded border border-[var(--color-tron-red,#ff3366)] px-3 py-1.5 text-xs font-medium text-[var(--color-tron-red,#ff3366)]"
				>
					Delete
				</button>
			</form>
		</div>
	</div>
</div>
