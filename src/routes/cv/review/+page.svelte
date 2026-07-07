<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';

	let { data, form } = $props();

	// Inspection IDs with an in-flight Agree/Overrule submit — disables that card's buttons.
	let submitting = $state(new Set<string>());

	function setFilter(key: 'project' | 'phase', value: string) {
		const params = new URLSearchParams($page.url.searchParams);
		if (value) params.set(key, value);
		else params.delete(key);
		goto(`/cv/review?${params.toString()}`, { invalidateAll: true });
	}

	function confidencePct(score: number | null): string | null {
		if (score === null || score === undefined) return null;
		return `${Math.min(score * 100, 100).toFixed(0)}%`;
	}

	function shortCartridge(id: string | null): string {
		if (!id) return 'no cartridge';
		return id.length > 12 ? `${id.slice(0, 12)}…` : id;
	}
</script>

<div class="space-y-4">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div>
			<h1 class="text-2xl font-bold text-[var(--color-tron-cyan)]">Needs Review</h1>
			<p class="text-sm text-[var(--color-tron-text-secondary)]">
				Model verdicts awaiting a human decision. Agree or Overrule — either way the result becomes
				a label for the next training iteration.
			</p>
		</div>
		<div class="text-right text-sm">
			<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-3 py-1 font-medium text-[var(--color-tron-cyan)]">
				{data.total} in queue
			</span>
			{#if data.filteredTotal !== data.total}
				<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">{data.filteredTotal} match filters</p>
			{/if}
		</div>
	</div>

	{#if form?.error}
		<div class="rounded border border-[var(--color-tron-red,#ff3366)] bg-[rgba(255,51,102,0.08)] p-3 text-sm text-[var(--color-tron-red,#ff3366)]">
			{form.error}
		</div>
	{/if}

	<!-- Filters -->
	<div class="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3">
		<div>
			<label for="rv-project" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">Project</label>
			<select
				id="rv-project"
				class="tron-input"
				value={data.filters.project}
				onchange={(e) => setFilter('project', (e.currentTarget as HTMLSelectElement).value)}
			>
				<option value="">All projects</option>
				{#each data.projectOptions as p (p.id)}
					<option value={p.id}>{p.name}</option>
				{/each}
			</select>
		</div>
		<div>
			<label for="rv-phase" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">Phase</label>
			<select
				id="rv-phase"
				class="tron-input"
				value={data.filters.phase}
				onchange={(e) => setFilter('phase', (e.currentTarget as HTMLSelectElement).value)}
			>
				<option value="">All phases</option>
				{#each data.phaseOptions as ph (ph)}
					<option value={ph}>{ph}</option>
				{/each}
			</select>
		</div>
		{#if data.filters.project || data.filters.phase}
			<a href="/cv/review" class="rounded px-3 py-2 text-sm text-[var(--color-tron-cyan)] underline">Clear filters</a>
		{/if}
		{#if data.filteredTotal > data.shown}
			<span class="ml-auto text-xs text-[var(--color-tron-text-secondary)]">
				Showing newest {data.shown} of {data.filteredTotal}
			</span>
		{/if}
	</div>

	{#if data.items.length === 0}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-12 text-center">
			<p class="text-[var(--color-tron-text-secondary)]">
				{data.total === 0 ? 'Queue is clear — every model verdict has been reviewed.' : 'No verdicts match the current filters.'}
			</p>
		</div>
	{:else}
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
			{#each data.items as item (item.inspectionId)}
				<div class="flex flex-col overflow-hidden rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
					<!-- Thumbnail -->
					{#if item.thumbnailUrl}
						<a href={item.url ?? item.thumbnailUrl} target="_blank" rel="noopener" class="block aspect-square bg-black">
							<img
								src={item.thumbnailUrl}
								alt="Cartridge {item.cartridgeRecordId ?? ''} at {item.phase ?? 'unknown phase'}"
								loading="lazy"
								class="h-full w-full object-cover"
							/>
						</a>
					{:else}
						<div class="flex aspect-square items-center justify-center bg-black text-xs text-[var(--color-tron-text-secondary)]">
							no image
						</div>
					{/if}

					<div class="flex flex-1 flex-col gap-2 p-3">
						<!-- Cartridge + phase -->
						<div class="text-xs">
							<p class="truncate font-mono text-[var(--color-tron-text)]" title={item.cartridgeRecordId ?? ''}>
								{shortCartridge(item.cartridgeRecordId)}
							</p>
							<p class="text-[var(--color-tron-text-secondary)]">
								{item.phase ?? 'unknown phase'}
								{#if item.capturedByUsername}
									• {item.capturedByUsername}
								{/if}
							</p>
						</div>

						<!-- Model verdict -->
						<div class="flex flex-wrap items-center gap-1.5 text-xs">
							{#if item.result === 'pass'}
								<span class="rounded bg-[var(--color-tron-green,#39ff14)] px-2 py-0.5 font-bold text-black">
									PASS{#if confidencePct(item.confidenceScore)}&nbsp;{confidencePct(item.confidenceScore)}{/if}
								</span>
							{:else}
								<span class="rounded bg-[var(--color-tron-red,#ff3366)] px-2 py-0.5 font-bold text-black">
									FAIL{#if confidencePct(item.confidenceScore)}&nbsp;{confidencePct(item.confidenceScore)}{/if}
								</span>
							{/if}
							{#if item.projectName}
								<span class="max-w-full truncate rounded bg-[var(--color-tron-bg-tertiary)] px-2 py-0.5 text-[var(--color-tron-text-secondary)]" title={item.projectName}>
									{item.projectName}
								</span>
							{/if}
						</div>
						{#if item.modelVersion}
							<p class="truncate text-[10px] text-[var(--color-tron-text-secondary)]" title={item.modelVersion}>
								{item.modelVersion}
							</p>
						{/if}

						<!-- Agree / Overrule -->
						<form
							method="POST"
							action="?/review"
							class="mt-auto grid grid-cols-2 gap-2"
							use:enhance={() => {
								submitting = new Set([...submitting, item.inspectionId]);
								return async ({ update }) => {
									await update();
									const next = new Set(submitting);
									next.delete(item.inspectionId);
									submitting = next;
								};
							}}
						>
							<input type="hidden" name="inspectionId" value={item.inspectionId} />
							<button
								type="submit"
								name="decision"
								value="agree"
								disabled={submitting.has(item.inspectionId)}
								class="rounded border border-[var(--color-tron-green,#39ff14)] px-2 py-1.5 text-xs font-medium text-[var(--color-tron-green,#39ff14)] transition-colors hover:bg-[rgba(57,255,20,0.15)] disabled:opacity-40"
								title="Confirm the model's {item.result} verdict"
							>
								Agree
							</button>
							<button
								type="submit"
								name="decision"
								value="overrule"
								disabled={submitting.has(item.inspectionId)}
								class="rounded border border-[var(--color-tron-red,#ff3366)] px-2 py-1.5 text-xs font-medium text-[var(--color-tron-red,#ff3366)] transition-colors hover:bg-[rgba(255,51,102,0.15)] disabled:opacity-40"
								title="Override to {item.result === 'pass' ? 'fail' : 'pass'}"
							>
								Overrule
							</button>
						</form>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
