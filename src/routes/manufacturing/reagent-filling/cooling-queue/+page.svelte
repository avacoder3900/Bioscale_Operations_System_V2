<script lang="ts">
	let { data } = $props();

	let filterReady = $state<'all' | 'ready' | 'not-ready'>('all');

	let filtered = $derived.by(() => {
		if (filterReady === 'ready') return data.cartridges.filter((c) => c.isReady);
		if (filterReady === 'not-ready') return data.cartridges.filter((c) => !c.isReady);
		return data.cartridges;
	});

	let readyCount = $derived(data.cartridges.filter((c) => c.isReady).length);
	let notReadyCount = $derived(data.cartridges.length - readyCount);
</script>

<div class="space-y-4">
	<div class="flex items-center justify-between">
		<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Cooling Queue</h2>
		<div class="flex items-center gap-2">
			<span class="text-sm text-[var(--color-tron-text-secondary)]">
				{readyCount} ready, {notReadyCount} cooling
			</span>
			<select
				bind:value={filterReady}
				class="min-h-[44px] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
			>
				<option value="all">All ({data.cartridges.length})</option>
				<option value="ready">Ready ({readyCount})</option>
				<option value="not-ready">Cooling ({notReadyCount})</option>
			</select>
		</div>
	</div>

	{#if filtered.length === 0}
		<div
			class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-8 text-center text-sm text-[var(--color-tron-text-secondary)]"
		>
			No cartridges in cooling queue
		</div>
	{:else}
		<div class="overflow-x-auto rounded border border-[var(--color-tron-border)]">
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
						<th class="px-4 py-3 text-left font-medium text-[var(--color-tron-text-secondary)]">
							Cartridge ID
						</th>
						<th class="px-4 py-3 text-left font-medium text-[var(--color-tron-text-secondary)]">
							Wax Run
						</th>
						<th class="px-4 py-3 text-left font-medium text-[var(--color-tron-text-secondary)]">
							QC Timestamp
						</th>
						<th class="px-4 py-3 text-left font-medium text-[var(--color-tron-text-secondary)]">
							Cooling Time
						</th>
						<th class="px-4 py-3 text-left font-medium text-[var(--color-tron-text-secondary)]">
							Status
						</th>
					</tr>
				</thead>
				<tbody>
					{#each filtered as cartridge (cartridge.cartridgeId)}
						<tr class="border-b border-[var(--color-tron-border)]/50 hover:bg-[var(--color-tron-surface)]/50">
							<td class="px-4 py-3 font-mono text-xs text-[var(--color-tron-text)]">
								{cartridge.cartridgeId}
							</td>
							<td class="px-4 py-3 text-[var(--color-tron-text-secondary)]">
								{cartridge.waxRunId ?? '—'}
							</td>
							<td class="px-4 py-3 text-[var(--color-tron-text-secondary)]">
								{cartridge.qcTimestamp
									? new Date(cartridge.qcTimestamp).toLocaleString()
									: '—'}
							</td>
							<td class="px-4 py-3 text-[var(--color-tron-text)]">
								{cartridge.coolingElapsedMin} min
							</td>
							<td class="px-4 py-3">
								{#if cartridge.isReady}
									<span
										class="inline-flex items-center gap-1 rounded border border-green-500/30 bg-green-900/50 px-2 py-0.5 text-xs font-medium text-green-300"
									>
										<span class="h-1.5 w-1.5 rounded-full bg-green-400"></span>
										Ready
									</span>
								{:else}
									<span
										class="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-900/50 px-2 py-0.5 text-xs font-medium text-amber-300"
									>
										<span class="h-1.5 w-1.5 rounded-full bg-amber-400"></span>
										{cartridge.minutesRemaining} min remaining
									</span>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
