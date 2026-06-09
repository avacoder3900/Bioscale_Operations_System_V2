<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';

	let { data } = $props();

	let phase = $state(data.filters.phase || '');
	let cartridgeId = $state(data.filters.cartridgeId || '');
	let labelFilter = $state(data.filters.labelFilter || '');
	let fromDate = $state(data.filters.fromDate || '');
	let toDate = $state(data.filters.toDate || '');

	let lightboxIndex = $state<number | null>(null);

	function applyFilters() {
		const params = new URLSearchParams();
		if (phase) params.set('phase', phase);
		if (cartridgeId) params.set('cartridge', cartridgeId);
		if (labelFilter) params.set('label', labelFilter);
		if (fromDate) params.set('from', fromDate);
		if (toDate) params.set('to', toDate);
		goto(`/cv/stream?${params.toString()}`);
	}

	function resetFilters() {
		phase = '';
		cartridgeId = '';
		labelFilter = '';
		fromDate = '';
		toDate = '';
		goto('/cv/stream');
	}

	function goToPage(p: number) {
		const params = new URLSearchParams($page.url.searchParams);
		params.set('page', String(p));
		goto(`/cv/stream?${params.toString()}`);
	}

	function formatRelative(dateStr: string | null): string {
		if (!dateStr) return '—';
		const d = new Date(dateStr);
		const diffMs = Date.now() - d.getTime();
		const mins = Math.floor(diffMs / 60_000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return `${hrs}h ago`;
		const days = Math.floor(hrs / 24);
		if (days < 30) return `${days}d ago`;
		return d.toLocaleDateString();
	}

	function openLightbox(i: number) { lightboxIndex = i; }
	function closeLightbox() { lightboxIndex = null; }
	function prevImage() {
		if (lightboxIndex === null) return;
		lightboxIndex = (lightboxIndex - 1 + data.images.length) % data.images.length;
	}
	function nextImage() {
		if (lightboxIndex === null) return;
		lightboxIndex = (lightboxIndex + 1) % data.images.length;
	}

	function onKey(e: KeyboardEvent) {
		if (lightboxIndex === null) return;
		if (e.key === 'Escape') closeLightbox();
		if (e.key === 'ArrowLeft') prevImage();
		if (e.key === 'ArrowRight') nextImage();
	}
</script>

<svelte:window onkeydown={onKey} />

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold text-[var(--color-tron-cyan)]">Image Stream</h1>
			<p class="text-sm text-[var(--color-tron-text-secondary)]">
				Every image captured by BIMS, chronological. {data.total.toLocaleString()} total.
			</p>
		</div>
	</div>

	<!-- Filters -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
		<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
			<div>
				<label for="phase-filter" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">Phase</label>
				<select id="phase-filter" bind:value={phase} class="tron-input w-full">
					<option value="">All phases</option>
					{#each data.availablePhases as p (p)}
						<option value={p}>{p}</option>
					{/each}
				</select>
			</div>
			<div>
				<label for="cart-filter" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">Cartridge</label>
				<input id="cart-filter" type="text" bind:value={cartridgeId} placeholder="CART-X partial match" class="tron-input w-full" />
			</div>
			<div>
				<label for="label-filter" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">QC label</label>
				<select id="label-filter" bind:value={labelFilter} class="tron-input w-full">
					<option value="">Any</option>
					<option value="approved">Approved</option>
					<option value="rejected">Rejected</option>
					<option value="unlabeled">Unlabeled</option>
				</select>
			</div>
			<div>
				<label for="from-filter" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">From</label>
				<input id="from-filter" type="date" bind:value={fromDate} class="tron-input w-full" />
			</div>
			<div>
				<label for="to-filter" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">To</label>
				<input id="to-filter" type="date" bind:value={toDate} class="tron-input w-full" />
			</div>
		</div>
		<div class="mt-3 flex gap-2">
			<button type="button" onclick={applyFilters} class="rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-[var(--color-tron-bg-primary)]">
				Apply
			</button>
			<button type="button" onclick={resetFilters} class="rounded border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)]">
				Reset
			</button>
		</div>
	</div>

	<!-- Results -->
	{#if data.images.length === 0}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-12 text-center">
			<p class="text-[var(--color-tron-text-secondary)]">No images match these filters.</p>
		</div>
	{:else}
		<div class="text-xs text-[var(--color-tron-text-secondary)]">
			Page {data.page} of {data.totalPages} — showing {data.images.length} of {data.total.toLocaleString()}
		</div>

		<div class="grid gap-3 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
			{#each data.images as img, i (img.id)}
				<button
					type="button"
					onclick={() => openLightbox(i)}
					class="group overflow-hidden rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] text-left transition-colors hover:border-[var(--color-tron-cyan)]"
				>
					{#if img.thumbnailUrl}
						<img src={img.thumbnailUrl} alt={img.cartridgeImageNumber ?? 'capture'} class="aspect-square w-full object-cover" />
					{:else}
						<div class="aspect-square w-full bg-[var(--color-tron-bg-tertiary)]"></div>
					{/if}
					<div class="p-2 text-xs">
						<div class="truncate font-mono text-[var(--color-tron-cyan)]">{img.cartridgeImageNumber ?? '—'}</div>
						<div class="flex items-center justify-between text-[var(--color-tron-text-secondary)]">
							<span class="truncate">{img.phase ?? '—'}</span>
							{#if img.qcLabel === 'approved'}
								<span class="text-[var(--color-tron-green,#39ff14)]">✓</span>
							{:else if img.qcLabel === 'rejected'}
								<span class="text-[var(--color-tron-red,#ff3366)]">✗</span>
							{/if}
						</div>
						<div class="truncate text-[10px] text-[var(--color-tron-text-secondary)]">
							{formatRelative(img.capturedAt)}
						</div>
					</div>
				</button>
			{/each}
		</div>

		<!-- Pagination -->
		<div class="flex items-center justify-between">
			<button type="button" disabled={data.page <= 1} onclick={() => goToPage(data.page - 1)} class="rounded border border-[var(--color-tron-border)] px-4 py-2 text-sm disabled:opacity-30">
				← Previous
			</button>
			<span class="text-xs text-[var(--color-tron-text-secondary)]">Page {data.page} / {data.totalPages}</span>
			<button type="button" disabled={data.page >= data.totalPages} onclick={() => goToPage(data.page + 1)} class="rounded border border-[var(--color-tron-border)] px-4 py-2 text-sm disabled:opacity-30">
				Next →
			</button>
		</div>
	{/if}
</div>

<!-- Lightbox -->
{#if lightboxIndex !== null}
	{@const img = data.images[lightboxIndex]}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4" onclick={closeLightbox}>
		<button type="button" onclick={closeLightbox} class="absolute right-4 top-4 text-3xl text-white">✕</button>
		<button type="button" onclick={(e) => { e.stopPropagation(); prevImage(); }} class="absolute left-4 text-4xl text-white">‹</button>
		<button type="button" onclick={(e) => { e.stopPropagation(); nextImage(); }} class="absolute right-4 text-4xl text-white">›</button>
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="max-h-full max-w-5xl space-y-3" onclick={(e) => e.stopPropagation()}>
			{#if img.url}
				<img src={img.url} alt={img.cartridgeImageNumber ?? 'capture'} class="max-h-[80vh] rounded shadow-2xl" />
			{/if}
			<div class="rounded bg-[var(--color-tron-bg-secondary)] p-3 text-sm">
				<div class="grid gap-2 sm:grid-cols-2">
					<div><span class="text-[var(--color-tron-text-secondary)]">Image:</span> <span class="font-mono text-[var(--color-tron-cyan)]">{img.cartridgeImageNumber ?? '—'}</span></div>
					<div><span class="text-[var(--color-tron-text-secondary)]">Cartridge:</span> <a href={`/cartridge-admin/dhr/${img.cartridgeRecordId}`} class="text-[var(--color-tron-cyan)] underline">{img.cartridgeRecordId ?? '—'}</a></div>
					<div><span class="text-[var(--color-tron-text-secondary)]">Phase:</span> {img.phase ?? '—'}</div>
					<div><span class="text-[var(--color-tron-text-secondary)]">QC label:</span> {img.qcLabel ?? 'unlabeled'}</div>
					<div><span class="text-[var(--color-tron-text-secondary)]">Captured:</span> {img.capturedAt ? new Date(img.capturedAt).toLocaleString() : '—'}</div>
					<div><span class="text-[var(--color-tron-text-secondary)]">By:</span> {img.capturedByUsername ?? '—'}</div>
				</div>
			</div>
		</div>
	</div>
{/if}
