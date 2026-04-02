<script lang="ts">
	let { data } = $props();
	let activePhase = $state('all');
	let enlargedUrl = $state<string | null>(null);

	const filteredInspections = $derived(
		activePhase === 'all'
			? data.inspections
			: data.inspections.filter((i: any) => (i.phase || 'untagged') === activePhase)
	);

	function fmtDate(d: string) {
		return new Date(d).toLocaleString();
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<a href="/cv/history" class="text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]">&larr; History</a>
			<h2 class="text-2xl font-bold text-[var(--color-tron-cyan)]">Cartridge CV Timeline</h2>
			<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
				{data.cartridgeId}
				{#if data.cartridge}
					&middot; Phase: <span class="text-[var(--color-tron-text-primary)]">{data.cartridge.status || 'unknown'}</span>
				{/if}
			</p>
		</div>
		<a href="/cv/inspect" class="rounded-lg bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-black hover:opacity-90">New Inspection</a>
	</div>

	<!-- Stats -->
	<div class="grid grid-cols-3 gap-4">
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3 text-center">
			<div class="text-xl font-bold text-[var(--color-tron-text-primary)]">{data.inspections.length}</div>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">Inspections</div>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3 text-center">
			<div class="text-xl font-bold text-[var(--color-tron-green)]">{data.passCount}</div>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">Passed</div>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3 text-center">
			<div class="text-xl font-bold text-[var(--color-tron-red)]">{data.failCount}</div>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">Failed</div>
		</div>
	</div>

	<!-- Phase Filter Tabs -->
	<div class="flex flex-wrap gap-1">
		<button
			onclick={() => activePhase = 'all'}
			class="rounded-lg px-3 py-1.5 text-sm font-medium transition-colors {activePhase === 'all' ? 'bg-[var(--color-tron-cyan)] text-black' : 'text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-bg-tertiary)]'}"
		>
			All ({data.inspections.length})
		</button>
		{#each data.phases as phase}
			{@const count = data.inspections.filter((i: any) => (i.phase || 'untagged') === phase).length}
			<button
				onclick={() => activePhase = phase}
				class="rounded-lg px-3 py-1.5 text-sm font-medium transition-colors {activePhase === phase ? 'bg-[var(--color-tron-cyan)] text-black' : 'text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-bg-tertiary)]'}"
			>
				{phase.replace(/_/g, ' ')} ({count})
			</button>
		{/each}
	</div>

	<!-- Inspections Timeline -->
	{#if filteredInspections.length === 0}
		<div class="rounded-lg border border-dashed border-[var(--color-tron-border)] p-8 text-center text-[var(--color-tron-text-secondary)]">
			No inspections for this {activePhase === 'all' ? 'cartridge' : 'phase'}.
		</div>
	{:else}
		<div class="space-y-3">
			{#each filteredInspections as insp (insp._id)}
				{@const image = data.imageMap[insp.imageId]}
				<div class="flex gap-4 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
					<!-- Image thumbnail -->
					<div class="h-20 w-20 flex-shrink-0 overflow-hidden rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)]">
						{#if image?.imageUrl}
							<img src={image.imageUrl} alt="inspection" class="h-full w-full cursor-pointer object-cover" onclick={() => enlargedUrl = image.imageUrl} />
						{:else}
							<div class="flex h-full items-center justify-center text-xs text-[var(--color-tron-text-secondary)]">No img</div>
						{/if}
					</div>

					<!-- Details -->
					<div class="flex-1">
						<div class="flex items-center gap-2">
							{#if insp.result === 'pass'}
								<span class="rounded-full bg-[var(--color-tron-green)]/20 px-2 py-0.5 text-xs font-semibold text-[var(--color-tron-green)]">PASS</span>
							{:else if insp.result === 'fail'}
								<span class="rounded-full bg-[var(--color-tron-red)]/20 px-2 py-0.5 text-xs font-semibold text-[var(--color-tron-red)]">FAIL</span>
							{:else}
								<span class="animate-pulse rounded-full bg-[var(--color-tron-yellow)]/20 px-2 py-0.5 text-xs text-[var(--color-tron-yellow)]">{insp.status}</span>
							{/if}
							{#if insp.phase}
								<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-2 py-0.5 text-xs text-[var(--color-tron-text-secondary)]">{insp.phase.replace(/_/g, ' ')}</span>
							{/if}
							{#if insp.confidenceScore != null}
								<span class="text-sm text-[var(--color-tron-text-primary)]">{Math.round(insp.confidenceScore * 100)}%</span>
							{/if}
						</div>
						<div class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
							{fmtDate(insp.createdAt)}
							{#if insp.processingTimeMs} &middot; {Math.round(insp.processingTimeMs)}ms{/if}
							{#if insp.modelVersion} &middot; {insp.modelVersion}{/if}
						</div>
						{#if insp.defects?.length}
							<div class="mt-1 flex flex-wrap gap-1">
								{#each insp.defects as defect}
									<span class="rounded bg-[var(--color-tron-red)]/10 px-1.5 py-0.5 text-[10px] text-[var(--color-tron-red)]">{defect.type}: {defect.location}</span>
								{/each}
							</div>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}

	<!-- Enlarged image modal -->
	{#if enlargedUrl}
		<button class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm" onclick={() => enlargedUrl = null}>
			<img src={enlargedUrl} alt="enlarged" class="max-h-[85vh] max-w-[90vw] rounded-lg object-contain shadow-2xl" />
		</button>
	{/if}
</div>
