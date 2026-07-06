<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	// Filter state (initialized from server)
	let cartridgeIdSubstr = $state(data.filters.cartridgeIdSubstr || '');
	let assayId = $state(data.filters.assayId || '');
	let waxRunId = $state(data.filters.waxRunId || '');
	let reagentRunId = $state(data.filters.reagentRunId || '');
	let operatorId = $state(data.filters.operatorId || '');
	let status = $state(data.filters.status || '');
	let phase = $state(data.filters.phase || '');
	let labelFilter = $state(data.filters.labelFilter || '');
	let fromDate = $state(data.filters.fromDate || '');
	let toDate = $state(data.filters.toDate || '');

	// Selection
	let selected = $state<Set<string>>(new Set());
	let submitting = $state(false);

	function applyFilters() {
		const params = new URLSearchParams();
		if (cartridgeIdSubstr) params.set('cartridge', cartridgeIdSubstr);
		if (assayId) params.set('assay', assayId);
		if (waxRunId) params.set('waxRun', waxRunId);
		if (reagentRunId) params.set('reagentRun', reagentRunId);
		if (operatorId) params.set('operator', operatorId);
		if (status) params.set('status', status);
		if (phase) params.set('phase', phase);
		if (labelFilter) params.set('label', labelFilter);
		if (fromDate) params.set('from', fromDate);
		if (toDate) params.set('to', toDate);
		selected = new Set();
		goto(`/cv/label?${params.toString()}`);
	}

	function resetFilters() {
		cartridgeIdSubstr = '';
		assayId = '';
		waxRunId = '';
		reagentRunId = '';
		operatorId = '';
		status = '';
		phase = '';
		labelFilter = '';
		fromDate = '';
		toDate = '';
		selected = new Set();
		goto('/cv/label');
	}

	function goToPage(p: number) {
		const params = new URLSearchParams($page.url.searchParams);
		params.set('page', String(p));
		goto(`/cv/label?${params.toString()}`);
	}

	function toggleSelect(id: string) {
		const next = new Set(selected);
		if (next.has(id)) next.delete(id); else next.add(id);
		selected = next;
	}

	function selectAllOnPage() {
		const next = new Set(selected);
		for (const img of data.images) next.add(img.id);
		selected = next;
	}

	function clearSelection() {
		selected = new Set();
	}

	function selectUnlabeledOnPage() {
		const next = new Set(selected);
		for (const img of data.images) {
			if (!img.qcLabel) next.add(img.id);
		}
		selected = next;
	}
</script>

<div class="space-y-4">
	<header>
		<h1 class="text-2xl font-bold text-[var(--color-tron-cyan)]">Label Images</h1>
		<p class="text-sm text-[var(--color-tron-text-secondary)]">
			Search by any cartridge field, bulk approve or reject. Labels go on the image and persist independent of any project.
		</p>
	</header>

	<!-- Filter builder -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
		<h3 class="mb-3 text-sm font-semibold uppercase text-[var(--color-tron-text-secondary)]">Find cartridges</h3>
		<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
			<div>
				<label for="f-cart" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">Cartridge ID</label>
				<input id="f-cart" type="text" bind:value={cartridgeIdSubstr} placeholder="prefix or substring" class="tron-input w-full" />
			</div>
			<div>
				<label for="f-assay" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">Assay</label>
				<select id="f-assay" bind:value={assayId} class="tron-input w-full">
					<option value="">Any</option>
					{#each data.assays as a (a.id)}
						<option value={a.id}>{a.name}{a.sku ? ` (${a.sku})` : ''}</option>
					{/each}
				</select>
			</div>
			<div>
				<label for="f-status" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">Cartridge status</label>
				<select id="f-status" bind:value={status} class="tron-input w-full">
					<option value="">Any</option>
					{#each data.statuses as s (s)}
						<option value={s}>{s}</option>
					{/each}
				</select>
			</div>
			<div>
				<label for="f-wax" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">Wax run</label>
				<select id="f-wax" bind:value={waxRunId} class="tron-input w-full">
					<option value="">Any</option>
					{#each data.waxRuns as r (r.id)}
						<option value={r.id}>{r.label}</option>
					{/each}
				</select>
			</div>
			<div>
				<label for="f-reagent" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">Reagent run</label>
				<select id="f-reagent" bind:value={reagentRunId} class="tron-input w-full">
					<option value="">Any</option>
					{#each data.reagentRuns as r (r.id)}
						<option value={r.id}>{r.label}</option>
					{/each}
				</select>
			</div>
			<div>
				<label for="f-op" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">Operator (any phase)</label>
				<select id="f-op" bind:value={operatorId} class="tron-input w-full">
					<option value="">Any</option>
					{#each data.operators as u (u.id)}
						<option value={u.id}>{u.username}</option>
					{/each}
				</select>
			</div>
			<div>
				<label for="f-from" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">Created from</label>
				<input id="f-from" type="date" bind:value={fromDate} class="tron-input w-full" />
			</div>
			<div>
				<label for="f-to" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">Created to</label>
				<input id="f-to" type="date" bind:value={toDate} class="tron-input w-full" />
			</div>
			<div>
				<label for="f-phase" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">Image phase</label>
				<select id="f-phase" bind:value={phase} class="tron-input w-full">
					<option value="">Any</option>
					{#each data.phases as p (p)}
						<option value={p}>{p}</option>
					{/each}
				</select>
			</div>
			<div>
				<label for="f-label" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">Image label</label>
				<select id="f-label" bind:value={labelFilter} class="tron-input w-full">
					<option value="">Any</option>
					<option value="approved">Approved</option>
					<option value="rejected">Rejected</option>
					<option value="unlabeled">Unlabeled</option>
				</select>
			</div>
		</div>
		<div class="mt-3 flex gap-2">
			<button type="button" onclick={applyFilters} class="rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-[var(--color-tron-bg-primary)]">
				Search
			</button>
			<button type="button" onclick={resetFilters} class="rounded border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)]">
				Reset
			</button>
		</div>
	</div>

	<!-- Bulk action bar -->
	{#if data.images.length > 0}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3">
			<div class="flex flex-wrap items-center justify-between gap-3">
				<div class="text-sm text-[var(--color-tron-text-secondary)]">
					{data.total.toLocaleString()} matching images
					{#if data.matchingCartridges > 0} across {data.matchingCartridges.toLocaleString()} cartridges{/if}
					· {selected.size} selected
				</div>
				<div class="flex flex-wrap gap-2">
					<button type="button" onclick={selectAllOnPage} class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)]">
						Select page
					</button>
					<button type="button" onclick={selectUnlabeledOnPage} class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)]">
						Select unlabeled on page
					</button>
					<button type="button" onclick={clearSelection} class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)]">
						Clear
					</button>
				</div>
			</div>

			{#if selected.size > 0}
				<form
					method="POST"
					action="?/bulkLabel"
					class="mt-3 flex flex-wrap gap-2 border-t border-[var(--color-tron-border)] pt-3"
					use:enhance={() => {
						submitting = true;
						return async ({ update }) => {
							await update();
							submitting = false;
							selected = new Set();
						};
					}}
				>
					{#each [...selected] as id (id)}
						<input type="hidden" name="imageId" value={id} />
					{/each}
					<button type="submit" name="label" value="approved" disabled={submitting} class="rounded bg-[var(--color-tron-green,#39ff14)] px-3 py-1.5 text-xs font-medium text-black disabled:opacity-40">
						✓ Approve {selected.size}
					</button>
					<button type="submit" name="label" value="rejected" disabled={submitting} class="rounded bg-[var(--color-tron-red,#ff3366)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">
						✗ Reject {selected.size}
					</button>
					<button type="submit" name="label" value="clear" disabled={submitting} class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)] disabled:opacity-40">
						Clear labels
					</button>
				</form>
			{/if}

			{#if form?.success && form.updated}
				<div class="mt-2 text-xs text-[var(--color-tron-green,#39ff14)]">
					Updated {form.updated} images → {form.label ?? 'unlabeled'}.
				</div>
			{/if}
		</div>
	{/if}

	<!-- Results -->
	{#if data.images.length === 0}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-12 text-center">
			<p class="text-[var(--color-tron-text-secondary)]">No images match these filters.</p>
			<p class="mt-2 text-xs text-[var(--color-tron-text-secondary)]">Try widening the search or resetting filters.</p>
		</div>
	{:else}
		<div class="grid gap-3 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
			{#each data.images as img (img.id)}
				{@const isSelected = selected.has(img.id)}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="overflow-hidden rounded border-2 bg-[var(--color-tron-bg-secondary)] transition-colors
						{isSelected ? 'border-[var(--color-tron-cyan)]' : 'border-[var(--color-tron-border)] hover:border-[var(--color-tron-cyan)]'}"
					onclick={() => toggleSelect(img.id)}
				>
					{#if img.thumbnailUrl}
						<img src={img.thumbnailUrl} alt={img.cartridgeImageNumber ?? 'capture'} class="aspect-square w-full object-cover" />
					{:else}
						<div class="aspect-square w-full bg-[var(--color-tron-bg-tertiary)]"></div>
					{/if}
					<div class="p-2 text-xs">
						<div class="flex items-center justify-between">
							<input
								type="checkbox"
								checked={isSelected}
								onclick={(e) => e.stopPropagation()}
								onchange={() => toggleSelect(img.id)}
							/>
							{#if img.qcLabel === 'approved'}
								<span class="rounded bg-[var(--color-tron-green,#39ff14)] px-1.5 py-0.5 text-[10px] font-bold text-black">APPROVED</span>
							{:else if img.qcLabel === 'rejected'}
								<span class="rounded bg-[var(--color-tron-red,#ff3366)] px-1.5 py-0.5 text-[10px] font-bold text-white">REJECTED</span>
							{:else}
								<span class="text-[10px] text-[var(--color-tron-text-secondary)]">unlabeled</span>
							{/if}
						</div>
						<div class="mt-1 truncate font-mono text-[var(--color-tron-cyan)]">{img.cartridgeImageNumber ?? '—'}</div>
						<div class="truncate text-[var(--color-tron-text-secondary)]">{img.phase ?? '—'}</div>
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
</div>
