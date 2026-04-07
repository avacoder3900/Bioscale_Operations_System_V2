<script lang="ts">
	import { CARTRIDGE_PHASES } from '$lib/types/cv';
	import type { ImageResponse, InspectionResponse } from '$lib/types/cv';

	let { data } = $props();

	let activePhaseFilter = $state('all');
	let selectedImage = $state<ImageResponse | null>(null);
	let lightboxOpen = $state(false);

	// Build inspection lookup by image_id
	const inspectionsByImage = $derived.by(() => {
		const map = new Map<string, InspectionResponse>();
		for (const insp of data.inspections) {
			map.set(insp.image_id, insp);
		}
		return map;
	});

	// Group images by phase
	const imagesByPhase = $derived.by(() => {
		const groups = new Map<string, ImageResponse[]>();
		for (const img of data.images) {
			const phase = img.cartridge_tag?.phase ?? 'untagged';
			if (!groups.has(phase)) groups.set(phase, []);
			groups.get(phase)!.push(img);
		}
		return groups;
	});

	// Get unique phases present
	const availablePhases = $derived([...imagesByPhase.keys()].sort());

	// Filtered images
	const filteredImages = $derived.by(() => {
		if (activePhaseFilter === 'all') return data.images;
		return imagesByPhase.get(activePhaseFilter) ?? [];
	});

	// Phase progress
	const phaseOrder = ['backing', 'wax_filled', 'reagent_filled', 'inspected', 'sealed', 'oven_cured', 'qaqc_released', 'shipped', 'testing', 'completed'];
	const currentPhaseIndex = $derived(phaseOrder.indexOf(data.cartridge.currentPhase ?? ''));

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleDateString('en-US', {
			month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
		});
	}

	function statusColor(status: string, result: string | null): string {
		if (status === 'pending') return 'bg-[var(--color-tron-yellow)] text-black';
		if (status === 'processing') return 'bg-blue-500 text-white';
		if (status === 'failed') return 'bg-gray-500 text-white';
		if (result === 'pass') return 'bg-[var(--color-tron-green)] text-black';
		if (result === 'fail') return 'bg-[var(--color-tron-red)] text-white';
		return 'bg-gray-500 text-white';
	}

	function statusLabel(status: string, result: string | null): string {
		if (status === 'pending') return 'Pending';
		if (status === 'processing') return 'Processing';
		if (status === 'failed') return 'Error';
		if (result === 'pass') return 'PASS';
		if (result === 'fail') return 'FAIL';
		return status;
	}

	function openLightbox(img: ImageResponse) {
		selectedImage = img;
		lightboxOpen = true;
	}

	function closeLightbox() {
		lightboxOpen = false;
	}

	function navigateImage(direction: number) {
		if (!selectedImage) return;
		const idx = filteredImages.indexOf(selectedImage);
		const newIdx = idx + direction;
		if (newIdx >= 0 && newIdx < filteredImages.length) {
			selectedImage = filteredImages[newIdx];
		}
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div>
		<a href="/cv/history" class="text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]">
			&larr; Back to History
		</a>
		<div class="mt-2 flex items-center justify-between">
			<div>
				<h1 class="text-2xl font-bold text-[var(--color-tron-text)]">
					Cartridge {data.cartridge._id}
				</h1>
				<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
					{data.images.length} image{data.images.length !== 1 ? 's' : ''} &middot;
					{data.inspections.length} inspection{data.inspections.length !== 1 ? 's' : ''}
				</p>
			</div>
			{#if data.cartridge.currentPhase}
				<span class="rounded-lg bg-[var(--color-tron-cyan)] px-3 py-1 text-sm font-semibold text-black">
					{data.cartridge.currentPhase.replace(/_/g, ' ')}
				</span>
			{/if}
		</div>
	</div>

	{#if data.cvError}
		<div class="rounded-lg border border-[var(--color-tron-yellow)] bg-[var(--color-tron-yellow)]/10 p-4">
			<p class="text-sm text-[var(--color-tron-yellow)]">{data.cvError}</p>
		</div>
	{/if}

	<!-- Phase progress bar -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
		<div class="flex items-center gap-1 overflow-x-auto">
			{#each phaseOrder as phase, i}
				<div class="flex items-center gap-1">
					<div
						class="rounded px-2 py-1 text-[10px] font-medium whitespace-nowrap
							{i <= currentPhaseIndex
								? 'bg-[var(--color-tron-cyan)] text-black'
								: 'bg-[var(--color-tron-bg-tertiary)] text-[var(--color-tron-text-secondary)]'}"
					>
						{phase.replace(/_/g, ' ')}
					</div>
					{#if i < phaseOrder.length - 1}
						<svg class="h-3 w-3 text-[var(--color-tron-text-secondary)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
						</svg>
					{/if}
				</div>
			{/each}
		</div>
	</div>

	<!-- Phase filter tabs -->
	<div class="flex items-center gap-2 border-b border-[var(--color-tron-border)] pb-0">
		<button
			class="px-3 py-2 text-sm font-medium transition-colors {activePhaseFilter === 'all'
				? 'border-b-2 border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
				: 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}"
			onclick={() => { activePhaseFilter = 'all'; }}
		>
			All ({data.images.length})
		</button>
		{#each availablePhases as phase}
			<button
				class="px-3 py-2 text-sm font-medium transition-colors {activePhaseFilter === phase
					? 'border-b-2 border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
					: 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}"
				onclick={() => { activePhaseFilter = phase; }}
			>
				{phase.replace(/_/g, ' ')} ({imagesByPhase.get(phase)?.length ?? 0})
			</button>
		{/each}
	</div>

	<!-- Image grid -->
	{#if filteredImages.length === 0}
		<div class="flex flex-col items-center justify-center rounded-lg border border-dashed border-[var(--color-tron-border)] py-16">
			<p class="text-sm text-[var(--color-tron-text-secondary)]">No images for this filter</p>
		</div>
	{:else}
		<div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
			{#each filteredImages as img (img.id)}
				{@const insp = inspectionsByImage.get(img.id)}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<div
					class="group cursor-pointer overflow-hidden rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] transition-colors hover:border-[var(--color-tron-cyan)]"
					onclick={() => openLightbox(img)}
				>
					<div class="relative aspect-video overflow-hidden">
						<img
							src="{data.cvBaseUrl}/api/v1/images/{img.id}/thumbnail"
							alt={img.filename}
							class="h-full w-full object-cover transition-transform group-hover:scale-105"
						/>
						{#if insp}
							<div class="absolute top-2 right-2">
								<span class="inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold {statusColor(insp.status, insp.result)}">
									{statusLabel(insp.status, insp.result)}
								</span>
							</div>
						{/if}
					</div>
					<div class="p-2 space-y-1">
						{#if img.cartridge_tag?.phase}
							<span class="inline-block rounded bg-[var(--color-tron-bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--color-tron-text-secondary)]">
								{img.cartridge_tag.phase.replace(/_/g, ' ')}
							</span>
						{/if}
						{#if img.cartridge_tag?.labels && img.cartridge_tag.labels.length > 0}
							<div class="flex flex-wrap gap-1">
								{#each img.cartridge_tag.labels.slice(0, 3) as label}
									<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-1 py-0.5 text-[9px] text-[var(--color-tron-text-secondary)]">
										{label.replace(/_/g, ' ')}
									</span>
								{/each}
							</div>
						{/if}
						<p class="text-[10px] text-[var(--color-tron-text-secondary)]">
							{formatDate(img.captured_at)}
						</p>
						{#if insp?.confidence_score !== null && insp?.confidence_score !== undefined}
							<div class="flex items-center gap-1">
								<div class="h-1 w-12 rounded-full bg-[var(--color-tron-bg-tertiary)]">
									<div
										class="h-full rounded-full {insp?.result === 'pass' ? 'bg-[var(--color-tron-green)]' : 'bg-[var(--color-tron-red)]'}"
										style="width: {Math.min(insp.confidence_score * 100, 100)}%"
									></div>
								</div>
								<span class="text-[9px] text-[var(--color-tron-text-secondary)]">
									{(insp.confidence_score * 100).toFixed(0)}%
								</span>
							</div>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<!-- Lightbox -->
{#if lightboxOpen && selectedImage}
	{@const insp = inspectionsByImage.get(selectedImage.id)}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/80" onclick={closeLightbox}>
		<div
			class="relative max-h-[90vh] max-w-4xl w-full mx-4 overflow-auto rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)]"
			onclick={(e) => e.stopPropagation()}
		>
			<!-- Close button -->
			<button
				class="absolute top-3 right-3 z-10 rounded-full bg-black/50 p-1.5 text-white hover:bg-black/70"
				onclick={closeLightbox}
			>
				<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
				</svg>
			</button>

			<!-- Navigation arrows -->
			<button
				class="absolute left-3 top-1/2 -translate-y-1/2 z-10 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
				onclick={(e) => { e.stopPropagation(); navigateImage(-1); }}
			>
				<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
				</svg>
			</button>
			<button
				class="absolute right-3 top-1/2 -translate-y-1/2 z-10 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
				onclick={(e) => { e.stopPropagation(); navigateImage(1); }}
			>
				<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
				</svg>
			</button>

			<!-- Image -->
			<img
				src="{data.cvBaseUrl}/api/v1/images/{selectedImage.id}/file"
				alt={selectedImage.filename}
				class="w-full"
			/>

			<!-- Info overlay -->
			<div class="p-4 space-y-3">
				<div class="flex items-center justify-between">
					<div class="flex items-center gap-2">
						{#if selectedImage.cartridge_tag?.phase}
							<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-2 py-0.5 text-xs text-[var(--color-tron-text)]">
								{selectedImage.cartridge_tag.phase.replace(/_/g, ' ')}
							</span>
						{/if}
						{#if insp}
							<span class="rounded px-2 py-0.5 text-xs font-semibold {statusColor(insp.status, insp.result)}">
								{statusLabel(insp.status, insp.result)}
							</span>
						{/if}
					</div>
					<span class="text-xs text-[var(--color-tron-text-secondary)]">
						{formatDate(selectedImage.captured_at)}
					</span>
				</div>

				{#if insp}
					<div class="grid grid-cols-3 gap-4 text-xs">
						<div>
							<span class="text-[var(--color-tron-text-secondary)]">Confidence</span>
							<p class="font-medium text-[var(--color-tron-text)]">
								{insp.confidence_score !== null ? `${(insp.confidence_score * 100).toFixed(1)}%` : '—'}
							</p>
						</div>
						<div>
							<span class="text-[var(--color-tron-text-secondary)]">Model</span>
							<p class="font-medium text-[var(--color-tron-text)]">{insp.model_version || '—'}</p>
						</div>
						<div>
							<span class="text-[var(--color-tron-text-secondary)]">Processing</span>
							<p class="font-medium text-[var(--color-tron-text)]">
								{insp.processing_time_ms ? `${insp.processing_time_ms}ms` : '—'}
							</p>
						</div>
					</div>

					{#if insp.defects && insp.defects.length > 0}
						<div class="space-y-1">
							<h3 class="text-xs font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Defects</h3>
							{#each insp.defects as defect}
								<div class="flex items-center gap-2 text-xs">
									<span class="{defect.severity === 'high' ? 'text-[var(--color-tron-red)]' : defect.severity === 'medium' ? 'text-[var(--color-tron-orange)]' : 'text-[var(--color-tron-yellow)]'} font-bold">
										{defect.severity === 'high' ? '!' : defect.severity === 'medium' ? '*' : '-'}
									</span>
									<span class="text-[var(--color-tron-text)]">{defect.type}</span>
									<span class="text-[var(--color-tron-text-secondary)]">- {defect.location}</span>
								</div>
							{/each}
						</div>
					{/if}
				{/if}

				{#if selectedImage.cartridge_tag?.labels && selectedImage.cartridge_tag.labels.length > 0}
					<div class="flex flex-wrap gap-1">
						{#each selectedImage.cartridge_tag.labels as label}
							<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-2 py-0.5 text-xs text-[var(--color-tron-text-secondary)]">
								{label.replace(/_/g, ' ')}
							</span>
						{/each}
					</div>
				{/if}

				{#if selectedImage.cartridge_tag?.notes}
					<p class="text-xs text-[var(--color-tron-text-secondary)] italic">
						{selectedImage.cartridge_tag.notes}
					</p>
				{/if}
			</div>
		</div>
	</div>
{/if}
