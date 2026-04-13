<script lang="ts">
	let { data } = $props();
	let activePhase = $state('all');
	let enlargedIndex = $state<number>(-1);

	const filteredInspections = $derived(
		activePhase === 'all'
			? data.inspections
			: data.inspections.filter((i: any) => (i.phase || 'untagged') === activePhase)
	);

	// Build flat list of images with metadata for lightbox navigation
	const imageList = $derived(
		filteredInspections
			.filter((i: any) => data.imageMap[i.imageId]?.imageUrl)
			.map((i: any) => ({
				url: data.imageMap[i.imageId].imageUrl,
				phase: i.phase || 'untagged',
				date: i.createdAt,
				result: i.result,
				confidence: i.confidenceScore
			}))
	);

	const enlargedUrl = $derived(enlargedIndex >= 0 && enlargedIndex < imageList.length ? imageList[enlargedIndex].url : null);
	const enlargedMeta = $derived(enlargedIndex >= 0 && enlargedIndex < imageList.length ? imageList[enlargedIndex] : null);

	function openLightbox(imageUrl: string) {
		const idx = imageList.findIndex((img: any) => img.url === imageUrl);
		enlargedIndex = idx >= 0 ? idx : -1;
	}

	function lightboxPrev() { if (enlargedIndex > 0) enlargedIndex--; }
	function lightboxNext() { if (enlargedIndex < imageList.length - 1) enlargedIndex++; }

	function handleLightboxKey(e: KeyboardEvent) {
		if (enlargedIndex < 0) return;
		if (e.key === 'ArrowLeft') lightboxPrev();
		else if (e.key === 'ArrowRight') lightboxNext();
		else if (e.key === 'Escape') enlargedIndex = -1;
	}

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
							<img src={image.imageUrl} alt="inspection" class="h-full w-full cursor-pointer object-cover" onclick={() => openLightbox(image.imageUrl)} />
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

	<!-- Enlarged image modal with navigation -->
	{#if enlargedUrl && enlargedMeta}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm" onkeydown={handleLightboxKey} onclick={() => enlargedIndex = -1}>
			<div class="relative flex max-h-[90vh] max-w-[92vw] flex-col items-center" onclick={(e) => e.stopPropagation()}>
				<!-- Close button -->
				<button onclick={() => enlargedIndex = -1} class="absolute -top-2 -right-2 z-10 rounded-full bg-[var(--color-tron-bg-secondary)] p-1.5 text-[var(--color-tron-text-secondary)] hover:text-white">
					<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" /></svg>
				</button>

				<!-- Navigation + Image -->
				<div class="flex items-center gap-3">
					{#if enlargedIndex > 0}
						<button onclick={lightboxPrev} class="rounded-lg bg-[var(--color-tron-bg-secondary)] p-2 text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]">
							<svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" /></svg>
						</button>
					{:else}
						<div class="w-10"></div>
					{/if}

					<img src={enlargedUrl} alt="enlarged" class="max-h-[75vh] max-w-[75vw] rounded-lg object-contain shadow-2xl" />

					{#if enlargedIndex < imageList.length - 1}
						<button onclick={lightboxNext} class="rounded-lg bg-[var(--color-tron-bg-secondary)] p-2 text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]">
							<svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" /></svg>
						</button>
					{:else}
						<div class="w-10"></div>
					{/if}
				</div>

				<!-- Metadata bar -->
				<div class="mt-3 flex items-center gap-3 rounded-lg bg-[var(--color-tron-bg-secondary)] px-4 py-2 text-sm">
					<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-2 py-0.5 text-xs text-[var(--color-tron-text-secondary)]">{enlargedMeta.phase.replace(/_/g, ' ')}</span>
					{#if enlargedMeta.result === 'pass'}
						<span class="text-[var(--color-tron-green)]">PASS</span>
					{:else if enlargedMeta.result === 'fail'}
						<span class="text-[var(--color-tron-red)]">FAIL</span>
					{/if}
					{#if enlargedMeta.confidence != null}
						<span class="text-[var(--color-tron-text-secondary)]">{Math.round(enlargedMeta.confidence * 100)}%</span>
					{/if}
					<span class="text-[var(--color-tron-text-secondary)]">{fmtDate(enlargedMeta.date)}</span>
					<span class="text-xs text-[var(--color-tron-text-secondary)]">{enlargedIndex + 1} / {imageList.length}</span>
				</div>
			</div>
		</div>
	{/if}
</div>
