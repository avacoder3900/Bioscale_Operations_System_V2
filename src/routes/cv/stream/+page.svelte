<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { enhance } from '$app/forms';

	let { data } = $props();

	// 'browse' = the image grid (Unreviewed/Reviewed/All); 'manage' = the
	// common-failures editor. Client-side only — doesn't touch the review tab
	// state or reload image data.
	let activeView = $state<'browse' | 'manage'>('browse');
	let editingReasonId = $state<string | null>(null);
	let editLabel = $state('');
	let editSortOrder = $state(0);
	let showAddReason = $state(false);
	let newCode = $state('');
	let newLabel = $state('');
	let newSortOrder = $state(0);
	let newProcessType = $state<'wax' | 'reagent'>('wax');

	function startEditReason(reason: { id: string; label: string; sortOrder: number }) {
		editingReasonId = reason.id;
		editLabel = reason.label;
		editSortOrder = reason.sortOrder;
	}
	function cancelEditReason() {
		editingReasonId = null;
	}

	let phase = $state(data.filters.phase || '');
	let cartridgeId = $state(data.filters.cartridgeId || '');
	let verdict = $state(data.filters.verdict || '');
	let fromDate = $state(data.filters.fromDate || '');
	let toDate = $state(data.filters.toDate || '');
	let arm = $state(data.filters.arm || '');
	let experiment = $state(data.filters.experiment || '');
	let tag = $state(data.filters.tag || '');
	let failureCode = $state(data.filters.failureCode || '');
	let notesSearch = $state(data.filters.notesSearch || '');

	// Local, mutable copies so we can label optimistically without a round-trip
	// reload. Re-synced whenever the server sends a fresh page (nav / tab switch).
	let images = $state(data.images);
	let counts = $state(data.counts);
	let labeling = $state<string | null>(null);
	$effect(() => {
		images = data.images;
		counts = data.counts;
	});

	let lightboxIndex = $state<number | null>(null);

	const tabs = [
		{ key: 'unreviewed', label: 'Unreviewed' },
		{ key: 'reviewed', label: 'Reviewed' },
		{ key: 'all', label: 'All' }
	] as const;

	function paramsFromFilters(): URLSearchParams {
		const params = new URLSearchParams();
		if (phase) params.set('phase', phase);
		if (cartridgeId) params.set('cartridge', cartridgeId);
		// Verdict only makes sense on Reviewed/All.
		if (verdict && data.review !== 'unreviewed') params.set('verdict', verdict);
		if (fromDate) params.set('from', fromDate);
		if (toDate) params.set('to', toDate);
		if (arm) params.set('arm', arm);
		if (experiment) params.set('experiment', experiment);
		if (tag) params.set('tag', tag);
		if (failureCode) params.set('failureCode', failureCode);
		if (notesSearch) params.set('notes', notesSearch);
		return params;
	}

	function applyFilters() {
		const params = paramsFromFilters();
		params.set('review', data.review);
		goto(`/cv/stream?${params.toString()}`);
	}

	function resetFilters() {
		phase = '';
		cartridgeId = '';
		verdict = '';
		fromDate = '';
		toDate = '';
		arm = '';
		experiment = '';
		tag = '';
		failureCode = '';
		notesSearch = '';
		goto(`/cv/stream?review=${data.review}`);
	}

	function switchTab(tab: string) {
		if (tab === data.review) return;
		const params = paramsFromFilters();
		// Verdict only applies to Reviewed/All; drop it when entering Unreviewed.
		if (tab === 'unreviewed') params.delete('verdict');
		params.set('review', tab);
		goto(`/cv/stream?${params.toString()}`);
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

	function adjustCounts(from: string | null, to: string | null) {
		if (from === to) return;
		if (!from && to) { counts = { unreviewed: counts.unreviewed - 1, reviewed: counts.reviewed + 1 }; }
		else if (from && !to) { counts = { unreviewed: counts.unreviewed + 1, reviewed: counts.reviewed - 1 }; }
	}

	// Approve = pass, reject = fail, null = clear. Optimistic with rollback.
	async function setLabel(id: string, qcLabel: 'approved' | 'rejected' | null) {
		const img = images.find((x) => x.id === id);
		if (!img) return;
		const prev = img.qcLabel;
		if (prev === qcLabel) return;

		img.qcLabel = qcLabel;
		images = [...images];
		adjustCounts(prev, qcLabel);
		labeling = id;

		try {
			const res = await fetch(`/api/cv/images/${id}/label`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ qcLabel })
			});
			if (!res.ok) throw new Error(`label failed: ${res.status}`);
		} catch (err) {
			// Roll back the optimistic change.
			img.qcLabel = prev;
			images = [...images];
			adjustCounts(qcLabel, prev);
			console.error(err);
		} finally {
			labeling = null;
		}
	}

	function openLightbox(i: number) { lightboxIndex = i; }
	function closeLightbox() { lightboxIndex = null; }
	function prevImage() {
		if (lightboxIndex === null) return;
		lightboxIndex = (lightboxIndex - 1 + images.length) % images.length;
	}
	function nextImage() {
		if (lightboxIndex === null) return;
		lightboxIndex = (lightboxIndex + 1) % images.length;
	}

	// Label the image in the lightbox, then advance — keeps the scroll-and-label
	// rhythm going without reaching for the mouse.
	async function labelAndAdvance(qcLabel: 'approved' | 'rejected' | null) {
		if (lightboxIndex === null) return;
		const img = images[lightboxIndex];
		if (!img) return;
		await setLabel(img.id, qcLabel);
		if (qcLabel !== null) nextImage();
	}

	function onKey(e: KeyboardEvent) {
		if (lightboxIndex === null) return;
		const k = e.key.toLowerCase();
		if (e.key === 'Escape') closeLightbox();
		else if (e.key === 'ArrowLeft') prevImage();
		else if (e.key === 'ArrowRight') nextImage();
		else if (k === 'a' || k === 'p') { e.preventDefault(); labelAndAdvance('approved'); }
		else if (k === 'r' || k === 'f' || k === 'd') { e.preventDefault(); labelAndAdvance('rejected'); }
		else if (k === 'u' || k === 'c') { e.preventDefault(); labelAndAdvance(null); }
	}
</script>

<svelte:window onkeydown={onKey} />

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold text-[var(--color-tron-cyan)]">Image Stream</h1>
			<p class="text-sm text-[var(--color-tron-text-secondary)]">
				Scroll the captures and label each one pass / fail. Reviewed images are ready for the CV model.
			</p>
		</div>
	</div>

	<!-- Review tabs -->
	<div class="flex flex-wrap items-center gap-2 border-b border-[var(--color-tron-border)]">
		{#each tabs as t (t.key)}
			<button
				type="button"
				onclick={() => { activeView = 'browse'; switchTab(t.key); }}
				class="-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors
					{activeView === 'browse' && data.review === t.key
						? 'border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
						: 'border-transparent text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text-primary)]'}"
			>
				{t.label}
				{#if t.key === 'unreviewed'}
					<span class="ml-1 rounded-full bg-[var(--color-tron-bg-tertiary)] px-2 py-0.5 text-xs">{counts.unreviewed.toLocaleString()}</span>
				{:else if t.key === 'reviewed'}
					<span class="ml-1 rounded-full bg-[var(--color-tron-bg-tertiary)] px-2 py-0.5 text-xs">{counts.reviewed.toLocaleString()}</span>
				{/if}
			</button>
		{/each}
		<button
			type="button"
			onclick={() => { activeView = 'manage'; }}
			class="-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors
				{activeView === 'manage'
					? 'border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
					: 'border-transparent text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text-primary)]'}"
		>
			Label Creation
		</button>
	</div>

	{#if activeView === 'browse'}
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
			{#if data.review !== 'unreviewed'}
				<div>
					<label for="verdict-filter" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">Verdict</label>
					<select id="verdict-filter" bind:value={verdict} class="tron-input w-full">
						<option value="">Any</option>
						<option value="approved">Pass</option>
						<option value="rejected">Fail</option>
					</select>
				</div>
			{/if}
			<div>
				<label for="from-filter" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">From</label>
				<input id="from-filter" type="date" bind:value={fromDate} class="tron-input w-full" />
			</div>
			<div>
				<label for="to-filter" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">To</label>
				<input id="to-filter" type="date" bind:value={toDate} class="tron-input w-full" />
			</div>
			<div>
				<label for="arm-filter" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">Arm</label>
				<select id="arm-filter" bind:value={arm} class="tron-input w-full">
					<option value="">All arms</option>
					{#each data.armOptions as a (a)}
						<option value={a}>{a}</option>
					{/each}
				</select>
			</div>
			<div>
				<label for="experiment-filter" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">Experiment</label>
				<select id="experiment-filter" bind:value={experiment} class="tron-input w-full">
					<option value="">All experiments</option>
					{#each data.experimentOptions as e (e)}
						<option value={e}>{e}</option>
					{/each}
				</select>
			</div>
			<div>
				<label for="tag-filter" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">Tag</label>
				<select id="tag-filter" bind:value={tag} class="tron-input w-full">
					<option value="">All tags</option>
					{#each data.tagOptions as t (t)}
						<option value={t}>{t}</option>
					{/each}
				</select>
			</div>
			<div>
				<label for="failure-filter" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">Common Failure</label>
				<select id="failure-filter" bind:value={failureCode} class="tron-input w-full">
					<option value="">All</option>
					{#each data.failureCodeOptions as fc (fc.code)}
						<option value={fc.code}>{fc.label}</option>
					{/each}
				</select>
			</div>
			<div>
				<label for="notes-filter" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">Search Notes</label>
				<input id="notes-filter" type="text" bind:value={notesSearch} placeholder="Keyword in photo notes" class="tron-input w-full" />
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
	{#if images.length === 0}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-12 text-center">
			<p class="text-[var(--color-tron-text-secondary)]">
				{#if data.review === 'unreviewed'}
					Nothing left to review for these filters. 🎉
				{:else}
					No images match these filters.
				{/if}
			</p>
		</div>
	{:else}
		<div class="text-xs text-[var(--color-tron-text-secondary)]">
			Page {data.page} of {data.totalPages} — showing {images.length} of {data.total.toLocaleString()}
		</div>

		<div class="grid gap-3 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
			{#each images as img, i (img.id)}
				<div
					class="group overflow-hidden rounded border bg-[var(--color-tron-bg-secondary)] transition-colors
						{img.qcLabel === 'approved'
							? 'border-[var(--color-tron-green,#39ff14)]'
							: img.qcLabel === 'rejected'
								? 'border-[var(--color-tron-red,#ff3366)]'
								: 'border-[var(--color-tron-border)] hover:border-[var(--color-tron-cyan)]'}"
				>
					<button
						type="button"
						onclick={() => openLightbox(i)}
						class="block w-full text-left"
						title={img.notes || undefined}
					>
						<div class="relative">
							{#if img.thumbnailUrl}
								<img src={img.thumbnailUrl} alt={img.cartridgeImageNumber ?? 'capture'} class="aspect-square w-full object-cover" />
							{:else}
								<div class="aspect-square w-full bg-[var(--color-tron-bg-tertiary)]"></div>
							{/if}
							{#if img.qcLabel === 'approved'}
								<span class="absolute left-1 top-1 rounded bg-[var(--color-tron-green,#39ff14)] px-1.5 py-0.5 text-[10px] font-bold text-black">PASS</span>
							{:else if img.qcLabel === 'rejected'}
								<span class="absolute left-1 top-1 rounded bg-[var(--color-tron-red,#ff3366)] px-1.5 py-0.5 text-[10px] font-bold text-white">FAIL</span>
							{/if}
							{#if img.notes}
								<span class="absolute right-1 top-1 rounded bg-black/60 px-1 py-0.5 text-[10px] text-white">📝</span>
							{/if}
						</div>
						<div class="p-2 text-xs">
							<div class="truncate font-mono text-[var(--color-tron-cyan)]">{img.cartridgeImageNumber ?? '—'}</div>
							<div class="truncate text-[var(--color-tron-text-secondary)]">{img.phase ?? '—'}</div>
							{#if img.labels && img.labels.length > 0}
								<div class="mt-0.5 flex flex-wrap gap-0.5">
									{#each img.labels as l (l)}
										<span class="truncate rounded bg-[var(--color-tron-cyan)]/20 px-1 py-0.5 text-[9px] text-[var(--color-tron-cyan)]">{l}</span>
									{/each}
								</div>
							{/if}
							<div class="truncate text-[10px] text-[var(--color-tron-text-secondary)]">
								{formatRelative(img.capturedAt)}
							</div>
						</div>
					</button>
					<!-- Inline pass/fail — label without opening the image -->
					<div class="flex border-t border-[var(--color-tron-border)]">
						<button
							type="button"
							disabled={labeling === img.id}
							onclick={() => setLabel(img.id, img.qcLabel === 'approved' ? null : 'approved')}
							class="flex-1 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40
								{img.qcLabel === 'approved'
									? 'bg-[var(--color-tron-green,#39ff14)]/20 text-[var(--color-tron-green,#39ff14)]'
									: 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-green,#39ff14)]'}"
						>✓ Pass</button>
						<button
							type="button"
							disabled={labeling === img.id}
							onclick={() => setLabel(img.id, img.qcLabel === 'rejected' ? null : 'rejected')}
							class="flex-1 border-l border-[var(--color-tron-border)] py-1.5 text-xs font-semibold transition-colors disabled:opacity-40
								{img.qcLabel === 'rejected'
									? 'bg-[var(--color-tron-red,#ff3366)]/20 text-[var(--color-tron-red,#ff3366)]'
									: 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-red,#ff3366)]'}"
						>✗ Fail</button>
					</div>
				</div>
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
	{/if}

	{#if activeView === 'manage'}
		<!-- Manage common-failure reasons (ManufacturingSettings.rejectionReasonCodes) -->
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			<h2 class="mb-4 text-lg font-medium text-[var(--color-tron-cyan)]">Common Failures</h2>
			<div class="overflow-x-auto">
				<table class="tron-table w-full text-sm">
					<thead>
						<tr>
							<th class="px-3 py-2 text-left text-[var(--color-tron-text-secondary)]">Process</th>
							<th class="px-3 py-2 text-left text-[var(--color-tron-text-secondary)]">Code</th>
							<th class="px-3 py-2 text-left text-[var(--color-tron-text-secondary)]">Label</th>
							<th class="px-3 py-2 text-left text-[var(--color-tron-text-secondary)]">Sort Order</th>
							<th class="px-3 py-2 text-right text-[var(--color-tron-text-secondary)]">Actions</th>
						</tr>
					</thead>
					<tbody>
						{#each data.failureCodeOptions as reason (reason.id)}
							{#if editingReasonId === reason.id}
								<tr>
									<td colspan="5" class="px-3 py-2">
										<form method="POST" action="?/updateFailureReason" use:enhance={() => { return async ({ update }) => { editingReasonId = null; await update(); }; }} class="flex items-end gap-3">
											<input type="hidden" name="codeId" value={reason.id} />
											<span class="font-mono text-[var(--color-tron-text)]">{reason.code}</span>
											<input type="text" name="label" bind:value={editLabel} class="tron-input flex-1 text-sm" />
											<input type="number" name="sortOrder" bind:value={editSortOrder} class="tron-input text-sm" style="width:80px" />
											<button type="submit" class="rounded border border-green-500/50 px-2 py-1 text-xs text-green-400 hover:bg-green-900/20">Save</button>
											<button type="button" onclick={cancelEditReason} class="rounded border border-[var(--color-tron-border)] px-2 py-1 text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]">Cancel</button>
										</form>
									</td>
								</tr>
							{:else}
								<tr>
									<td class="px-3 py-2 text-[var(--color-tron-text-secondary)]">{reason.processType === 'wax' ? 'Wax' : 'Reagent'}</td>
									<td class="px-3 py-2 font-mono text-[var(--color-tron-text)]">{reason.code}</td>
									<td class="px-3 py-2 text-[var(--color-tron-text)]">{reason.label}</td>
									<td class="px-3 py-2 text-[var(--color-tron-text)]">{reason.sortOrder}</td>
									<td class="px-3 py-2 text-right">
										<div class="flex justify-end gap-2">
											<button type="button" onclick={() => startEditReason(reason)} class="rounded border border-[var(--color-tron-border)] px-2 py-1 text-xs text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10">Edit</button>
											<form method="POST" action="?/deleteFailureReason" use:enhance onsubmit={(e) => { if (!confirm('Delete this reason?')) e.preventDefault(); }}>
												<input type="hidden" name="codeId" value={reason.id} />
												<button type="submit" class="rounded border border-red-500/50 px-2 py-1 text-xs text-red-400 hover:bg-red-900/20">Delete</button>
											</form>
										</div>
									</td>
								</tr>
							{/if}
						{/each}
						{#if data.failureCodeOptions.length === 0}
							<tr>
								<td colspan="5" class="px-3 py-4 text-center text-[var(--color-tron-text-secondary)]">No common failures configured yet.</td>
							</tr>
						{/if}
					</tbody>
				</table>
			</div>

			{#if showAddReason}
				<form method="POST" action="?/createFailureReason" use:enhance={() => { return async ({ update }) => { showAddReason = false; newCode = ''; newLabel = ''; newSortOrder = 0; await update(); }; }} class="mt-4 flex flex-wrap items-end gap-3 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] p-3">
					<label class="block">
						<span class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]">Process</span>
						<select name="processType" bind:value={newProcessType} class="tron-input text-sm">
							<option value="wax">Wax</option>
							<option value="reagent">Reagent</option>
						</select>
					</label>
					<label class="block">
						<span class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]">Code</span>
						<input type="text" name="code" bind:value={newCode} class="tron-input text-sm" placeholder="REJ-XX" required />
					</label>
					<label class="block flex-1">
						<span class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]">Label</span>
						<input type="text" name="label" bind:value={newLabel} class="tron-input text-sm" placeholder="Reason description" required />
					</label>
					<label class="block">
						<span class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]">Sort Order</span>
						<input type="number" name="sortOrder" bind:value={newSortOrder} class="tron-input text-sm" style="width:80px" />
					</label>
					<button type="submit" class="min-h-[44px] rounded border border-green-500/50 px-4 py-2 text-sm text-green-400 hover:bg-green-900/20">Add</button>
					<button type="button" onclick={() => { showAddReason = false; }} class="min-h-[44px] rounded border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)]">Cancel</button>
				</form>
			{:else}
				<button
					type="button"
					onclick={() => { showAddReason = true; }}
					class="mt-4 rounded border border-[var(--color-tron-cyan)]/50 px-4 py-2 text-sm text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10"
				>
					+ Add Failure Reason
				</button>
			{/if}
		</div>
	{/if}
</div>

<!-- Lightbox -->
{#if lightboxIndex !== null}
	{@const img = images[lightboxIndex]}
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
				<img src={img.url} alt={img.cartridgeImageNumber ?? 'capture'} class="mx-auto max-h-[70vh] rounded shadow-2xl" />
			{/if}

			<!-- Pass / Fail review controls -->
			<div class="flex items-center justify-center gap-2">
				<button
					type="button"
					disabled={labeling === img.id}
					onclick={() => labelAndAdvance('approved')}
					class="rounded px-5 py-2 text-sm font-bold transition-colors disabled:opacity-40
						{img.qcLabel === 'approved'
							? 'bg-[var(--color-tron-green,#39ff14)] text-black'
							: 'border border-[var(--color-tron-green,#39ff14)] text-[var(--color-tron-green,#39ff14)] hover:bg-[var(--color-tron-green,#39ff14)]/20'}"
				>✓ Pass <span class="ml-1 opacity-60">(A)</span></button>
				<button
					type="button"
					disabled={labeling === img.id}
					onclick={() => labelAndAdvance('rejected')}
					class="rounded px-5 py-2 text-sm font-bold transition-colors disabled:opacity-40
						{img.qcLabel === 'rejected'
							? 'bg-[var(--color-tron-red,#ff3366)] text-white'
							: 'border border-[var(--color-tron-red,#ff3366)] text-[var(--color-tron-red,#ff3366)] hover:bg-[var(--color-tron-red,#ff3366)]/20'}"
				>✗ Fail <span class="ml-1 opacity-60">(F)</span></button>
				<button
					type="button"
					disabled={labeling === img.id || !img.qcLabel}
					onclick={() => labelAndAdvance(null)}
					class="rounded border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-text-primary)] disabled:opacity-30"
				>Clear <span class="ml-1 opacity-60">(C)</span></button>
			</div>

			<div class="rounded bg-[var(--color-tron-bg-secondary)] p-3 text-sm">
				<div class="grid gap-2 sm:grid-cols-2">
					<div><span class="text-[var(--color-tron-text-secondary)]">Image:</span> <span class="font-mono text-[var(--color-tron-cyan)]">{img.cartridgeImageNumber ?? '—'}</span></div>
					<div><span class="text-[var(--color-tron-text-secondary)]">Cartridge:</span> <a href={`/cartridge-admin/dhr/${img.cartridgeRecordId}`} class="text-[var(--color-tron-cyan)] underline">{img.cartridgeRecordId ?? '—'}</a></div>
					<div><span class="text-[var(--color-tron-text-secondary)]">Phase:</span> {img.phase ?? '—'}</div>
					<div>
						<span class="text-[var(--color-tron-text-secondary)]">Verdict:</span>
						{#if img.qcLabel === 'approved'}
							<span class="font-semibold text-[var(--color-tron-green,#39ff14)]">Pass</span>
						{:else if img.qcLabel === 'rejected'}
							<span class="font-semibold text-[var(--color-tron-red,#ff3366)]">Fail</span>
						{:else}
							<span class="text-[var(--color-tron-text-secondary)]">unreviewed</span>
						{/if}
					</div>
					<div><span class="text-[var(--color-tron-text-secondary)]">Captured:</span> {img.capturedAt ? new Date(img.capturedAt).toLocaleString() : '—'}</div>
					<div><span class="text-[var(--color-tron-text-secondary)]">By:</span> {img.capturedByUsername ?? '—'}</div>
					{#if img.labels && img.labels.length > 0}
						<div class="sm:col-span-2">
							<span class="text-[var(--color-tron-text-secondary)]">Tags:</span>
							<span class="ml-1 flex flex-wrap gap-1">
								{#each img.labels as l (l)}
									<span class="rounded bg-[var(--color-tron-cyan)]/20 px-1.5 py-0.5 text-[10px] text-[var(--color-tron-cyan)]">{l}</span>
								{/each}
							</span>
						</div>
					{/if}
					{#if img.notes}
						<div class="sm:col-span-2"><span class="text-[var(--color-tron-text-secondary)]">Notes:</span> <span class="whitespace-pre-wrap">{img.notes}</span></div>
					{/if}
				</div>
			</div>
		</div>
	</div>
{/if}
