<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	let isTraining = $state(false);
	let trainMessage = $state<string | null>(null);

	async function startTraining() {
		isTraining = true;
		trainMessage = null;
		try {
			const res = await fetch('/api/cv/train', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ projectId: data.master._id })
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
			trainMessage = `Training started: ${body.message ?? 'job queued'}`;
		} catch (err: any) {
			trainMessage = `Training failed: ${err.message}`;
		} finally {
			isTraining = false;
		}
	}

	const totalLabeled = $derived(data.totals.approved + data.totals.rejected);
	const labelCoverage = $derived(
		(data.totals.approved + data.totals.rejected + data.totals.unlabeled) === 0
			? 0
			: Math.round(100 * totalLabeled / (data.totals.approved + data.totals.rejected + data.totals.unlabeled))
	);
</script>

<div class="space-y-6">
	<header>
		<a href="/cv" class="text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]">&larr; Back to CV projects</a>
		<h1 class="mt-2 text-2xl font-bold text-[var(--color-tron-text)]">Master CV Model</h1>
		<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">One model, trained on labeled photos from every CV project. Pass/fail decisions for cartridge photos use this model's threshold.</p>
	</header>

	<!-- Configuration -->
	<form method="POST" action="?/updateConfig" use:enhance class="space-y-4 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]/30 p-4">
		<div class="flex items-center justify-between">
			<h2 class="text-sm font-semibold text-[var(--color-tron-text)]">Configuration</h2>
			<span class="rounded border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-cyan)]/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-tron-cyan)]">{data.master.modelStatus}</span>
		</div>

		<div>
			<label for="name" class="block text-xs text-[var(--color-tron-text-secondary)]">Model name</label>
			<input id="name" name="name" type="text" value={data.master.name}
				class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text)]" />
		</div>

		<div>
			<label for="purpose" class="block text-xs text-[var(--color-tron-text-secondary)]">Purpose — what this model decides about a cartridge photo</label>
			<textarea id="purpose" name="purpose" rows="3"
				class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
			>{data.master.purpose ?? ''}</textarea>
		</div>

		<div>
			<label for="confidenceThreshold" class="block text-xs text-[var(--color-tron-text-secondary)]">
				Pass/fail threshold (anomaly score &ge; {data.master.confidenceThreshold} = fail)
			</label>
			<div class="mt-1 flex items-center gap-3">
				<input id="confidenceThreshold" name="confidenceThreshold" type="number" min="0" max="1" step="0.01"
					value={data.master.confidenceThreshold}
					class="w-24 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-2 py-1 text-sm text-[var(--color-tron-text)]" />
				<span class="text-xs text-[var(--color-tron-text-secondary)]">0 = anything fails, 1 = nothing fails</span>
			</div>
		</div>

		<div class="flex items-center gap-3">
			<button type="submit" class="rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)]">Save</button>
			{#if form?.success}
				<span class="text-xs text-[var(--color-tron-green)]">Saved.</span>
			{:else if form?.error}
				<span class="text-xs text-[var(--color-tron-error)]">{form.error}</span>
			{/if}
		</div>
	</form>

	<!-- Aggregate stats -->
	<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]/30 p-4">
		<div class="mb-3 flex items-center justify-between">
			<h2 class="text-sm font-semibold text-[var(--color-tron-text)]">Training set — across every project</h2>
			<button type="button" onclick={startTraining} disabled={isTraining || totalLabeled < 5}
				class="rounded border border-[var(--color-tron-green)]/50 bg-[var(--color-tron-green)]/20 px-4 py-2 text-sm font-medium text-[var(--color-tron-green)] disabled:opacity-50">
				{isTraining ? 'Starting...' : 'Train master model'}
			</button>
		</div>
		<div class="mb-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
			<div class="rounded border border-[var(--color-tron-border)] p-3"><div class="text-[var(--color-tron-text-secondary)]">Approved</div><div class="mt-1 text-2xl text-[var(--color-tron-green)]">{data.totals.approved}</div></div>
			<div class="rounded border border-[var(--color-tron-border)] p-3"><div class="text-[var(--color-tron-text-secondary)]">Rejected</div><div class="mt-1 text-2xl text-[var(--color-tron-error)]">{data.totals.rejected}</div></div>
			<div class="rounded border border-[var(--color-tron-border)] p-3"><div class="text-[var(--color-tron-text-secondary)]">Unlabeled</div><div class="mt-1 text-2xl text-[var(--color-tron-text)]">{data.totals.unlabeled}</div></div>
			<div class="rounded border border-[var(--color-tron-border)] p-3"><div class="text-[var(--color-tron-text-secondary)]">Coverage</div><div class="mt-1 text-2xl text-[var(--color-tron-cyan)]">{labelCoverage}%</div></div>
		</div>
		{#if trainMessage}
			<div class="mb-3 rounded border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-cyan)]/10 p-2 text-xs text-[var(--color-tron-cyan)]">{trainMessage}</div>
		{/if}
		{#if totalLabeled < 5}
			<div class="mb-3 rounded border border-yellow-500/40 bg-yellow-900/20 p-2 text-xs text-yellow-300">Need at least 5 labeled images to train. Currently: {totalLabeled}.</div>
		{/if}

		<table class="w-full text-xs">
			<thead>
				<tr class="border-b border-[var(--color-tron-border)] text-left text-[var(--color-tron-text-secondary)]">
					<th class="py-2">Project</th>
					<th class="py-2 text-right">Approved</th>
					<th class="py-2 text-right">Rejected</th>
					<th class="py-2 text-right">Unlabeled</th>
					<th class="py-2 text-right">Status</th>
				</tr>
			</thead>
			<tbody>
				{#each data.projectStats as p}
					<tr class="border-b border-[var(--color-tron-border)]/40">
						<td class="py-2">
							<a class="text-[var(--color-tron-cyan)] hover:underline" href="/cv/projects/{p.projectId}">{p.name}</a>
							{#if p.isMaster}<span class="ml-2 rounded bg-[var(--color-tron-cyan)]/20 px-1.5 text-[10px] text-[var(--color-tron-cyan)]">master</span>{/if}
						</td>
						<td class="py-2 text-right text-[var(--color-tron-green)]">{p.approved}</td>
						<td class="py-2 text-right text-[var(--color-tron-error)]">{p.rejected}</td>
						<td class="py-2 text-right text-[var(--color-tron-text-secondary)]">{p.unlabeled}</td>
						<td class="py-2 text-right text-[var(--color-tron-text-secondary)]">{p.modelStatus}</td>
					</tr>
				{/each}
				{#if data.projectStats.length === 0}
					<tr><td colspan="5" class="py-4 text-center text-[var(--color-tron-text-secondary)]">No CV projects yet.</td></tr>
				{/if}
			</tbody>
		</table>
	</section>

	<!-- Labeled preview -->
	{#if data.labeledPreview.length > 0}
		<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]/30 p-4">
			<h2 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Recent labeled images ({data.labeledPreview.length})</h2>
			<div class="grid grid-cols-3 gap-2 sm:grid-cols-6 lg:grid-cols-8">
				{#each data.labeledPreview as img (img.imageId)}
					<div class="relative">
						{#if img.url}
							<img src={img.thumbnailUrl ?? img.url} alt="labeled {img.label}" class="h-20 w-full rounded border-2 object-cover {img.label === 'approved' ? 'border-[var(--color-tron-green)]/60' : 'border-[var(--color-tron-error)]/60'}" loading="lazy" />
						{:else}
							<div class="flex h-20 w-full items-center justify-center rounded border border-[var(--color-tron-border)] text-[10px] text-[var(--color-tron-text-secondary)]">no url</div>
						{/if}
						<div class="absolute bottom-0 left-0 right-0 truncate bg-black/60 px-1 py-0.5 text-[10px] text-white">
							{img.label} · {img.projectName}
						</div>
					</div>
				{/each}
			</div>
		</section>
	{/if}

	<!-- Recent inspections (master model results) -->
	{#if data.recentInspections.length > 0}
		<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]/30 p-4">
			<h2 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Master-model inspection results (last 20)</h2>
			<table class="w-full text-xs">
				<thead>
					<tr class="border-b border-[var(--color-tron-border)] text-left text-[var(--color-tron-text-secondary)]">
						<th class="py-2">Cartridge</th>
						<th class="py-2">Phase</th>
						<th class="py-2 text-right">Confidence</th>
						<th class="py-2 text-right">Result</th>
						<th class="py-2 text-right">When</th>
					</tr>
				</thead>
				<tbody>
					{#each data.recentInspections as ins}
						<tr class="border-b border-[var(--color-tron-border)]/40">
							<td class="py-2 font-mono text-[var(--color-tron-text)]">{ins.cartridgeRecordId ?? '—'}</td>
							<td class="py-2 text-[var(--color-tron-text-secondary)]">{ins.phase ?? '—'}</td>
							<td class="py-2 text-right text-[var(--color-tron-text)]">{ins.confidenceScore?.toFixed?.(3) ?? '—'}</td>
							<td class="py-2 text-right {ins.result === 'pass' ? 'text-[var(--color-tron-green)]' : ins.result === 'fail' ? 'text-[var(--color-tron-error)]' : 'text-[var(--color-tron-text-secondary)]'}">{ins.result ?? ins.status}</td>
							<td class="py-2 text-right text-[var(--color-tron-text-secondary)]">{ins.completedAt ? new Date(ins.completedAt).toLocaleString() : '—'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>
	{/if}
</div>
