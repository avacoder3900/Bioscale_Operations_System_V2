<script lang="ts">
	import { CARTRIDGE_PHASES } from '$lib/types/cv';

	let { data } = $props();

	let activePhase = $state('all');
	let lightboxImage = $state<typeof data.images[0] | null>(null);

	const filteredImages = $derived(
		activePhase === 'all'
			? data.images
			: data.images.filter((img) => (img.cartridge_tag?.phase || 'untagged') === activePhase)
	);
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h2 class="tron-heading text-2xl font-bold text-[var(--color-tron-cyan)]">
				Cartridge CV Timeline
			</h2>
			<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
				{data.cartridgeId}
				{#if data.cartridge}
					&middot; Phase: <span class="text-[var(--color-tron-text-primary)]">{data.cartridge.currentPhase?.replace(/_/g, ' ') || 'unknown'}</span>
				{/if}
			</p>
		</div>
		<a
			href="/cv/inspect"
			class="rounded-lg bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-[var(--color-tron-bg-primary)] transition-colors hover:opacity-90"
		>
			New Capture
		</a>
	</div>

	<!-- Stats -->
	<div class="grid grid-cols-3 gap-4">
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3 text-center">
			<p class="text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Images</p>
			<p class="text-xl font-bold text-[var(--color-tron-text-primary)]">{data.images.length}</p>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3 text-center">
			<p class="text-xs uppercase tracking-wider text-[var(--color-tron-green)]">Passed</p>
			<p class="text-xl font-bold text-[var(--color-tron-green)]">{data.passCount}</p>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3 text-center">
			<p class="text-xs uppercase tracking-wider text-[var(--color-tron-red)]">Failed</p>
			<p class="text-xl font-bold text-[var(--color-tron-red)]">{data.failCount}</p>
		</div>
	</div>

	<!-- Phase Progress Bar -->
	{#if data.cartridge}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			<div class="flex items-center gap-1 overflow-x-auto">
				{#each CARTRIDGE_PHASES as phase, i}
					{@const isCurrent = data.cartridge?.currentPhase === phase}
					{@const phaseIndex = CARTRIDGE_PHASES.indexOf(data.cartridge?.currentPhase as typeof CARTRIDGE_PHASES[number] ?? 'backing')}
					{@const isPast = i < phaseIndex}
					<div class="flex items-center gap-1">
						<div
							class="whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium
								{isCurrent
									? 'bg-[var(--color-tron-cyan)] text-[var(--color-tron-bg-primary)]'
									: isPast
										? 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]'
										: 'bg-[var(--color-tron-bg-tertiary)] text-[var(--color-tron-text-secondary)]'}"
						>
							{phase.replace(/_/g, ' ')}
						</div>
						{#if i < CARTRIDGE_PHASES.length - 1}
							<span class="text-[var(--color-tron-text-secondary)]">&rarr;</span>
						{/if}
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Phase Filter Tabs -->
	<div class="flex flex-wrap gap-1">
		<button
			onclick={() => (activePhase = 'all')}
			class="rounded-lg px-3 py-1.5 text-sm font-medium transition-colors
				{activePhase === 'all'
					? 'bg-[var(--color-tron-cyan)] text-[var(--color-tron-bg-primary)]'
					: 'text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-bg-tertiary)]'}"
		>
			All ({data.images.length})
		</button>
		{#each data.phases as phase}
			{@const count = data.images.filter((img) => (img.cartridge_tag?.phase || 'untagged') === phase).length}
			<button
				onclick={() => (activePhase = phase)}
				class="rounded-lg px-3 py-1.5 text-sm font-medium transition-colors
					{activePhase === phase
						? 'bg-[var(--color-tron-cyan)] text-[var(--color-tron-bg-primary)]'
						: 'text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-bg-tertiary)]'}"
			>
				{phase.replace(/_/g, ' ')} ({count})
			</button>
		{/each}
	</div>

	<!-- Image Grid -->
	{#if filteredImages.length === 0}
		<div class="rounded-lg border border-dashed border-[var(--color-tron-border)] p-8 text-center text-[var(--color-tron-text-secondary)]">
			No images for this {activePhase === 'all' ? 'cartridge' : 'phase'}.
		</div>
	{:else}
		<div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
			{#each filteredImages as img}
				<button
					class="group overflow-hidden rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] text-left transition-colors hover:border-[var(--color-tron-cyan)]"
					onclick={() => (lightboxImage = img)}
				>
					<div class="relative">
						<img
							src={img.thumbUrl}
							alt={img.filename}
							class="aspect-square w-full object-cover"
							onerror={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
						/>
						{#if img.inspection}
							<div class="absolute right-1 top-1">
								{#if img.inspection.result === 'pass'}
									<span class="rounded-full bg-[var(--color-tron-green)] px-1.5 py-0.5 text-xs font-bold text-white">PASS</span>
								{:else if img.inspection.result === 'fail'}
									<span class="rounded-full bg-[var(--color-tron-red)] px-1.5 py-0.5 text-xs font-bold text-white">FAIL</span>
								{:else}
									<span class="animate-pulse rounded-full bg-[var(--color-tron-yellow)] px-1.5 py-0.5 text-xs font-bold text-white">{img.inspection.status}</span>
								{/if}
							</div>
						{/if}
					</div>
					<div class="p-2">
						{#if img.cartridge_tag?.phase}
							<span class="inline-block rounded bg-[var(--color-tron-bg-tertiary)] px-1.5 py-0.5 text-xs text-[var(--color-tron-text-secondary)]">
								{img.cartridge_tag.phase.replace(/_/g, ' ')}
							</span>
						{/if}
						{#if img.cartridge_tag?.labels?.length}
							<div class="mt-1 flex flex-wrap gap-0.5">
								{#each img.cartridge_tag.labels.slice(0, 3) as label}
									<span class="rounded-full border border-[var(--color-tron-border)] px-1.5 py-0 text-[10px] text-[var(--color-tron-text-secondary)]">{label}</span>
								{/each}
							</div>
						{/if}
						<p class="mt-1 text-[10px] text-[var(--color-tron-text-secondary)]">
							{new Date(img.captured_at).toLocaleString()}
						</p>
					</div>
				</button>
			{/each}
		</div>
	{/if}
</div>

<!-- Lightbox -->
{#if lightboxImage}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
		onclick={() => (lightboxImage = null)}
	>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div
			class="relative max-h-[90vh] max-w-4xl overflow-auto rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]"
			onclick={(e) => e.stopPropagation()}
		>
			<button
				onclick={() => (lightboxImage = null)}
				class="absolute right-2 top-2 z-10 rounded-full bg-black/60 px-2 py-0.5 text-sm text-white hover:bg-black/80"
			>
				&times;
			</button>
			<img
				src={lightboxImage.fullUrl}
				alt={lightboxImage.filename}
				class="max-h-[60vh] w-full object-contain"
			/>
			<div class="p-4">
				<div class="flex items-center gap-3">
					{#if lightboxImage.inspection}
						{#if lightboxImage.inspection.result === 'pass'}
							<span class="rounded-full bg-[var(--color-tron-green)]/20 px-3 py-1 text-sm font-bold text-[var(--color-tron-green)]">PASS</span>
						{:else if lightboxImage.inspection.result === 'fail'}
							<span class="rounded-full bg-[var(--color-tron-red)]/20 px-3 py-1 text-sm font-bold text-[var(--color-tron-red)]">FAIL</span>
						{/if}
						{#if lightboxImage.inspection.confidence_score !== null}
							<span class="text-sm text-[var(--color-tron-text-primary)]">
								Score: {(lightboxImage.inspection.confidence_score * 100).toFixed(1)}%
							</span>
						{/if}
					{/if}
					{#if lightboxImage.cartridge_tag?.phase}
						<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-2 py-0.5 text-xs text-[var(--color-tron-text-secondary)]">
							{lightboxImage.cartridge_tag.phase.replace(/_/g, ' ')}
						</span>
					{/if}
				</div>

				{#if lightboxImage.inspection?.defects?.length}
					<div class="mt-3">
						<p class="text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Defects</p>
						<div class="mt-1 space-y-1">
							{#each lightboxImage.inspection.defects as defect}
								<div class="flex items-center gap-2 text-sm">
									<span class="{defect.severity === 'high' ? 'text-[var(--color-tron-red)]' : defect.severity === 'medium' ? 'text-[var(--color-tron-yellow)]' : 'text-[var(--color-tron-text-secondary)]'}">&#9679;</span>
									<span class="text-[var(--color-tron-text-primary)]">{defect.type}</span>
									<span class="text-[var(--color-tron-text-secondary)]">&mdash; {defect.location}</span>
									<span class="text-xs text-[var(--color-tron-text-secondary)]">({defect.severity})</span>
								</div>
							{/each}
						</div>
					</div>
				{/if}

				{#if lightboxImage.cartridge_tag?.labels?.length}
					<div class="mt-3 flex flex-wrap gap-1">
						{#each lightboxImage.cartridge_tag.labels as label}
							<span class="rounded-full border border-[var(--color-tron-cyan)]/30 px-2 py-0.5 text-xs text-[var(--color-tron-cyan)]">{label}</span>
						{/each}
					</div>
				{/if}

				{#if lightboxImage.cartridge_tag?.notes}
					<p class="mt-2 text-sm text-[var(--color-tron-text-secondary)]">
						{lightboxImage.cartridge_tag.notes}
					</p>
				{/if}

				<p class="mt-2 text-xs text-[var(--color-tron-text-secondary)]">
					Captured: {new Date(lightboxImage.captured_at).toLocaleString()}
					&middot; {lightboxImage.width}x{lightboxImage.height}
					&middot; {(lightboxImage.file_size_bytes / 1024).toFixed(0)} KB
				</p>
			</div>
		</div>
	</div>
{/if}
