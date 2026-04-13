<script lang="ts">
	let { data } = $props();

	let activePhaseFilter = $state('all');
	let selectedPhoto = $state<any>(null);
	let lightboxOpen = $state(false);

	// All phases in pipeline order
	const phaseOrder = [
		'backing', 'wax_filling', 'wax_qc', 'wax_storage',
		'reagent_filling', 'reagent_inspection',
		'top_seal', 'oven_cure', 'storage', 'qa_qc', 'shipping'
	];

	// Current phase index for progress bar
	const currentStepIndex = $derived(() => {
		for (let i = data.timeline.length - 1; i >= 0; i--) {
			const idx = phaseOrder.indexOf(data.timeline[i].step);
			if (idx !== -1) return idx;
		}
		return -1;
	});

	// Available phase filters (only phases that have photos)
	const phasesWithPhotos = $derived([...new Set(data.photos.map((p: any) => p.phase))]);

	// Filtered photos
	const filteredPhotos = $derived.by(() => {
		if (activePhaseFilter === 'all') return data.photos;
		return data.photos.filter((p: any) => p.phase === activePhaseFilter);
	});

	function formatDate(iso: string): string {
		if (!iso) return '---';
		return new Date(iso).toLocaleDateString('en-US', {
			month: 'short', day: 'numeric', year: 'numeric',
			hour: '2-digit', minute: '2-digit'
		});
	}

	function formatShortDate(iso: string): string {
		if (!iso) return '---';
		return new Date(iso).toLocaleDateString('en-US', {
			month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
		});
	}

	function phaseLabel(step: string): string {
		return step.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
	}

	function statusColor(status: string): string {
		const colors: Record<string, string> = {
			backing: 'bg-gray-500', wax_filling: 'bg-blue-600', wax_qc: 'bg-blue-400',
			wax_storage: 'bg-indigo-500', reagent_filling: 'bg-purple-500',
			reagent_inspection: 'bg-violet-500', top_seal: 'bg-fuchsia-500',
			oven_cure: 'bg-pink-500', storage: 'bg-amber-500',
			qa_qc: 'bg-[var(--color-tron-green)]', shipping: 'bg-[var(--color-tron-cyan)]',
			released: 'bg-[var(--color-tron-green)]', completed: 'bg-[var(--color-tron-green)]',
			cancelled: 'bg-[var(--color-tron-red)]', scrapped: 'bg-[var(--color-tron-red)]',
			voided: 'bg-gray-600'
		};
		return colors[status] || 'bg-gray-500';
	}

	function inspectionBadge(result: string | null, status: string | null): { text: string; color: string } {
		if (status === 'pending') return { text: 'PENDING', color: 'bg-[var(--color-tron-yellow)] text-black' };
		if (status === 'processing') return { text: 'PROCESSING', color: 'bg-blue-500 text-white' };
		if (status === 'failed') return { text: 'ERROR', color: 'bg-gray-500 text-white' };
		if (result === 'pass') return { text: 'PASS', color: 'bg-[var(--color-tron-green)] text-black' };
		if (result === 'fail') return { text: 'FAIL', color: 'bg-[var(--color-tron-red)] text-white' };
		return { text: '', color: '' };
	}

	function openLightbox(photo: any) {
		selectedPhoto = photo;
		lightboxOpen = true;
	}

	function closeLightbox() {
		lightboxOpen = false;
	}

	function navigatePhoto(direction: number) {
		if (!selectedPhoto) return;
		const idx = filteredPhotos.indexOf(selectedPhoto);
		const newIdx = idx + direction;
		if (newIdx >= 0 && newIdx < filteredPhotos.length) {
			selectedPhoto = filteredPhotos[newIdx];
		}
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div>
		<a href="/cartridge-admin/dhr" class="text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]">
			&larr; Back to DHR Search
		</a>
		<div class="mt-2 flex items-center justify-between">
			<div>
				<h1 class="text-2xl font-bold text-[var(--color-tron-text)]">
					{data.cartridge.cartridgeId}
				</h1>
				<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
					Device History Record &middot;
					{data.photos.length} photo{data.photos.length !== 1 ? 's' : ''} &middot;
					{data.inspections.length} inspection{data.inspections.length !== 1 ? 's' : ''} &middot;
					Created {formatShortDate(data.cartridge.createdAt)}
				</p>
			</div>
			<span class="rounded-lg px-3 py-1 text-sm font-semibold text-white {statusColor(data.cartridge.status)}">
				{phaseLabel(data.cartridge.status)}
			</span>
		</div>
		{#if data.cartridge.voidedAt}
			<div class="mt-2 rounded-lg border border-[var(--color-tron-red)] bg-[var(--color-tron-red)]/10 p-3">
				<p class="text-sm text-[var(--color-tron-red)]">
					VOIDED &mdash; {data.cartridge.voidReason || 'No reason provided'}
				</p>
			</div>
		{/if}
	</div>

	<!-- Phase progress bar -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
		<h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Manufacturing Progress</h2>
		<div class="flex items-center gap-1 overflow-x-auto">
			{#each phaseOrder as phase, i}
				{@const isCompleted = i <= currentStepIndex()}
				{@const timelineEntry = data.timeline.find((t: any) => t.step === phase)}
				<div class="flex items-center gap-1">
					<div
						class="rounded px-2 py-1 text-[10px] font-medium whitespace-nowrap
							{isCompleted
								? 'bg-[var(--color-tron-cyan)] text-black'
								: 'bg-[var(--color-tron-bg-tertiary)] text-[var(--color-tron-text-secondary)]'}"
						title={timelineEntry ? `${phaseLabel(phase)} - ${formatShortDate(timelineEntry.timestamp)}` : phaseLabel(phase)}
					>
						{phaseLabel(phase)}
						{#if timelineEntry?.photos?.length}
							<span class="ml-1 opacity-70">({timelineEntry.photos.length})</span>
						{/if}
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

	<!-- Timeline -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
		<h2 class="mb-4 text-xs font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Manufacturing Timeline</h2>
		{#if data.timeline.length === 0}
			<p class="text-sm text-[var(--color-tron-text-secondary)]">No timeline entries yet.</p>
		{:else}
			<div class="space-y-0">
				{#each data.timeline as entry, i}
					<div class="relative flex gap-4 pb-6 {i < data.timeline.length - 1 ? '' : ''}">
						<!-- Timeline line -->
						{#if i < data.timeline.length - 1}
							<div class="absolute left-[11px] top-6 bottom-0 w-0.5 bg-[var(--color-tron-border)]"></div>
						{/if}
						<!-- Timeline dot -->
						<div class="relative z-10 mt-1 h-6 w-6 shrink-0 rounded-full border-2 border-[var(--color-tron-cyan)] bg-[var(--color-tron-bg)] flex items-center justify-center">
							{#if entry.photos?.length > 0}
								<svg class="h-3 w-3 text-[var(--color-tron-cyan)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
									<path stroke-linecap="round" stroke-linejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
								</svg>
							{:else}
								<div class="h-2 w-2 rounded-full bg-[var(--color-tron-cyan)]"></div>
							{/if}
						</div>
						<!-- Content -->
						<div class="flex-1 min-w-0">
							<div class="flex items-center justify-between">
								<h3 class="text-sm font-semibold text-[var(--color-tron-text)]">{phaseLabel(entry.step)}</h3>
								<span class="text-xs text-[var(--color-tron-text-secondary)]">{formatShortDate(entry.timestamp)}</span>
							</div>
							{#if entry.operator}
								<p class="text-xs text-[var(--color-tron-text-secondary)]">Operator: {entry.operator}</p>
							{/if}
							<!-- Phase-specific details -->
							<div class="mt-1 flex flex-wrap gap-2">
								{#if entry.runId}
									<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--color-tron-text-secondary)]">Run: {entry.runId}</span>
								{/if}
								{#if entry.robotName}
									<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--color-tron-text-secondary)]">Robot: {entry.robotName}</span>
								{/if}
								{#if entry.assayType}
									<span class="rounded bg-purple-500/20 px-1.5 py-0.5 text-[10px] text-purple-300">Assay: {entry.assayType}</span>
								{/if}
								{#if entry.lotId}
									<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--color-tron-text-secondary)]">Lot: {entry.lotId}</span>
								{/if}
								{#if entry.qcStatus}
									<span class="rounded px-1.5 py-0.5 text-[10px] font-semibold
										{entry.qcStatus === 'Accepted' ? 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]' :
										 entry.qcStatus === 'Rejected' ? 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]' :
										 'bg-[var(--color-tron-yellow)]/20 text-[var(--color-tron-yellow)]'}">
										{entry.qcStatus}
									</span>
								{/if}
								{#if entry.testResult}
									<span class="rounded px-1.5 py-0.5 text-[10px] font-semibold
										{entry.testResult === 'pass' ? 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]' :
										 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]'}">
										{entry.testResult.toUpperCase()}
									</span>
								{/if}
								{#if entry.trackingNumber}
									<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--color-tron-text-secondary)]">Tracking: {entry.trackingNumber}</span>
								{/if}
								{#if entry.customer}
									<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--color-tron-text-secondary)]">Customer: {entry.customer}</span>
								{/if}
								{#if entry.fridgeName}
									<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--color-tron-text-secondary)]">Fridge: {entry.fridgeName}</span>
								{/if}
								{#if entry.coolingTrayId}
									<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--color-tron-text-secondary)]">Tray: {entry.coolingTrayId}</span>
								{/if}
								{#if entry.locationName}
									<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--color-tron-text-secondary)]">Location: {entry.locationName}</span>
								{/if}
							</div>
							<!-- Inline photos for this phase -->
							{#if entry.photos?.length > 0}
								<div class="mt-2 flex gap-2 overflow-x-auto">
									{#each entry.photos as photo}
										{@const badge = inspectionBadge(photo.inspectionResult, photo.inspectionStatus)}
										<!-- svelte-ignore a11y_no_static_element_interactions -->
										<!-- svelte-ignore a11y_click_events_have_key_events -->
										<div
											class="group relative shrink-0 cursor-pointer overflow-hidden rounded-lg border border-[var(--color-tron-border)] transition-colors hover:border-[var(--color-tron-cyan)]"
											onclick={() => openLightbox(photo)}
										>
											<div class="relative h-20 w-28 overflow-hidden">
												<img
													src={photo.thumbnailUrl || photo.url}
													alt="Phase {photo.phase}"
													class="h-full w-full object-cover transition-transform group-hover:scale-105"
												/>
												{#if badge.text}
													<div class="absolute top-1 right-1">
														<span class="inline-block rounded px-1 py-0.5 text-[8px] font-semibold {badge.color}">{badge.text}</span>
													</div>
												{/if}
											</div>
										</div>
									{/each}
								</div>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>

	<!-- Photo Gallery -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
		<h2 class="mb-4 text-xs font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">
			All Photos ({data.photos.length})
		</h2>

		<!-- Phase filter tabs -->
		{#if data.photos.length > 0}
			<div class="mb-4 flex items-center gap-2 border-b border-[var(--color-tron-border)] pb-0">
				<button
					class="px-3 py-2 text-sm font-medium transition-colors {activePhaseFilter === 'all'
						? 'border-b-2 border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
						: 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}"
					onclick={() => { activePhaseFilter = 'all'; }}
				>
					All ({data.photos.length})
				</button>
				{#each phasesWithPhotos as phase}
					<button
						class="px-3 py-2 text-sm font-medium transition-colors {activePhaseFilter === phase
							? 'border-b-2 border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
							: 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}"
						onclick={() => { activePhaseFilter = phase; }}
					>
						{phaseLabel(phase)} ({data.photos.filter((p: any) => p.phase === phase).length})
					</button>
				{/each}
			</div>
		{/if}

		<!-- Photo grid -->
		{#if filteredPhotos.length === 0}
			<div class="flex flex-col items-center justify-center rounded-lg border border-dashed border-[var(--color-tron-border)] py-12">
				<svg class="mb-2 h-8 w-8 text-[var(--color-tron-text-secondary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
					<path stroke-linecap="round" stroke-linejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
				</svg>
				<p class="text-sm text-[var(--color-tron-text-secondary)]">No photos captured yet</p>
			</div>
		{:else}
			<div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
				{#each filteredPhotos as photo (photo.imageId)}
					{@const badge = inspectionBadge(photo.inspectionResult, photo.inspectionStatus)}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<div
						class="group cursor-pointer overflow-hidden rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] transition-colors hover:border-[var(--color-tron-cyan)]"
						onclick={() => openLightbox(photo)}
					>
						<div class="relative aspect-video overflow-hidden">
							<img
								src={photo.thumbnailUrl || photo.url}
								alt="Phase {photo.phase}"
								class="h-full w-full object-cover transition-transform group-hover:scale-105"
							/>
							{#if badge.text}
								<div class="absolute top-2 right-2">
									<span class="inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold {badge.color}">{badge.text}</span>
								</div>
							{/if}
						</div>
						<div class="p-2 space-y-1">
							<span class="inline-block rounded bg-[var(--color-tron-bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--color-tron-text-secondary)]">
								{phaseLabel(photo.phase)}
							</span>
							{#if photo.labels?.length > 0}
								<div class="flex flex-wrap gap-1">
									{#each photo.labels.slice(0, 3) as label}
										<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-1 py-0.5 text-[9px] text-[var(--color-tron-text-secondary)]">
											{label.replace(/_/g, ' ')}
										</span>
									{/each}
								</div>
							{/if}
							<p class="text-[10px] text-[var(--color-tron-text-secondary)]">
								{formatShortDate(photo.capturedAt)}
							</p>
							{#if photo.confidenceScore !== null}
								<div class="flex items-center gap-1">
									<div class="h-1 w-12 rounded-full bg-[var(--color-tron-bg-tertiary)]">
										<div
											class="h-full rounded-full {photo.inspectionResult === 'pass' ? 'bg-[var(--color-tron-green)]' : 'bg-[var(--color-tron-red)]'}"
											style="width: {Math.min(photo.confidenceScore * 100, 100)}%"
										></div>
									</div>
									<span class="text-[9px] text-[var(--color-tron-text-secondary)]">
										{(photo.confidenceScore * 100).toFixed(0)}%
									</span>
								</div>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>

	<!-- Linked Lots -->
	{#if data.linkedLots.length > 0}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			<h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Linked Lots</h2>
			<div class="flex flex-wrap gap-2">
				{#each data.linkedLots as lot}
					<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-xs">
						<span class="font-mono text-[var(--color-tron-text)]">{lot.lotId || lot._id}</span>
						{#if lot.lotNumber}
							<span class="ml-2 text-[var(--color-tron-text-secondary)]">#{lot.lotNumber}</span>
						{/if}
						{#if lot.status}
							<span class="ml-2 rounded bg-[var(--color-tron-bg-tertiary)] px-1 py-0.5 text-[10px]">{lot.status}</span>
						{/if}
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>

<!-- Lightbox -->
{#if lightboxOpen && selectedPhoto}
	{@const badge = inspectionBadge(selectedPhoto.inspectionResult, selectedPhoto.inspectionStatus)}
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
				onclick={(e) => { e.stopPropagation(); navigatePhoto(-1); }}
			>
				<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
				</svg>
			</button>
			<button
				class="absolute right-3 top-1/2 -translate-y-1/2 z-10 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
				onclick={(e) => { e.stopPropagation(); navigatePhoto(1); }}
			>
				<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
				</svg>
			</button>

			<!-- Full-size image -->
			<img
				src={selectedPhoto.url}
				alt="Phase {selectedPhoto.phase}"
				class="w-full"
			/>

			<!-- Info panel -->
			<div class="p-4 space-y-3">
				<div class="flex items-center justify-between">
					<div class="flex items-center gap-2">
						<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-2 py-0.5 text-xs text-[var(--color-tron-text)]">
							{phaseLabel(selectedPhoto.phase)}
						</span>
						{#if badge.text}
							<span class="rounded px-2 py-0.5 text-xs font-semibold {badge.color}">{badge.text}</span>
						{/if}
						{#if selectedPhoto.label}
							<span class="rounded px-2 py-0.5 text-xs {selectedPhoto.label === 'approved' ? 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]' : 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]'}">
								{selectedPhoto.label}
							</span>
						{/if}
					</div>
					<span class="text-xs text-[var(--color-tron-text-secondary)]">
						{formatDate(selectedPhoto.capturedAt)}
					</span>
				</div>

				{#if selectedPhoto.confidenceScore !== null}
					<div class="grid grid-cols-2 gap-4 text-xs">
						<div>
							<span class="text-[var(--color-tron-text-secondary)]">Confidence</span>
							<p class="font-medium text-[var(--color-tron-text)]">
								{(selectedPhoto.confidenceScore * 100).toFixed(1)}%
							</p>
						</div>
						<div>
							<span class="text-[var(--color-tron-text-secondary)]">Processing</span>
							<p class="font-medium text-[var(--color-tron-text)]">
								{selectedPhoto.processingTimeMs ? `${selectedPhoto.processingTimeMs}ms` : '---'}
							</p>
						</div>
					</div>
				{/if}

				{#if selectedPhoto.defects?.length > 0}
					<div class="space-y-1">
						<h3 class="text-xs font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Defects</h3>
						{#each selectedPhoto.defects as defect}
							<div class="flex items-center gap-2 text-xs">
								<span class="{defect.severity === 'high' ? 'text-[var(--color-tron-red)]' : defect.severity === 'medium' ? 'text-[var(--color-tron-orange)]' : 'text-[var(--color-tron-yellow)]'} font-bold">
									{defect.severity === 'high' ? '!' : defect.severity === 'medium' ? '*' : '-'}
								</span>
								<span class="text-[var(--color-tron-text)]">{defect.type}</span>
								{#if defect.location}
									<span class="text-[var(--color-tron-text-secondary)]">- {defect.location}</span>
								{/if}
							</div>
						{/each}
					</div>
				{/if}

				{#if selectedPhoto.labels?.length > 0}
					<div class="flex flex-wrap gap-1">
						{#each selectedPhoto.labels as label}
							<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-2 py-0.5 text-xs text-[var(--color-tron-text-secondary)]">
								{label.replace(/_/g, ' ')}
							</span>
						{/each}
					</div>
				{/if}

				{#if selectedPhoto.notes}
					<p class="text-xs text-[var(--color-tron-text-secondary)] italic">{selectedPhoto.notes}</p>
				{/if}
			</div>
		</div>
	</div>
{/if}
