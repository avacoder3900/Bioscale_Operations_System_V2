<script lang="ts">
	let { data } = $props();

	let activePhaseFilter = $state('all');
	let selectedPhoto = $state<any>(null);
	let lightboxOpen = $state(false);

	// Local, mutable copy of the photos so pass/fail labeling updates instantly
	// without a full reload — same pattern as the /cv/stream image feed.
	let photos = $state<any[]>(data.photos);
	let labeling = $state<string | null>(null);
	$effect(() => { photos = data.photos; });

	// Approve = pass, reject = fail, null = clear. Optimistic with rollback.
	// Reuses the same /api/cv/images/[id]/label endpoint the image stream uses.
	async function setLabel(imageId: string, qcLabel: 'approved' | 'rejected' | null) {
		const img = photos.find((p: any) => p.imageId === imageId);
		if (!img) return;
		const prev = img.qcLabel ?? null;
		if (prev === qcLabel) return;

		img.qcLabel = qcLabel;
		photos = [...photos];
		if (selectedPhoto && selectedPhoto.imageId === imageId) selectedPhoto = img;
		labeling = imageId;
		try {
			const res = await fetch(`/api/cv/images/${imageId}/label`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ qcLabel })
			});
			if (!res.ok) throw new Error(`label failed: ${res.status}`);
		} catch (err) {
			// Roll back the optimistic change.
			img.qcLabel = prev;
			photos = [...photos];
			console.error(err);
		} finally {
			labeling = null;
		}
	}

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

	// Microscope-sequence photos are a different KIND of photo — split them out so
	// the phase gallery/timeline stay inspection-only and microscope runs render
	// in their own grouped section below.
	const inspectionPhotos = $derived(photos.filter((p: any) => p.photoType !== 'microscope'));
	const microscopePhotos = $derived(photos.filter((p: any) => p.photoType === 'microscope'));

	// Group microscope photos by sequenceId (one 15-shot run each), newest run
	// first, each run ordered by sequenceIndex for a row/col-ordered grid.
	const microscopeRuns = $derived.by(() => {
		const groups = new Map<string, any[]>();
		for (const p of microscopePhotos) {
			const key = p.sequenceId || 'ungrouped';
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key)!.push(p);
		}
		const runs = Array.from(groups.entries()).map(([sequenceId, ps]) => {
			const ordered = [...ps].sort((a, b) => (a.sequenceIndex ?? 0) - (b.sequenceIndex ?? 0));
			const latest = ps.reduce((max, p) => {
				const t = p.capturedAt ? new Date(p.capturedAt).getTime() : 0;
				return t > max ? t : max;
			}, 0);
			return { sequenceId, photos: ordered, capturedAt: latest };
		});
		runs.sort((a, b) => b.capturedAt - a.capturedAt);
		return runs;
	});

	// Available phase filters (only inspection phases that have photos)
	const phasesWithPhotos: string[] = $derived(Array.from(new Set(inspectionPhotos.map((p: any) => String(p.phase ?? '')))));

	// Filtered photos (inspection only — microscope runs render separately)
	const filteredPhotos = $derived.by(() => {
		if (activePhaseFilter === 'all') return inspectionPhotos;
		return inspectionPhotos.filter((p: any) => p.phase === activePhaseFilter);
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

	// Lightbox keyboard shortcuts — same rhythm as the image stream:
	// ←/→ navigate, A/P pass, R/F/D fail, C/U clear, Esc close.
	function onKey(e: KeyboardEvent) {
		if (!lightboxOpen || !selectedPhoto) return;
		const k = e.key.toLowerCase();
		if (e.key === 'Escape') closeLightbox();
		else if (e.key === 'ArrowLeft') navigatePhoto(-1);
		else if (e.key === 'ArrowRight') navigatePhoto(1);
		else if (k === 'a' || k === 'p') { e.preventDefault(); setLabel(selectedPhoto.imageId, selectedPhoto.qcLabel === 'approved' ? null : 'approved'); }
		else if (k === 'r' || k === 'f' || k === 'd') { e.preventDefault(); setLabel(selectedPhoto.imageId, selectedPhoto.qcLabel === 'rejected' ? null : 'rejected'); }
		else if (k === 'c' || k === 'u') { e.preventDefault(); setLabel(selectedPhoto.imageId, null); }
	}
</script>

<svelte:window onkeydown={onKey} />

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

	<!-- Timing metrics (informational — cool time for wax, seal time for reagent) -->
	{#if data.timings?.cool || data.timings?.seal}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			<h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Timing</h2>
			<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
				{#if data.timings.cool}
					<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] p-3">
						<p class="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Wax Cool Time</p>
						<p class="mt-1 text-xl font-bold {data.timings.cool.overThresholdMin ? 'text-[var(--color-tron-yellow)]' : 'text-[var(--color-tron-text)]'}">
							{data.timings.cool.display}
						</p>
						<p class="mt-0.5 text-xs text-[var(--color-tron-text-secondary)]">
							OT-2 fill end → cooled
							{#if data.timings.cool.overThresholdMin}
								&middot; <span class="text-[var(--color-tron-yellow)]">+{data.timings.cool.overThresholdMin} min over threshold</span>
							{/if}
						</p>
					</div>
				{/if}
				{#if data.timings.seal}
					<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] p-3">
						<p class="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Reagent Seal Time</p>
						<p class="mt-1 text-xl font-bold {data.timings.seal.overThresholdMin ? 'text-[var(--color-tron-yellow)]' : 'text-[var(--color-tron-text)]'}">
							{data.timings.seal.display}
						</p>
						<p class="mt-0.5 text-xs text-[var(--color-tron-text-secondary)]">
							OT-2 fill end → top seal
							{#if data.timings.seal.overThresholdMin}
								&middot; <span class="text-[var(--color-tron-yellow)]">+{data.timings.seal.overThresholdMin} min over threshold</span>
							{/if}
						</p>
					</div>
				{/if}
			</div>
		</div>
	{/if}

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

	<!-- Operator Notes — append-only, written at the run level and mirrored
		 to every cartridge in that run. Phase tags the workflow point. -->
	{#if data.notes && data.notes.length > 0}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			<h2 class="mb-4 text-xs font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">
				Operator Notes ({data.notes.length})
			</h2>
			<div class="space-y-3">
				{#each data.notes as note (note.id)}
					<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
						<div class="mb-1 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wider">
							<span class="rounded bg-[var(--color-tron-cyan)]/20 px-2 py-0.5 font-medium text-[var(--color-tron-cyan)]">
								{phaseLabel(note.phase)}
							</span>
							{#if note.author}
								<span class="text-[var(--color-tron-text-secondary)]">{note.author}</span>
							{/if}
							{#if note.createdAt}
								<span class="text-[var(--color-tron-text-secondary)]/60">{formatShortDate(note.createdAt)}</span>
							{/if}
						</div>
						<p class="whitespace-pre-wrap text-sm text-[var(--color-tron-text)]">{note.body}</p>
					</div>
				{/each}
			</div>
		</div>
	{/if}

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
			All Photos ({inspectionPhotos.length})
		</h2>

		<!-- Phase filter tabs -->
		{#if inspectionPhotos.length > 0}
			<div class="mb-4 flex items-center gap-2 border-b border-[var(--color-tron-border)] pb-0">
				<button
					class="px-3 py-2 text-sm font-medium transition-colors {activePhaseFilter === 'all'
						? 'border-b-2 border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
						: 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}"
					onclick={() => { activePhaseFilter = 'all'; }}
				>
					All ({inspectionPhotos.length})
				</button>
				{#each phasesWithPhotos as phase}
					<button
						class="px-3 py-2 text-sm font-medium transition-colors {activePhaseFilter === phase
							? 'border-b-2 border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
							: 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}"
						onclick={() => { activePhaseFilter = phase; }}
					>
						{phaseLabel(phase)} ({inspectionPhotos.filter((p: any) => p.phase === phase).length})
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
					<div
						class="group overflow-hidden rounded-lg border bg-[var(--color-tron-bg)] transition-colors
							{photo.qcLabel === 'approved'
								? 'border-[var(--color-tron-green,#39ff14)]'
								: photo.qcLabel === 'rejected'
									? 'border-[var(--color-tron-red,#ff3366)]'
									: 'border-[var(--color-tron-border)] hover:border-[var(--color-tron-cyan)]'}"
					>
						<button type="button" onclick={() => openLightbox(photo)} class="block w-full cursor-pointer text-left">
							<div class="relative aspect-video overflow-hidden">
								<img
									src={photo.thumbnailUrl || photo.url}
									alt="Phase {photo.phase}"
									class="h-full w-full object-cover transition-transform group-hover:scale-105"
								/>
								<!-- Human QC pass/fail — same treatment as the image stream. -->
								{#if photo.qcLabel === 'approved'}
									<span class="absolute left-2 top-2 rounded bg-[var(--color-tron-green,#39ff14)] px-1.5 py-0.5 text-[10px] font-bold text-black">PASS</span>
								{:else if photo.qcLabel === 'rejected'}
									<span class="absolute left-2 top-2 rounded bg-[var(--color-tron-red,#ff3366)] px-1.5 py-0.5 text-[10px] font-bold text-white">FAIL</span>
								{/if}
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
						</button>
						<!-- Inline pass/fail — label without opening the photo (image-stream parity). -->
						<div class="flex border-t border-[var(--color-tron-border)]">
							<button
								type="button"
								disabled={labeling === photo.imageId}
								onclick={() => setLabel(photo.imageId, photo.qcLabel === 'approved' ? null : 'approved')}
								class="flex-1 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40
									{photo.qcLabel === 'approved'
										? 'bg-[var(--color-tron-green,#39ff14)]/20 text-[var(--color-tron-green,#39ff14)]'
										: 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-green,#39ff14)]'}"
							>✓ Pass</button>
							<button
								type="button"
								disabled={labeling === photo.imageId}
								onclick={() => setLabel(photo.imageId, photo.qcLabel === 'rejected' ? null : 'rejected')}
								class="flex-1 border-l border-[var(--color-tron-border)] py-1.5 text-xs font-semibold transition-colors disabled:opacity-40
									{photo.qcLabel === 'rejected'
										? 'bg-[var(--color-tron-red,#ff3366)]/20 text-[var(--color-tron-red,#ff3366)]'
										: 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-red,#ff3366)]'}"
							>✗ Fail</button>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>

	<!-- Microscope sequence runs — grouped by sequenceId, newest run first, each
	     run a row/col-ordered grid with the location label under each thumbnail. -->
	{#if microscopePhotos.length > 0}
		<div class="rounded-lg border border-[var(--color-tron-cyan)] bg-[var(--color-tron-bg-secondary)] p-4">
			<h2 class="mb-4 text-xs font-semibold uppercase tracking-wider text-[var(--color-tron-cyan)]">
				🔬 Microscope Sequences ({microscopePhotos.length} photo{microscopePhotos.length !== 1 ? 's' : ''} · {microscopeRuns.length} run{microscopeRuns.length !== 1 ? 's' : ''})
			</h2>
			<div class="space-y-6">
				{#each microscopeRuns as run (run.sequenceId)}
					<div>
						<div class="mb-2 flex flex-wrap items-center gap-2">
							<span class="rounded bg-[var(--color-tron-cyan)]/20 px-2 py-0.5 font-mono text-xs text-[var(--color-tron-cyan)]">{run.sequenceId}</span>
							<span class="text-xs text-[var(--color-tron-text-secondary)]">{run.photos.length} shot{run.photos.length !== 1 ? 's' : ''}</span>
							{#if run.capturedAt}
								<span class="text-xs text-[var(--color-tron-text-secondary)]/60">{formatShortDate(new Date(run.capturedAt).toISOString())}</span>
							{/if}
						</div>
						<div class="grid grid-cols-3 gap-3 sm:grid-cols-5 lg:grid-cols-8">
							{#each run.photos as photo (photo.imageId)}
								<div
									class="group overflow-hidden rounded-lg border bg-[var(--color-tron-bg)] transition-colors
										{photo.qcLabel === 'approved'
											? 'border-[var(--color-tron-green,#39ff14)]'
											: photo.qcLabel === 'rejected'
												? 'border-[var(--color-tron-red,#ff3366)]'
												: 'border-[var(--color-tron-border)] hover:border-[var(--color-tron-cyan)]'}"
								>
									<button type="button" onclick={() => openLightbox(photo)} class="block w-full cursor-pointer text-left">
										<div class="relative aspect-square overflow-hidden">
											<img
												src={photo.thumbnailUrl || photo.url}
												alt="Microscope {photo.location ? `${photo.location.row ?? ''}${photo.location.col ?? ''}` : `#${photo.sequenceIndex ?? ''}`}"
												class="h-full w-full object-cover transition-transform group-hover:scale-105"
											/>
											{#if photo.qcLabel === 'approved'}
												<span class="absolute left-1 top-1 rounded bg-[var(--color-tron-green,#39ff14)] px-1 py-0.5 text-[9px] font-bold text-black">PASS</span>
											{:else if photo.qcLabel === 'rejected'}
												<span class="absolute left-1 top-1 rounded bg-[var(--color-tron-red,#ff3366)] px-1 py-0.5 text-[9px] font-bold text-white">FAIL</span>
											{/if}
										</div>
									</button>
									<div class="px-1 py-1 text-center font-mono text-[11px] text-[var(--color-tron-cyan)]">
										{#if photo.location && (photo.location.row || photo.location.col != null)}
											{photo.location.row ?? ''}{photo.location.col ?? ''}
										{:else}
											#{photo.sequenceIndex ?? '—'}
										{/if}
									</div>
								</div>
							{/each}
						</div>
					</div>
				{/each}
			</div>
		</div>
	{/if}

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

			<!-- Pass / Fail review controls — same as the image stream (keys A / F / C). -->
			<div class="flex items-center justify-center gap-2 border-t border-[var(--color-tron-border)] p-3">
				<button
					type="button"
					disabled={labeling === selectedPhoto.imageId}
					onclick={() => setLabel(selectedPhoto.imageId, selectedPhoto.qcLabel === 'approved' ? null : 'approved')}
					class="rounded px-5 py-2 text-sm font-bold transition-colors disabled:opacity-40
						{selectedPhoto.qcLabel === 'approved'
							? 'bg-[var(--color-tron-green,#39ff14)] text-black'
							: 'border border-[var(--color-tron-green,#39ff14)] text-[var(--color-tron-green,#39ff14)] hover:bg-[var(--color-tron-green,#39ff14)]/20'}"
				>✓ Pass <span class="ml-1 opacity-60">(A)</span></button>
				<button
					type="button"
					disabled={labeling === selectedPhoto.imageId}
					onclick={() => setLabel(selectedPhoto.imageId, selectedPhoto.qcLabel === 'rejected' ? null : 'rejected')}
					class="rounded px-5 py-2 text-sm font-bold transition-colors disabled:opacity-40
						{selectedPhoto.qcLabel === 'rejected'
							? 'bg-[var(--color-tron-red,#ff3366)] text-white'
							: 'border border-[var(--color-tron-red,#ff3366)] text-[var(--color-tron-red,#ff3366)] hover:bg-[var(--color-tron-red,#ff3366)]/20'}"
				>✗ Fail <span class="ml-1 opacity-60">(F)</span></button>
				<button
					type="button"
					disabled={labeling === selectedPhoto.imageId || !selectedPhoto.qcLabel}
					onclick={() => setLabel(selectedPhoto.imageId, null)}
					class="rounded border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-text)] disabled:opacity-30"
				>Clear <span class="ml-1 opacity-60">(C)</span></button>
			</div>

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
						<!-- Human QC verdict (approved/rejected), same as the image stream. -->
						{#if selectedPhoto.qcLabel === 'approved'}
							<span class="rounded bg-[var(--color-tron-green,#39ff14)]/20 px-2 py-0.5 text-xs font-semibold text-[var(--color-tron-green,#39ff14)]">PASS</span>
						{:else if selectedPhoto.qcLabel === 'rejected'}
							<span class="rounded bg-[var(--color-tron-red,#ff3366)]/20 px-2 py-0.5 text-xs font-semibold text-[var(--color-tron-red,#ff3366)]">FAIL</span>
						{:else}
							<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-2 py-0.5 text-xs text-[var(--color-tron-text-secondary)]">Unreviewed</span>
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
					<div class="space-y-1 border-t border-[var(--color-tron-border)] pt-3">
						<h3 class="text-xs font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Labels</h3>
						<div class="flex flex-wrap gap-1">
							{#each selectedPhoto.labels as label}
								<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-2 py-0.5 text-xs text-[var(--color-tron-text-secondary)]">
									{label.replace(/_/g, ' ')}
								</span>
							{/each}
						</div>
					</div>
				{/if}

				{#if selectedPhoto.notes}
					<div class="space-y-1 border-t border-[var(--color-tron-border)] pt-3">
						<h3 class="text-xs font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Notes</h3>
						<p class="whitespace-pre-wrap text-xs italic text-[var(--color-tron-text-secondary)]">{selectedPhoto.notes}</p>
					</div>
				{/if}
			</div>
		</div>
	</div>
{/if}
