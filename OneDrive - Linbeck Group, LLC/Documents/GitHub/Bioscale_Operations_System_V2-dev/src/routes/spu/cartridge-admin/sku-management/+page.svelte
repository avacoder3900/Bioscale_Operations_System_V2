<script lang="ts">
	import { enhance } from '$app/forms';

	let { data } = $props();

	let showAddForm = $state(false);
	let expandedId = $state<string | null>(null);
	let successMsg = $state('');
	let editingCostId = $state<string | null>(null);
	let editCostValue = $state('');
	let editingShelfId = $state<string | null>(null);
	let editShelfValue = $state('');
	function handleResult() {
		return async ({ result, update }: { result: { type: string }; update: () => Promise<void> }) => {
			if (result.type === 'success') {
				successMsg = 'Saved';
				setTimeout(() => { successMsg = ''; }, 2000);
			}
			await update();
		};
	}

	function computedTotalCost(reagents: typeof data.assayTypes[0]['reagents']): string | null {
		let total = 0;
		let hasAnyCost = false;
		for (const r of reagents) {
			if (!r.isActive) continue;
			if (r.hasBreakdown && r.subComponents.length > 0) {
				for (const sc of r.subComponents) {
					if (sc.unitCost) {
						total += parseFloat(sc.unitCost);
						hasAnyCost = true;
					}
				}
			} else if (r.unitCost) {
				total += parseFloat(r.unitCost);
				hasAnyCost = true;
			}
		}
		return hasAnyCost ? total.toFixed(2) : null;
	}

	function subComponentTotal(subComponents: typeof data.assayTypes[0]['reagents'][0]['subComponents']): string | null {
		let total = 0;
		let hasAnyCost = false;
		for (const sc of subComponents) {
			if (sc.unitCost) {
				total += parseFloat(sc.unitCost);
				hasAnyCost = true;
			}
		}
		return hasAnyCost ? total.toFixed(2) : null;
	}

	let prefilledTotal = $derived(
		data.bomItems.reduce((sum, item) => {
			const cost = item.unitCost ? parseFloat(item.unitCost) : 0;
			return sum + cost * item.quantityPerUnit;
		}, 0)
	);

	let hasPrefilledCost = $derived(data.bomItems.some((item) => item.unitCost));
	let syncing = $state(false);
	let syncMsg = $state('');
</script>

<div class="space-y-4">
	<div class="flex items-center justify-between">
		<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">SKU Management</h2>
		<button type="button" onclick={() => { showAddForm = !showAddForm; }}
			class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)]"
		>
			{showAddForm ? 'Cancel' : '+ New Assay Type'}
		</button>
	</div>

	{#if successMsg}
		<div class="rounded border border-green-500/50 bg-green-900/20 px-4 py-2 text-sm text-green-300">{successMsg}</div>
	{/if}

	{#if showAddForm}
		<form method="POST" action="?/createAssayType" use:enhance={handleResult}
			class="rounded border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/5 p-4"
		>
			<div class="flex gap-3">
				<input name="name" placeholder="Assay type name" required
					class="min-h-[44px] flex-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)]" />
				<input name="skuCode" placeholder="SKU code" required
					class="min-h-[44px] w-32 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)]" />
				<input name="shelfLifeDays" type="number" placeholder="Shelf life (days)" value="90"
					class="min-h-[44px] w-36 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)]" />
				<button type="submit"
					class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)]"
				>
					Create
				</button>
			</div>
			<p class="mt-2 text-xs text-[var(--color-tron-text-secondary)]">Creates with 6 default reagent names (wells 2-7)</p>
		</form>
	{/if}

	<!-- Assay Type Table -->
	<div class="overflow-x-auto rounded border border-[var(--color-tron-border)]">
		<table class="w-full text-sm">
			<thead>
				<tr class="border-b border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
					<th class="px-4 py-3 text-left font-medium text-[var(--color-tron-text-secondary)]">Name</th>
					<th class="px-4 py-3 text-left font-medium text-[var(--color-tron-text-secondary)]">SKU Code</th>
					<th class="px-4 py-3 text-left font-medium text-[var(--color-tron-text-secondary)]">Status</th>
					<th class="px-4 py-3 text-right font-medium text-[var(--color-tron-text-secondary)]">Shelf Life</th>
					<th class="px-4 py-3 text-right font-medium text-[var(--color-tron-text-secondary)]">BOM Cost</th>
					<th class="px-4 py-3 text-right font-medium text-[var(--color-tron-text-secondary)]">Reagents</th>
					<th class="px-4 py-3 text-right font-medium text-[var(--color-tron-text-secondary)]">Cartridges</th>
					<th class="px-4 py-3 text-right font-medium text-[var(--color-tron-text-secondary)]">Actions</th>
				</tr>
			</thead>
			<tbody>
				{#each data.assayTypes as at (at.id)}
					{@const calcCost = at.useSingleCost ? null : computedTotalCost(at.reagents)}
					<tr class="border-b border-[var(--color-tron-border)]/50 hover:bg-[var(--color-tron-surface)]/50">
						<td class="px-4 py-3 font-medium text-[var(--color-tron-text)]">{at.name}</td>
						<td class="px-4 py-3 font-mono text-xs text-[var(--color-tron-cyan)]">{at.skuCode}</td>
						<td class="px-4 py-3">
							{#if at.isActive}
								<span class="rounded border border-green-500/30 bg-green-900/20 px-1.5 py-0.5 text-xs text-green-400">Active</span>
							{:else}
								<span class="rounded border border-red-500/30 bg-red-900/20 px-1.5 py-0.5 text-xs text-red-400">Inactive</span>
							{/if}
						</td>
						<td class="px-4 py-3 text-right">
							{#if editingShelfId === at.id}
								<form method="POST" action="?/updateAssayType" use:enhance={() => {
									return async ({ result, update }: { result: { type: string }; update: () => Promise<void> }) => {
										if (result.type === 'success') {
											editingShelfId = null;
											successMsg = 'Saved';
											setTimeout(() => { successMsg = ''; }, 2000);
										}
										await update();
									};
								}}>
									<input type="hidden" name="id" value={at.id} />
									<div class="flex items-center justify-end gap-1">
										<input name="shelfLifeDays" type="number" value={editShelfValue}
											class="min-h-[32px] w-20 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-right text-sm text-[var(--color-tron-text)]" />
										<span class="text-xs text-[var(--color-tron-text-secondary)]">d</span>
										<button type="submit" class="min-h-[32px] text-xs text-[var(--color-tron-cyan)]">Save</button>
										<button type="button" onclick={() => { editingShelfId = null; }} class="min-h-[32px] text-xs text-[var(--color-tron-text-secondary)]">X</button>
									</div>
								</form>
							{:else}
								<button type="button" onclick={() => { editingShelfId = at.id; editShelfValue = String(at.shelfLifeDays); }}
									class="min-h-[32px] text-sm text-[var(--color-tron-text)] hover:text-[var(--color-tron-cyan)]"
								>
									{at.shelfLifeDays}d
								</button>
							{/if}
						</td>
						<td class="px-4 py-3 text-right">
							{#if editingCostId === at.id}
								<form method="POST" action="?/updateAssayType" use:enhance={() => {
									return async ({ result, update }: { result: { type: string }; update: () => Promise<void> }) => {
										if (result.type === 'success') {
											editingCostId = null;
											successMsg = 'Saved';
											setTimeout(() => { successMsg = ''; }, 2000);
										}
										await update();
									};
								}}>
									<input type="hidden" name="id" value={at.id} />
									<div class="flex items-center justify-end gap-1">
										<span class="text-xs text-[var(--color-tron-text-secondary)]">$</span>
										<input name="bomCostOverride" type="text" value={editCostValue}
											class="min-h-[32px] w-20 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-right text-sm text-[var(--color-tron-text)]" />
										<button type="submit" class="min-h-[32px] text-xs text-[var(--color-tron-cyan)]">Save</button>
										<button type="button" onclick={() => { editingCostId = null; }} class="min-h-[32px] text-xs text-[var(--color-tron-text-secondary)]">X</button>
									</div>
								</form>
							{:else}
								<button type="button" onclick={() => { editingCostId = at.id; editCostValue = at.bomCostOverride ? String(parseFloat(at.bomCostOverride).toFixed(2)) : ''; }}
									class="min-h-[32px] text-sm text-[var(--color-tron-text)] hover:text-[var(--color-tron-cyan)]"
								>
									{#if at.useSingleCost && at.bomCostOverride}
										${parseFloat(at.bomCostOverride).toFixed(2)}
									{:else if calcCost}
										${calcCost}
										<span class="text-[10px] text-[var(--color-tron-text-secondary)]">calc</span>
									{:else if at.bomCostOverride}
										${parseFloat(at.bomCostOverride).toFixed(2)}
									{:else}
										—
									{/if}
								</button>
							{/if}
						</td>
						<td class="px-4 py-3 text-right text-[var(--color-tron-text-secondary)]">
							{at.reagents.filter((r) => r.isActive).length} / {at.reagents.length}
						</td>
						<td class="px-4 py-3 text-right text-[var(--color-tron-text)]">{at.cartridgeCount}</td>
						<td class="px-4 py-3 text-right">
							<div class="flex items-center justify-end gap-2">
								<form method="POST" action="?/updateAssayType" use:enhance={handleResult}>
									<input type="hidden" name="id" value={at.id} />
									<input type="hidden" name="isActive" value={String(!at.isActive)} />
									<button type="submit" class="min-h-[36px] text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]">
										{at.isActive ? 'Deactivate' : 'Activate'}
									</button>
								</form>
								<button type="button" onclick={() => { expandedId = expandedId === at.id ? null : at.id; }}
									class="min-h-[36px] text-xs text-[var(--color-tron-cyan)]"
								>
									{expandedId === at.id ? 'Hide' : 'Edit Reagents'}
								</button>
							</div>
						</td>
					</tr>
					{#if expandedId === at.id}
						<tr>
							<td colspan="8" class="bg-[var(--color-tron-surface)]/30 px-4 py-4">
								<!-- Single Cost Toggle -->
								<div class="mb-4 flex items-center gap-3">
									<form method="POST" action="?/updateAssayType" use:enhance={handleResult}>
										<input type="hidden" name="id" value={at.id} />
										<input type="hidden" name="useSingleCost" value={String(!at.useSingleCost)} />
										<button type="submit" class="flex min-h-[36px] items-center gap-2 rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs">
											<span class="inline-block h-4 w-8 rounded-full {at.useSingleCost ? 'bg-[var(--color-tron-cyan)]' : 'bg-[var(--color-tron-surface)]'} relative transition-colors">
												<span class="absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all {at.useSingleCost ? 'left-4' : 'left-0.5'}"></span>
											</span>
											<span class="text-[var(--color-tron-text)]">Use Single Cost Input</span>
										</button>
									</form>
									{#if !at.useSingleCost}
										{@const total = computedTotalCost(at.reagents)}
										{#if total}
											<span class="text-xs text-[var(--color-tron-text-secondary)]">Computed Total: <strong class="text-[var(--color-tron-cyan)]">${total}</strong></span>
										{/if}
									{/if}
								</div>

								{#if at.useSingleCost}
									<p class="text-xs text-[var(--color-tron-text-secondary)]">Using single BOM cost override. Click the BOM Cost cell in the table to edit.</p>
								{:else}
									<!-- Reagent Configuration -->
									<p class="mb-3 text-xs font-medium text-[var(--color-tron-text-secondary)]">Reagent Configuration — Wells 2-7</p>
									<div class="space-y-3">
										{#each at.reagents as reagent (reagent.id)}
											<div class="rounded border border-[var(--color-tron-border)]/50 bg-[var(--color-tron-bg)] p-3">
												<div class="flex items-center gap-3">
													<span class="w-14 text-xs text-[var(--color-tron-text-secondary)]">Well {reagent.wellPosition}</span>

													<!-- Reagent details form -->
													<form method="POST" action="?/updateReagentDefinition" use:enhance={handleResult} class="flex flex-1 flex-wrap items-center gap-2">
														<input type="hidden" name="definitionId" value={reagent.id} />
														<input name="reagentName" value={reagent.reagentName} placeholder="Name"
															class="min-h-[36px] w-36 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-2 py-1 text-sm text-[var(--color-tron-text)]" />
														<div class="flex items-center gap-1">
															<span class="text-xs text-[var(--color-tron-text-secondary)]">$</span>
															<input name="unitCost" type="text" value={reagent.unitCost ?? ''} placeholder="Cost"
																class="min-h-[36px] w-20 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-2 py-1 text-right text-sm text-[var(--color-tron-text)]" />
														</div>
														<div class="flex items-center gap-1">
															<input name="volumeMicroliters" type="number" step="0.1" value={reagent.volumeMicroliters ?? ''} placeholder="Vol"
																class="min-h-[36px] w-20 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-2 py-1 text-right text-sm text-[var(--color-tron-text)]" />
															<select name="unit" class="min-h-[36px] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-1 py-1 text-xs text-[var(--color-tron-text)]">
																<option value="µL" selected={reagent.unit === 'µL'}>µL</option>
																<option value="mL" selected={reagent.unit === 'mL'}>mL</option>
																<option value="mg" selected={reagent.unit === 'mg'}>mg</option>
															</select>
														</div>
														<select name="classification" class="min-h-[36px] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-2 py-1 text-xs text-[var(--color-tron-text)]">
															<option value="raw" selected={reagent.classification === 'raw'}>raw</option>
															<option value="processed" selected={reagent.classification === 'processed'}>processed</option>
														</select>
														<button type="submit" class="min-h-[36px] rounded border border-[var(--color-tron-border)] px-2 py-1 text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]">Save</button>
													</form>

													<!-- Active toggle -->
													<form method="POST" action="?/toggleReagentActive" use:enhance={handleResult}>
														<input type="hidden" name="definitionId" value={reagent.id} />
														<input type="hidden" name="isActive" value={String(!reagent.isActive)} />
														<button type="submit" class="min-h-[36px] rounded border px-2 py-1 text-xs {reagent.isActive
															? 'border-green-500/30 text-green-400'
															: 'border-red-500/30 text-red-400'}">
															{reagent.isActive ? 'Active' : 'Disabled'}
														</button>
													</form>
												</div>

												<!-- Breakdown toggle -->
												<div class="mt-2 flex items-center gap-2">
													<form method="POST" action="?/updateReagentDefinition" use:enhance={handleResult}>
														<input type="hidden" name="definitionId" value={reagent.id} />
														<input type="hidden" name="hasBreakdown" value={String(!reagent.hasBreakdown)} />
														<button type="submit" class="flex min-h-[28px] items-center gap-1.5 text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]">
															<span class="inline-block h-3 w-6 rounded-full {reagent.hasBreakdown ? 'bg-[var(--color-tron-cyan)]/60' : 'bg-[var(--color-tron-surface)]'} relative">
																<span class="absolute top-0.5 h-2 w-2 rounded-full bg-white transition-all {reagent.hasBreakdown ? 'left-3' : 'left-0.5'}"></span>
															</span>
															Cost breakdown
														</button>
													</form>
													{#if reagent.hasBreakdown}
														{@const scTotal = subComponentTotal(reagent.subComponents)}
														{#if scTotal}
															<span class="text-[10px] text-[var(--color-tron-text-secondary)]">Sub-total: <strong class="text-[var(--color-tron-cyan)]">${scTotal}</strong></span>
														{/if}
													{/if}
												</div>

												<!-- Sub-components table -->
												{#if reagent.hasBreakdown}
													<div class="mt-2 ml-14 space-y-1">
														{#each reagent.subComponents as sc (sc.id)}
															<form method="POST" action="?/updateSubComponent" use:enhance={handleResult} class="flex items-center gap-2">
																<input type="hidden" name="subComponentId" value={sc.id} />
																<input name="name" value={sc.name} placeholder="Name"
																	class="min-h-[30px] w-28 rounded border border-[var(--color-tron-border)]/50 bg-[var(--color-tron-surface)] px-2 py-0.5 text-xs text-[var(--color-tron-text)]" />
																<div class="flex items-center gap-0.5">
																	<span class="text-[10px] text-[var(--color-tron-text-secondary)]">$</span>
																	<input name="unitCost" type="text" value={sc.unitCost ?? ''} placeholder="Cost"
																		class="min-h-[30px] w-16 rounded border border-[var(--color-tron-border)]/50 bg-[var(--color-tron-surface)] px-1.5 py-0.5 text-right text-xs text-[var(--color-tron-text)]" />
																</div>
																<input name="volumeMicroliters" type="number" step="0.1" value={sc.volumeMicroliters ?? ''} placeholder="Vol"
																	class="min-h-[30px] w-16 rounded border border-[var(--color-tron-border)]/50 bg-[var(--color-tron-surface)] px-1.5 py-0.5 text-right text-xs text-[var(--color-tron-text)]" />
																<select name="unit" class="min-h-[30px] rounded border border-[var(--color-tron-border)]/50 bg-[var(--color-tron-surface)] px-1 py-0.5 text-[10px] text-[var(--color-tron-text)]">
																	<option value="µL" selected={sc.unit === 'µL'}>µL</option>
																	<option value="mL" selected={sc.unit === 'mL'}>mL</option>
																	<option value="mg" selected={sc.unit === 'mg'}>mg</option>
																</select>
																<select name="classification" class="min-h-[30px] rounded border border-[var(--color-tron-border)]/50 bg-[var(--color-tron-surface)] px-1 py-0.5 text-[10px] text-[var(--color-tron-text)]">
																	<option value="raw" selected={sc.classification === 'raw'}>raw</option>
																	<option value="processed" selected={sc.classification === 'processed'}>processed</option>
																</select>
																<button type="submit" class="min-h-[30px] text-[10px] text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]">Save</button>
															</form>
															<form method="POST" action="?/deleteSubComponent" use:enhance={handleResult} class="inline">
																<input type="hidden" name="subComponentId" value={sc.id} />
																<button type="submit" class="ml-1 min-h-[30px] text-[10px] text-red-400 hover:text-red-300">Delete</button>
															</form>
														{/each}
														<!-- Add sub-component -->
														<form method="POST" action="?/createSubComponent" use:enhance={handleResult} class="flex items-center gap-2 pt-1">
															<input type="hidden" name="reagentDefinitionId" value={reagent.id} />
															<input name="name" placeholder="Sub-component name" required
																class="min-h-[30px] w-28 rounded border border-dashed border-[var(--color-tron-border)]/50 bg-[var(--color-tron-bg)] px-2 py-0.5 text-xs text-[var(--color-tron-text)]" />
															<div class="flex items-center gap-0.5">
																<span class="text-[10px] text-[var(--color-tron-text-secondary)]">$</span>
																<input name="unitCost" type="text" placeholder="Cost"
																	class="min-h-[30px] w-16 rounded border border-dashed border-[var(--color-tron-border)]/50 bg-[var(--color-tron-bg)] px-1.5 py-0.5 text-right text-xs text-[var(--color-tron-text)]" />
															</div>
															<button type="submit" class="min-h-[30px] rounded border border-dashed border-[var(--color-tron-cyan)]/30 px-2 py-0.5 text-[10px] text-[var(--color-tron-cyan)]">+ Add</button>
														</form>
													</div>
												{/if}
											</div>
										{/each}
									</div>
								{/if}
							</td>
						</tr>
					{/if}
				{/each}
				{#if data.assayTypes.length === 0}
					<tr>
						<td colspan="8" class="px-4 py-8 text-center text-sm text-[var(--color-tron-text-secondary)]">
							No assay types configured. Create one to get started.
						</td>
					</tr>
				{/if}
			</tbody>
		</table>
	</div>

	<!-- Section A: Prefilled Cartridge BOM (synced from Box) -->
	<div class="space-y-3">
		<div class="flex items-center gap-3">
			<h3 class="text-base font-semibold text-[var(--color-tron-text)]">Prefilled Cartridge BOM</h3>
			{#if hasPrefilledCost}
				<span class="text-sm text-[var(--color-tron-text-secondary)]">
					Total: <strong class="text-[var(--color-tron-cyan)]">${prefilledTotal.toFixed(2)}</strong>
				</span>
			{/if}
			<form method="POST" action="?/syncCartridgeBom" use:enhance={() => {
				syncing = true;
				syncMsg = '';
				return async ({ result, update }) => {
					syncing = false;
					if (result.type === 'success') {
						const r = result.data?.syncResult as { created: number; updated: number; deleted: number } | undefined;
						syncMsg = r ? `Synced! ${r.created} added, ${r.updated} updated, ${r.deleted} removed` : 'Synced!';
					} else if (result.type === 'failure') {
						const errMsg = result.data?.error;
						syncMsg = errMsg ? `Error: ${errMsg}` : 'Sync error';
					} else if (result.type === 'error') {
						syncMsg = `Error: ${result.error?.message ?? 'Unknown server error'}`;
					}
					setTimeout(() => { syncMsg = ''; }, 8000);
					await update();
				};
			}}>
				<button type="submit" disabled={syncing}
					class="rounded border border-[var(--color-tron-cyan)]/30 px-2 py-1 text-xs text-[var(--color-tron-cyan)] transition-colors hover:bg-[var(--color-tron-cyan)]/10 disabled:opacity-50"
				>
					{syncing ? 'Syncing...' : 'Sync from Box'}
				</button>
			</form>
			{#if syncMsg}
				<span class="text-xs {syncMsg.startsWith('Error') ? 'text-red-400' : 'text-green-400'}">{syncMsg}</span>
			{/if}
		</div>

		<div class="overflow-x-auto rounded border border-[var(--color-tron-border)]">
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
						<th class="px-4 py-3 text-left font-medium text-[var(--color-tron-text-secondary)]">Part Number</th>
						<th class="px-4 py-3 text-left font-medium text-[var(--color-tron-text-secondary)]">Name</th>
						<th class="px-4 py-3 text-left font-medium text-[var(--color-tron-text-secondary)]">Category</th>
						<th class="px-4 py-3 text-right font-medium text-[var(--color-tron-text-secondary)]">Qty/Unit</th>
						<th class="px-4 py-3 text-right font-medium text-[var(--color-tron-text-secondary)]">Unit Cost</th>
						<th class="px-4 py-3 text-right font-medium text-[var(--color-tron-text-secondary)]">Line Total</th>
					</tr>
				</thead>
				<tbody>
					{#each data.bomItems as item (item.id)}
						<tr class="border-b border-[var(--color-tron-border)]/50">
							<td class="px-4 py-2 font-mono text-xs text-[var(--color-tron-cyan)]">{item.partNumber}</td>
							<td class="px-4 py-2 text-sm text-[var(--color-tron-text)]">{item.name}</td>
							<td class="px-4 py-2 text-xs text-[var(--color-tron-text-secondary)]">{item.category ?? '—'}</td>
							<td class="px-4 py-2 text-right text-sm text-[var(--color-tron-text)]">{item.quantityPerUnit}</td>
							<td class="px-4 py-2 text-right text-sm text-[var(--color-tron-text)]">
								{#if item.unitCost}
									${parseFloat(item.unitCost).toFixed(2)}
								{:else}
									<span class="text-[var(--color-tron-text-secondary)]">—</span>
								{/if}
							</td>
							<td class="px-4 py-2 text-right text-sm text-[var(--color-tron-text)]">
								{#if item.unitCost}
									${(parseFloat(item.unitCost) * item.quantityPerUnit).toFixed(2)}
								{:else}
									<span class="text-[var(--color-tron-text-secondary)]">—</span>
								{/if}
							</td>
						</tr>
					{/each}
					{#if data.bomItems.length === 0}
						<tr>
							<td colspan="6" class="px-4 py-8 text-center text-sm text-[var(--color-tron-text-secondary)]">
								No BOM items synced. Use Box Sync in BOM Settings to import parts.
							</td>
						</tr>
					{/if}
					{#if hasPrefilledCost}
						<tr class="bg-[var(--color-tron-surface)]/50">
							<td colspan="5" class="px-4 py-2 text-right text-xs font-medium text-[var(--color-tron-text-secondary)]">Prefilled Total</td>
							<td class="px-4 py-2 text-right text-sm font-semibold text-[var(--color-tron-cyan)]">${prefilledTotal.toFixed(2)}</td>
						</tr>
					{/if}
				</tbody>
			</table>
		</div>
	</div>

	<!-- Section B: SKU Filled Cartridge Cost Summary -->
	{#if data.assayTypes.length > 0}
		<div class="space-y-3">
			<h3 class="text-base font-semibold text-[var(--color-tron-text)]">SKU Filled Cartridge Cost Summary</h3>
			<div class="overflow-x-auto rounded border border-[var(--color-tron-border)]">
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
							<th class="px-4 py-3 text-left font-medium text-[var(--color-tron-text-secondary)]">SKU</th>
							<th class="px-4 py-3 text-right font-medium text-[var(--color-tron-text-secondary)]">Prefilled Parts</th>
							<th class="px-4 py-3 text-right font-medium text-[var(--color-tron-text-secondary)]">Reagent Cost</th>
							<th class="px-4 py-3 text-right font-medium text-[var(--color-tron-text-secondary)]">Total / Cartridge</th>
						</tr>
					</thead>
					<tbody>
						{#each data.assayTypes.filter((at) => at.isActive) as at (at.id)}
							{@const reagentCost = computedTotalCost(at.reagents)}
							{@const prefilledStr = hasPrefilledCost ? prefilledTotal.toFixed(2) : null}
							{@const totalCost = prefilledStr && reagentCost ? (parseFloat(prefilledStr) + parseFloat(reagentCost)).toFixed(2) : null}
							<tr class="border-b border-[var(--color-tron-border)]/50">
								<td class="px-4 py-3">
									<span class="font-medium text-[var(--color-tron-text)]">{at.name}</span>
									<span class="ml-2 font-mono text-xs text-[var(--color-tron-text-secondary)]">({at.skuCode})</span>
								</td>
								<td class="px-4 py-3 text-right text-[var(--color-tron-text)]">
									{#if prefilledStr}
										${prefilledStr}
									{:else}
										<span class="text-[var(--color-tron-text-secondary)]">—</span>
									{/if}
								</td>
								<td class="px-4 py-3 text-right text-[var(--color-tron-text)]">
									{#if reagentCost}
										${reagentCost}
									{:else}
										<span class="text-[var(--color-tron-text-secondary)]">—</span>
									{/if}
								</td>
								<td class="px-4 py-3 text-right font-semibold text-[var(--color-tron-cyan)]">
									{#if totalCost}
										${totalCost}
									{:else}
										<span class="font-normal text-[var(--color-tron-text-secondary)]">—</span>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{/if}
</div>
