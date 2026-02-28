<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	let editingSkuId = $state<string | null>(null);
	let editCost = $state('');

	function startEdit(skuId: string, currentCost: string | null) {
		editingSkuId = skuId;
		editCost = currentCost ?? '';
	}

	function cancelEdit() {
		editingSkuId = null;
		editCost = '';
	}

	function formatDuration(start: Date | string | null, end: Date | string | null): string {
		if (!start || !end) return '—';
		const ms = new Date(end).getTime() - new Date(start).getTime();
		const mins = Math.floor(ms / 60000);
		if (mins < 60) return `${mins}m`;
		return `${Math.floor(mins / 60)}h ${mins % 60}m`;
	}

	function formatDate(d: Date | string | null): string {
		if (!d) return '—';
		return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
	}

	function computedReagentCost(reagents: typeof data.assayTypesWithReagents[0]['reagents']): string | null {
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

	let prefilledTotal = $derived(
		data.bomItems.reduce((sum, item) => {
			const cost = item.unitCost ? parseFloat(item.unitCost) : 0;
			return sum + cost * item.quantityPerUnit;
		}, 0)
	);

	let hasPrefilledCost = $derived(data.bomItems.some((item) => item.unitCost));
</script>

<svelte:head>
	<title>Cartridge Dashboard | Bioscale</title>
</svelte:head>

<div class="space-y-8">
	<h1 class="tron-heading text-2xl font-bold" style="color: var(--color-tron-cyan)">
		Cartridge Dashboard
	</h1>

	<!-- Stage Count Cards -->
	<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
		<div class="tron-card p-6 text-center" style="border-color: var(--color-tron-text-secondary)">
			<p class="text-sm font-medium" style="color: var(--color-tron-text-secondary)">Raw</p>
			<p class="mt-2 text-3xl font-bold" style="color: var(--color-tron-text-secondary)">{data.stageCounts.raw}</p>
			<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">Backed, no wax</p>
		</div>
		<div class="tron-card p-6 text-center" style="border-color: var(--color-tron-blue)">
			<p class="text-sm font-medium" style="color: var(--color-tron-blue)">Backed</p>
			<p class="mt-2 text-3xl font-bold" style="color: var(--color-tron-blue)">{data.stageCounts.backed}</p>
			<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">Wax in process</p>
		</div>
		<div class="tron-card p-6 text-center" style="border-color: var(--color-tron-yellow)">
			<p class="text-sm font-medium" style="color: var(--color-tron-yellow)">Wax Filled</p>
			<p class="mt-2 text-3xl font-bold" style="color: var(--color-tron-yellow)">{data.stageCounts.waxFilled}</p>
			<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">Cooled, awaiting reagent</p>
		</div>
		<div class="tron-card p-6 text-center" style="border-color: var(--color-tron-green)">
			<p class="text-sm font-medium" style="color: var(--color-tron-green)">Ready to Ship</p>
			<p class="mt-2 text-3xl font-bold" style="color: var(--color-tron-green)">{data.stageCounts.readyToShip}</p>
			<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">Reagent complete</p>
		</div>
	</div>

	<!-- SKU BOM Cost -->
	<div class="tron-card p-6">
		<h2 class="tron-heading mb-4 text-lg font-semibold" style="color: var(--color-tron-cyan)">SKU BOM Cost</h2>

		{#if form?.error}
			<div class="mb-4 rounded border px-4 py-2 text-sm" style="border-color: var(--color-tron-error); color: var(--color-tron-error)">
				{form.error}
			</div>
		{/if}

		<div class="overflow-x-auto">
			<table class="tron-table w-full">
				<thead>
					<tr>
						<th>SKU Code</th>
						<th>Name</th>
						<th>BOM Cost Override</th>
						<th>Shelf Life (days)</th>
						<th>Cartridges</th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					{#each data.skuSummary as sku}
						<tr>
							<td class="font-mono" style="color: var(--color-tron-cyan)">{sku.skuCode}</td>
							<td>{sku.name}</td>
							<td>
								{#if editingSkuId === sku.assayTypeId}
									<form method="POST" action="?/updateBomCost" use:enhance={() => {
										return async ({ update }) => {
											await update();
											cancelEdit();
										};
									}}>
										<input type="hidden" name="assayTypeId" value={sku.assayTypeId} />
										<div class="flex items-center gap-2">
											<span style="color: var(--color-tron-text-secondary)">$</span>
											<input
												type="text"
												name="bomCostOverride"
												value={editCost}
												class="tron-input w-24 px-2 py-1 text-sm"
												autofocus
											/>
											<button type="submit" class="tron-button px-2 py-1 text-xs">Save</button>
											<button type="button" onclick={cancelEdit} class="px-2 py-1 text-xs" style="color: var(--color-tron-text-secondary)">Cancel</button>
										</div>
									</form>
								{:else}
									<span>
										{sku.bomCostOverride ? `$${parseFloat(sku.bomCostOverride).toFixed(2)}` : '—'}
									</span>
								{/if}
							</td>
							<td>{sku.shelfLifeDays ?? 90}</td>
							<td>{sku.cartridgeCount}</td>
							<td>
								{#if editingSkuId !== sku.assayTypeId}
									<button
										onclick={() => startEdit(sku.assayTypeId, sku.bomCostOverride)}
										class="text-xs underline"
										style="color: var(--color-tron-cyan)"
									>
										Edit
									</button>
								{/if}
							</td>
						</tr>
					{/each}
					{#if data.skuSummary.length === 0}
						<tr><td colspan="6" class="py-8 text-center" style="color: var(--color-tron-text-secondary)">No SKUs configured</td></tr>
					{/if}
				</tbody>
			</table>
		</div>
	</div>

	<!-- Prefilled Cartridge BOM -->
	<div class="tron-card p-6">
		<div class="mb-4 flex items-center gap-3">
			<h2 class="tron-heading text-lg font-semibold" style="color: var(--color-tron-cyan)">Prefilled Cartridge BOM</h2>
			{#if hasPrefilledCost}
				<span class="text-sm" style="color: var(--color-tron-text-secondary)">
					Total: <strong style="color: var(--color-tron-cyan)">${prefilledTotal.toFixed(2)}</strong>
				</span>
			{/if}
		</div>
		<div class="overflow-x-auto">
			<table class="tron-table w-full">
				<thead>
					<tr>
						<th>Part Number</th>
						<th>Name</th>
						<th>Category</th>
						<th class="text-right">Qty/Unit</th>
						<th class="text-right">Unit Cost</th>
						<th class="text-right">Line Total</th>
					</tr>
				</thead>
				<tbody>
					{#each data.bomItems as item (item.id)}
						<tr>
							<td class="font-mono text-sm" style="color: var(--color-tron-cyan)">{item.partNumber}</td>
							<td class="text-sm">{item.name}</td>
							<td class="text-sm" style="color: var(--color-tron-text-secondary)">{item.category ?? '—'}</td>
							<td class="text-right text-sm">{item.quantityPerUnit}</td>
							<td class="text-right text-sm">
								{#if item.unitCost}
									${parseFloat(item.unitCost).toFixed(2)}
								{:else}
									<span style="color: var(--color-tron-text-secondary)">—</span>
								{/if}
							</td>
							<td class="text-right text-sm">
								{#if item.unitCost}
									${(parseFloat(item.unitCost) * item.quantityPerUnit).toFixed(2)}
								{:else}
									<span style="color: var(--color-tron-text-secondary)">—</span>
								{/if}
							</td>
						</tr>
					{/each}
					{#if data.bomItems.length === 0}
						<tr><td colspan="6" class="py-8 text-center" style="color: var(--color-tron-text-secondary)">No BOM items configured. Add parts in SKU Management.</td></tr>
					{/if}
					{#if hasPrefilledCost}
						<tr style="background: var(--color-tron-bg-tertiary)">
							<td colspan="5" class="text-right text-xs font-medium" style="color: var(--color-tron-text-secondary)">Prefilled Total</td>
							<td class="text-right text-sm font-semibold" style="color: var(--color-tron-cyan)">${prefilledTotal.toFixed(2)}</td>
						</tr>
					{/if}
				</tbody>
			</table>
		</div>
	</div>

	<!-- SKU Filled Cartridge Cost Summary -->
	{#if data.assayTypesWithReagents.some((at) => at.isActive)}
		<div class="tron-card p-6">
			<h2 class="tron-heading mb-4 text-lg font-semibold" style="color: var(--color-tron-cyan)">SKU Filled Cartridge Cost Summary</h2>
			<div class="overflow-x-auto">
				<table class="tron-table w-full">
					<thead>
						<tr>
							<th>SKU</th>
							<th class="text-right">Prefilled Parts</th>
							<th class="text-right">Reagent Cost</th>
							<th class="text-right">Total / Cartridge</th>
						</tr>
					</thead>
					<tbody>
						{#each data.assayTypesWithReagents.filter((at) => at.isActive) as at (at.id)}
							{@const reagentCost = computedReagentCost(at.reagents)}
							{@const prefilledStr = hasPrefilledCost ? prefilledTotal.toFixed(2) : null}
							{@const totalCost = prefilledStr && reagentCost ? (parseFloat(prefilledStr) + parseFloat(reagentCost)).toFixed(2) : null}
							<tr>
								<td>
									<span class="font-medium">{at.name}</span>
									<span class="ml-2 font-mono text-xs" style="color: var(--color-tron-text-secondary)">({at.skuCode})</span>
								</td>
								<td class="text-right text-sm">
									{#if prefilledStr}
										${prefilledStr}
									{:else}
										<span style="color: var(--color-tron-text-secondary)">—</span>
									{/if}
								</td>
								<td class="text-right text-sm">
									{#if reagentCost}
										${reagentCost}
									{:else}
										<span style="color: var(--color-tron-text-secondary)">—</span>
									{/if}
								</td>
								<td class="text-right text-sm font-semibold" style="color: var(--color-tron-cyan)">
									{#if totalCost}
										${totalCost}
									{:else}
										<span class="font-normal" style="color: var(--color-tron-text-secondary)">—</span>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{/if}

	<!-- Recent Fills -->
	<div class="tron-card p-6">
		<h2 class="tron-heading mb-4 text-lg font-semibold" style="color: var(--color-tron-cyan)">Recent Fills</h2>
		<div class="overflow-x-auto">
			<table class="tron-table w-full">
				<thead>
					<tr>
						<th>Type</th>
						<th>Run ID</th>
						<th>Start Time</th>
						<th>Duration</th>
						<th>Cartridges</th>
						<th>Operator</th>
						<th>Status</th>
					</tr>
				</thead>
				<tbody>
					{#each data.recentFills as fill}
						<tr
							class="cursor-pointer transition-colors hover:bg-[var(--color-tron-bg-tertiary)]"
							onclick={() => {
								const base = fill.type === 'wax' ? '/spu/manufacturing/wax-filling' : '/spu/manufacturing/reagent-filling';
								window.location.href = base;
							}}
						>
							<td>
								<span
									class="tron-badge px-2 py-0.5 text-xs font-medium"
									style="background: {fill.type === 'wax' ? 'var(--color-tron-yellow)' : 'var(--color-tron-blue)'}; color: var(--color-tron-bg-primary)"
								>
									{fill.type === 'wax' ? 'Wax' : 'Reagent'}
								</span>
							</td>
							<td class="font-mono text-sm" style="color: var(--color-tron-cyan)">{fill.runId}</td>
							<td class="text-sm">{formatDate(fill.startTime)}</td>
							<td class="text-sm">{formatDuration(fill.startTime, fill.endTime)}</td>
							<td class="text-sm">{fill.cartridgeCount}</td>
							<td class="text-sm">{fill.operatorName}</td>
							<td class="text-sm">
								<span class="tron-badge px-2 py-0.5 text-xs">{fill.status}</span>
							</td>
						</tr>
					{/each}
					{#if data.recentFills.length === 0}
						<tr><td colspan="7" class="py-8 text-center" style="color: var(--color-tron-text-secondary)">No recent fills</td></tr>
					{/if}
				</tbody>
			</table>
		</div>
	</div>

	<!-- Fill History Stats -->
	<div class="tron-card p-6">
		<h2 class="tron-heading mb-4 text-lg font-semibold" style="color: var(--color-tron-cyan)">Fill History</h2>
		<div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
			<div class="rounded-lg border p-3 text-center" style="border-color: var(--color-tron-yellow)">
				<p class="text-xs" style="color: var(--color-tron-text-secondary)">Wax Runs</p>
				<p class="text-2xl font-bold" style="color: var(--color-tron-yellow)">{data.fillStats.totalWaxRuns}</p>
			</div>
			<div class="rounded-lg border p-3 text-center" style="border-color: var(--color-tron-blue)">
				<p class="text-xs" style="color: var(--color-tron-text-secondary)">Reagent Runs</p>
				<p class="text-2xl font-bold" style="color: var(--color-tron-blue)">{data.fillStats.totalReagentRuns}</p>
			</div>
			<div class="rounded-lg border p-3 text-center" style="border-color: var(--color-tron-cyan)">
				<p class="text-xs" style="color: var(--color-tron-text-secondary)">Cartridges Filled</p>
				<p class="text-2xl font-bold" style="color: var(--color-tron-cyan)">{data.fillStats.totalCartridgesFilled}</p>
			</div>
			<div class="rounded-lg border p-3 text-center" style="border-color: var(--color-tron-green)">
				<p class="text-xs" style="color: var(--color-tron-text-secondary)">Success Rate</p>
				<p class="text-2xl font-bold" style="color: var(--color-tron-green)">{(data.fillStats.overallSuccessRate * 100).toFixed(0)}%</p>
			</div>
			<div class="rounded-lg border p-3 text-center" style="border-color: var(--color-tron-text-secondary)">
				<p class="text-xs" style="color: var(--color-tron-text-secondary)">Tubes Used</p>
				<p class="text-2xl font-bold" style="color: var(--color-tron-text)">{data.fillStats.tubesUsed}</p>
			</div>
		</div>
	</div>

	<!-- Daily Throughput (Past 7 Days) -->
	{#if data.dailyThroughput.length > 0}
		{@const maxTotal = Math.max(...data.dailyThroughput.map((d) => d.totalCartridges), 1)}
		<div class="tron-card p-6">
			<h2 class="tron-heading mb-4 text-lg font-semibold" style="color: var(--color-tron-cyan)">Daily Throughput (Past 7 Days)</h2>
			<div class="flex items-end gap-2" style="height: 120px">
				{#each data.dailyThroughput as day (day.date)}
					{@const pctWax = (day.waxCartridges / maxTotal) * 100}
					{@const pctReagent = (day.reagentCartridges / maxTotal) * 100}
					<div class="flex flex-1 flex-col items-center gap-1">
						<div class="flex w-full flex-col justify-end" style="height: 100px">
							{#if day.reagentCartridges > 0}
								<div class="w-full rounded-t" style="height: {pctReagent}%; background: var(--color-tron-blue); min-height: 2px"></div>
							{/if}
							{#if day.waxCartridges > 0}
								<div class="w-full {day.reagentCartridges === 0 ? 'rounded-t' : ''}" style="height: {pctWax}%; background: var(--color-tron-yellow); min-height: 2px"></div>
							{/if}
						</div>
						<span class="text-[10px]" style="color: var(--color-tron-text-secondary)">{day.date.slice(5)}</span>
						<span class="text-[10px] font-bold" style="color: var(--color-tron-text)">{day.totalCartridges}</span>
					</div>
				{/each}
			</div>
			<div class="mt-3 flex gap-4 text-xs" style="color: var(--color-tron-text-secondary)">
				<span class="flex items-center gap-1"><span class="inline-block h-2.5 w-2.5 rounded" style="background: var(--color-tron-yellow)"></span> Wax</span>
				<span class="flex items-center gap-1"><span class="inline-block h-2.5 w-2.5 rounded" style="background: var(--color-tron-blue)"></span> Reagent</span>
			</div>
		</div>
	{/if}

	<!-- Fill History Runs -->
	{#if data.fillHistoryRuns.length > 0}
		<div class="tron-card p-6">
			<h2 class="tron-heading mb-4 text-lg font-semibold" style="color: var(--color-tron-cyan)">Recent Runs (Fill History)</h2>
			<div class="overflow-x-auto">
				<table class="tron-table w-full">
					<thead>
						<tr>
							<th>Run ID</th>
							<th>Process</th>
							<th>Robot</th>
							<th>Status</th>
							<th>Cartridges</th>
							<th>Start Time</th>
							<th>Duration</th>
							<th>Operator</th>
						</tr>
					</thead>
					<tbody>
						{#each data.fillHistoryRuns as run (run.runId)}
							<tr>
								<td class="font-mono text-sm" style="color: var(--color-tron-cyan)">{run.runId}</td>
								<td>
									<span
										class="tron-badge px-2 py-0.5 text-xs font-medium"
										style="background: {run.processType === 'wax' ? 'var(--color-tron-yellow)' : 'var(--color-tron-blue)'}; color: var(--color-tron-bg-primary)"
									>
										{run.processType === 'wax' ? 'Wax' : 'Reagent'}
									</span>
								</td>
								<td class="font-mono text-sm">{run.robotId}</td>
								<td><span class="tron-badge px-2 py-0.5 text-xs">{run.status}</span></td>
								<td class="text-sm">{run.cartridgeCount}</td>
								<td class="text-sm">{formatDate(run.startTime)}</td>
								<td class="text-sm">{formatDuration(run.startTime, run.endTime)}</td>
								<td class="text-sm">{run.operatorId}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{/if}

	<!-- Expiring Soon -->
	{#if data.expiringCartridges.length > 0}
		<div class="tron-card p-6">
			<h2 class="tron-heading mb-4 text-lg font-semibold" style="color: var(--color-tron-yellow)">
				Expiring Soon ({data.expiringCartridges.length})
			</h2>
			<div class="overflow-x-auto">
				<table class="tron-table w-full">
					<thead>
						<tr>
							<th>Cartridge ID</th>
							<th>Assay Type</th>
							<th>SKU</th>
							<th>Fill Date</th>
							<th>Expires</th>
							<th>Days Remaining</th>
							<th>Status</th>
						</tr>
					</thead>
					<tbody>
						{#each data.expiringCartridges as cart}
							<tr>
								<td class="font-mono text-sm" style="color: var(--color-tron-cyan)">{cart.cartridgeId}</td>
								<td class="text-sm">{cart.assayTypeName}</td>
								<td class="font-mono text-sm">{cart.skuCode}</td>
								<td class="text-sm">{formatDate(cart.reagentFillDate)}</td>
								<td class="text-sm">{formatDate(cart.expirationDate)}</td>
								<td>
									<span
										class="tron-badge px-2 py-0.5 text-xs font-bold"
										style="color: {cart.daysRemaining <= 7 ? 'var(--color-tron-error)' : cart.daysRemaining <= 14 ? 'var(--color-tron-yellow)' : 'var(--color-tron-text)'}"
									>
										{cart.daysRemaining}d
									</span>
								</td>
								<td class="text-sm">{cart.currentStatus}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{/if}
</div>
