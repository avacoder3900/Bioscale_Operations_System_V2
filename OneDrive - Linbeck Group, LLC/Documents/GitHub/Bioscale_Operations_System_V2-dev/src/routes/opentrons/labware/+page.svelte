<script lang="ts">
	let { data } = $props();

	let filterCategory = $state('All');
	let sortDir = $state<'asc' | 'desc'>('asc');

	const categories = $derived(() => {
		const cats = new Set(data.labware.map((lw) => lw.category));
		return ['All', ...Array.from(cats).sort()];
	});

	const filteredLabware = $derived(() => {
		let list = data.labware;
		if (filterCategory !== 'All') {
			list = list.filter((lw) => lw.category === filterCategory);
		}
		return [...list].sort((a, b) => {
			const cmp = a.displayName.localeCompare(b.displayName);
			return sortDir === 'asc' ? cmp : -cmp;
		});
	});
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-[var(--color-tron-text)]">Labware</h1>
	</div>

	<!-- Filters -->
	<div class="flex items-center gap-4">
		<div class="flex items-center gap-2 text-sm">
			<span class="text-[var(--color-tron-text-secondary)]">Category</span>
			<select bind:value={filterCategory} class="tron-input px-2 py-1 text-sm">
				{#each categories() as cat (cat)}
					<option value={cat}>{cat}</option>
				{/each}
			</select>
		</div>

		<div class="flex items-center gap-2 text-sm">
			<span class="text-[var(--color-tron-text-secondary)]">Sort</span>
			<select bind:value={sortDir} class="tron-input px-2 py-1 text-sm">
				<option value="asc">A–Z</option>
				<option value="desc">Z–A</option>
			</select>
		</div>

		<span class="text-xs text-[var(--color-tron-text-secondary)]">
			{filteredLabware().length} item{filteredLabware().length === 1 ? '' : 's'}
		</span>
	</div>

	<!-- Labware list -->
	{#if filteredLabware().length === 0}
		<div class="flex flex-col items-center justify-center rounded-lg border border-dashed border-[var(--color-tron-border)] py-16">
			<svg class="mb-4 h-12 w-12 text-[var(--color-tron-text-secondary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
			</svg>
			<p class="mb-2 text-lg font-medium text-[var(--color-tron-text)]">No labware found</p>
			<p class="text-sm text-[var(--color-tron-text-secondary)]">
				Upload protocols to populate the labware library.
			</p>
		</div>
	{:else}
		<div class="space-y-2">
			{#each filteredLabware() as lw (lw.loadName)}
				<div class="flex items-center gap-4 rounded-lg border border-[var(--color-tron-border)] p-3">
					<!-- Icon -->
					<div class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded bg-[var(--color-tron-bg-secondary)]">
						<svg class="h-5 w-5 text-[var(--color-tron-text-secondary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
						</svg>
					</div>

					<!-- Info -->
					<div class="flex-1">
						<h3 class="text-sm font-medium text-[var(--color-tron-text)]">{lw.displayName}</h3>
						<span class="text-xs text-[var(--color-tron-text-secondary)]">{lw.loadName}</span>
					</div>

					<!-- Category badge -->
					<span class="rounded bg-[var(--color-tron-bg-secondary)] px-2 py-0.5 text-xs text-[var(--color-tron-text-secondary)]">
						{lw.category}
					</span>

					<!-- Usage count -->
					<span class="text-xs text-[var(--color-tron-text-secondary)]">
						Used in {lw.count} protocol{lw.count === 1 ? '' : 's'}
					</span>
				</div>
			{/each}
		</div>
	{/if}
</div>
