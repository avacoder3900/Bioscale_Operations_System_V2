<script lang="ts">
	let { data } = $props();

	let expandedFridge = $state<string | null>(null);
	let filterType = $state<'all' | 'wax_filled' | 'reagent_filled'>('all');

	function toggleFridge(location: string) {
		expandedFridge = expandedFridge === location ? null : location;
	}

	function formatDate(iso: string | null): string {
		if (!iso) return '—';
		return new Date(iso).toLocaleString();
	}

	function typeLabel(type: string): string {
		return type === 'wax_filled' ? 'Wax Filled' : 'Reagent Filled';
	}

	function typeBadgeClass(type: string): string {
		return type === 'wax_filled'
			? 'bg-amber-900/30 text-amber-300 border border-amber-500/30'
			: 'bg-purple-900/30 text-purple-300 border border-purple-500/30';
	}
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold text-[var(--color-tron-cyan)]">Fridge Storage</h1>
			<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">Cartridge inventory by storage location</p>
		</div>
	</div>

	<!-- INCIDENT NOTE 2026-04-23 — Fridge-002 physical audit vs. Mongo showed
	     a 20-cartridge gap (Mongo=78, physical count=59). All 20 have been
	     logged as manual checkouts. Counts below may still include these
	     until the occupancy query is patched to exclude `manual_cartridge_removals`.
	     Tracking-failure discussion on the Kanban board, due Friday 2026-04-24. -->
	<div class="rounded-lg border border-amber-500/50 bg-amber-900/10 p-4">
		<div class="flex items-start gap-3">
			<svg class="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
			</svg>
			<div class="text-xs text-amber-200">
				<div class="font-semibold text-amber-300">Tracking-failure notice — 2026-04-23</div>
				<p class="mt-1">
					A physical audit of FRIDGE-002 found 20 fewer cartridges than Mongo records indicate: 10 from a 2026-04-16 batch with no cooling tray assigned, 8 attributed to "Zane Testing 4-21", and 2 more from 2026-04-22 runs. All 20 are now logged as manual checkouts, but the active-occupancy count below may still include them until we patch the query to filter out `manual_cartridge_removals`.
				</p>
				<p class="mt-1 text-amber-300/80">
					Follow-up discussion on the Kanban board (QA Improvements, due Friday 2026-04-24).
				</p>
			</div>
		</div>
	</div>

	<!-- Summary cards -->
	<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 text-center">
			<div class="text-3xl font-bold text-[var(--color-tron-cyan)]">{data.summary.totalFridges}</div>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">Fridges</div>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 text-center">
			<div class="text-3xl font-bold text-[var(--color-tron-text)]">{data.summary.totalCartridges}</div>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">Total Stored</div>
		</div>
		<div class="rounded-lg border border-amber-500/30 bg-amber-900/10 p-4 text-center">
			<div class="text-3xl font-bold text-amber-400">{data.summary.totalWax}</div>
			<div class="text-xs text-amber-300/70">Wax Filled</div>
		</div>
		<div class="rounded-lg border border-purple-500/30 bg-purple-900/10 p-4 text-center">
			<div class="text-3xl font-bold text-purple-400">{data.summary.totalReagent}</div>
			<div class="text-xs text-purple-300/70">Reagent Filled</div>
		</div>
	</div>

	<!-- Filter -->
	<div class="flex items-center gap-2">
		<span class="text-xs text-[var(--color-tron-text-secondary)]">Show:</span>
		<button type="button" onclick={() => { filterType = 'all'; }}
			class="rounded px-3 py-1.5 text-xs font-medium transition-colors {filterType === 'all' ? 'bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]' : 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}">
			All
		</button>
		<button type="button" onclick={() => { filterType = 'wax_filled'; }}
			class="rounded px-3 py-1.5 text-xs font-medium transition-colors {filterType === 'wax_filled' ? 'bg-amber-900/30 text-amber-300' : 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}">
			Wax Filled
		</button>
		<button type="button" onclick={() => { filterType = 'reagent_filled'; }}
			class="rounded px-3 py-1.5 text-xs font-medium transition-colors {filterType === 'reagent_filled' ? 'bg-purple-900/30 text-purple-300' : 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}">
			Reagent Filled
		</button>
	</div>

	<!-- Fridge list -->
	{#if data.fridgeInventory.length === 0}
		<p class="text-sm text-[var(--color-tron-text-secondary)]">No fridges configured. Add fridges in Equipment → Fridges & Ovens.</p>
	{:else}
		<div class="space-y-3">
			{#each data.fridgeInventory as fridge (fridge.location)}
				{@const filteredCarts = filterType === 'all' ? fridge.cartridges : fridge.cartridges.filter((c) => c.type === filterType)}
				{@const isExpanded = expandedFridge === fridge.location}
				<div class="rounded-lg border {fridge.isActive ? 'border-[var(--color-tron-border)]' : 'border-red-500/30 opacity-60'} bg-[var(--color-tron-surface)] overflow-hidden">
					<!-- Fridge header -->
					<div class="flex w-full items-center justify-between p-4">
						<button
							type="button"
							onclick={() => toggleFridge(fridge.location)}
							class="flex min-w-0 flex-1 items-center gap-3 text-left transition-colors hover:bg-transparent"
						>
							<div class="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-[var(--color-tron-cyan)]/10">
								<svg class="h-7 w-7 text-[var(--color-tron-cyan)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
									<path stroke-linecap="round" stroke-linejoin="round" d="M6 2h12a1 1 0 011 1v18a1 1 0 01-1 1H6a1 1 0 01-1-1V3a1 1 0 011-1zm0 12h12M10 6h1" />
								</svg>
							</div>
							<div>
								{#if fridge.fridgeId}
									<a href="/equipment/location/{fridge.fridgeId}" class="text-base font-semibold text-[var(--color-tron-text)] hover:text-[var(--color-tron-cyan)] transition-colors" onclick={(e) => e.stopPropagation()}>{fridge.displayName}</a>
								{:else}
									<h3 class="text-base font-semibold text-[var(--color-tron-text)]">{fridge.displayName}</h3>
								{/if}
								<div class="mt-0.5 flex items-center gap-3 text-xs text-[var(--color-tron-text-secondary)]">
									{#if fridge.waxCount > 0}
										<span class="rounded bg-amber-900/20 px-1.5 py-0.5 text-amber-300">{fridge.waxCount} wax</span>
									{/if}
									{#if fridge.reagentCount > 0}
										<span class="rounded bg-purple-900/20 px-1.5 py-0.5 text-purple-300">{fridge.reagentCount} reagent</span>
									{/if}
									{#if fridge.totalCount === 0}
										<span class="italic">Empty</span>
									{/if}
								</div>
							</div>
						</button>
						<button type="button" onclick={() => toggleFridge(fridge.location)} class="flex items-center gap-3">
							<span class="text-2xl font-bold {fridge.totalCount > 0 ? 'text-[var(--color-tron-text)]' : 'text-[var(--color-tron-text-secondary)]'}">
								{filteredCarts.length}
							</span>
							<svg class="h-5 w-5 text-[var(--color-tron-text-secondary)] transition-transform {isExpanded ? 'rotate-180' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
								<path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
							</svg>
						</button>
					</div>

					<!-- Expanded cartridge list -->
					{#if isExpanded}
						<div class="border-t border-[var(--color-tron-border)]">
							{#if filteredCarts.length === 0}
								<p class="px-4 py-3 text-sm text-[var(--color-tron-text-secondary)] italic">
									{filterType === 'all' ? 'No cartridges stored' : `No ${filterType === 'wax_filled' ? 'wax filled' : 'reagent filled'} cartridges`}
								</p>
							{:else}
								<!-- Column headers -->
								<div class="grid grid-cols-12 gap-2 border-b border-[var(--color-tron-border)]/50 px-4 py-2 text-[10px] font-medium text-[var(--color-tron-text-secondary)] uppercase">
									<div class="col-span-3">Cartridge ID</div>
									<div class="col-span-2">Type</div>
									<div class="col-span-2">Phase</div>
									<div class="col-span-2">Assay</div>
									<div class="col-span-2">Stored</div>
									<div class="col-span-1">By</div>
								</div>
								<div class="max-h-80 overflow-y-auto divide-y divide-[var(--color-tron-border)]/30">
									{#each filteredCarts as cart (cart.id)}
										<div class="grid grid-cols-12 items-center gap-2 px-4 py-2 text-xs hover:bg-[var(--color-tron-cyan)]/5">
											<div class="col-span-3 font-mono text-[var(--color-tron-text)]">{cart.id}</div>
											<div class="col-span-2">
												<span class="rounded px-1.5 py-0.5 text-[10px] font-medium {typeBadgeClass(cart.type)}">{typeLabel(cart.type)}</span>
											</div>
											<div class="col-span-2 text-[var(--color-tron-text-secondary)]">{cart.phase}</div>
											<div class="col-span-2 text-[var(--color-tron-text-secondary)] truncate">{cart.assayType ?? '—'}</div>
											<div class="col-span-2 text-[var(--color-tron-text-secondary)]">{cart.storedAt ? new Date(cart.storedAt).toLocaleDateString() : '—'}</div>
											<div class="col-span-1 text-[var(--color-tron-text-secondary)] truncate">{cart.operator ?? '—'}</div>
										</div>
									{/each}
								</div>
							{/if}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
