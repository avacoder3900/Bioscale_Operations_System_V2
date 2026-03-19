<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	let expandedStage = $state<string | null>(null);
	let showAddMaterial = $state(false);
	let txMaterialId = $state<string | null>(null);
	let txType = $state<'receive' | 'consume'>('receive');
	let txQty = $state(1);
	let txNotes = $state('');

	function toggle(id: string) {
		expandedStage = expandedStage === id ? null : id;
	}
</script>

<div class="space-y-6">
	<div>
		<h1 class="text-2xl font-bold text-[var(--color-tron-cyan)]">Cartridge Line Inventory</h1>
		<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">Material flow and stock levels across the manufacturing pipeline</p>
	</div>

	{#if form?.error}
		<div class="rounded border border-red-500/30 bg-red-900/20 px-4 py-3 text-sm text-red-300">{form.error}</div>
	{/if}

	<!-- ═══ SECTION 1: Pipeline Summary ═══ -->
	<div class="grid grid-cols-3 gap-3 sm:grid-cols-6">
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3 text-center">
			<div class="text-xl font-bold text-[var(--color-tron-text)]">{data.totals.backed}</div>
			<div class="text-[10px] text-[var(--color-tron-text-secondary)]">Backed</div>
		</div>
		<div class="rounded-lg border border-amber-500/30 bg-amber-900/10 p-3 text-center">
			<div class="text-xl font-bold text-amber-400">{data.totals.waxStored}</div>
			<div class="text-[10px] text-amber-300/70">Wax Stored</div>
		</div>
		<div class="rounded-lg border border-purple-500/30 bg-purple-900/10 p-3 text-center">
			<div class="text-xl font-bold text-purple-400">{data.totals.reagentStored}</div>
			<div class="text-[10px] text-purple-300/70">Reagent Stored</div>
		</div>
		<div class="rounded-lg border border-green-500/30 bg-green-900/10 p-3 text-center">
			<div class="text-xl font-bold text-green-400">{data.totals.sealed}</div>
			<div class="text-[10px] text-green-300/70">Sealed</div>
		</div>
		<div class="rounded-lg border border-red-500/30 bg-red-900/10 p-3 text-center">
			<div class="text-xl font-bold text-red-400">{data.totals.voided}</div>
			<div class="text-[10px] text-red-300/70">Voided</div>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/10 p-3 text-center">
			<div class="text-xl font-bold text-[var(--color-tron-cyan)]">{data.totals.totalInSystem}</div>
			<div class="text-[10px] text-[var(--color-tron-cyan)]/70">Total</div>
		</div>
	</div>

	<!-- ═══ SECTION 2: Pipeline Stages ═══ -->
	<div>
		<h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--color-tron-text-secondary)]">Production Pipeline</h2>
		<div class="space-y-1.5">
			{#each data.stages as stage, i (stage.id)}
				{@const isExpanded = expandedStage === stage.id}
				<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] overflow-hidden">
					<button
						type="button"
						onclick={() => toggle(stage.id)}
						class="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-[var(--color-tron-cyan)]/5"
					>
						<div class="flex items-center gap-3">
							<span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--color-tron-border)] text-xs font-bold text-[var(--color-tron-cyan)]">{i + 1}</span>
							<span class="text-sm font-medium text-[var(--color-tron-text)]">{stage.name}</span>
							{#if stage.activeRuns > 0}
								<span class="rounded bg-green-900/30 px-1.5 py-0.5 text-[10px] text-green-400">{stage.activeRuns} active</span>
							{/if}
						</div>
						<div class="flex items-center gap-2 text-xs">
							{#each stage.inputs.filter((inp) => inp.count !== null) as inp}
								<span class="rounded bg-red-900/20 px-1.5 py-0.5 text-red-300">{inp.icon} {inp.count}</span>
							{/each}
							{#if stage.inputs.some((inp) => inp.count !== null) && stage.outputs.some((out) => out.count !== null)}
								<span class="text-[var(--color-tron-text-secondary)]">→</span>
							{/if}
							{#each stage.outputs.filter((out) => out.count !== null) as out}
								<span class="rounded bg-green-900/20 px-1.5 py-0.5 text-green-300">{out.icon} {out.count}</span>
							{/each}
							<svg class="ml-1 h-4 w-4 text-[var(--color-tron-text-secondary)] transition-transform {isExpanded ? 'rotate-180' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
								<path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
							</svg>
						</div>
					</button>

					{#if isExpanded}
						<div class="border-t border-[var(--color-tron-border)] p-4">
							<div class="grid gap-4 sm:grid-cols-2">
								<div>
									<h4 class="mb-2 text-xs font-semibold uppercase text-red-400">Inputs Consumed</h4>
									<div class="space-y-1.5">
										{#each stage.inputs as inp}
											<div class="flex items-center justify-between rounded border border-red-500/20 bg-red-900/10 px-3 py-2">
												<span class="text-sm text-[var(--color-tron-text)]">{inp.icon} {inp.name}</span>
												<span class="font-mono text-sm font-bold {inp.count !== null ? 'text-red-300' : 'text-[var(--color-tron-text-secondary)]'}">{inp.count ?? '—'} <span class="text-[10px] font-normal">{inp.unit}</span></span>
											</div>
										{/each}
									</div>
								</div>
								<div>
									<h4 class="mb-2 text-xs font-semibold uppercase text-green-400">Outputs Produced</h4>
									<div class="space-y-1.5">
										{#each stage.outputs as out}
											<div class="flex items-center justify-between rounded border border-green-500/20 bg-green-900/10 px-3 py-2">
												<span class="text-sm text-[var(--color-tron-text)]">{out.icon} {out.name}</span>
												<span class="font-mono text-sm font-bold {out.count !== null ? 'text-green-300' : 'text-[var(--color-tron-text-secondary)]'}">{out.count ?? '—'} <span class="text-[10px] font-normal">{out.unit}</span></span>
											</div>
										{/each}
									</div>
								</div>
							</div>
							<div class="mt-3 flex justify-end">
								<a href={stage.href} class="rounded border border-[var(--color-tron-cyan)]/40 px-3 py-1.5 text-xs text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10">Go to {stage.name} →</a>
							</div>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	</div>

	<!-- ═══ SECTION 3: Material Stock Levels ═══ -->
	<div>
		<div class="mb-3 flex items-center justify-between">
			<h2 class="text-sm font-semibold uppercase tracking-wide text-[var(--color-tron-text-secondary)]">Material Stock</h2>
			<button type="button" onclick={() => { showAddMaterial = !showAddMaterial; }}
				class="rounded border border-[var(--color-tron-cyan)]/40 px-3 py-1.5 text-xs text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10">
				{showAddMaterial ? 'Cancel' : '+ Add Material'}
			</button>
		</div>

		{#if showAddMaterial}
			<form method="POST" action="?/addMaterial" use:enhance={() => { return async ({ update }) => { showAddMaterial = false; await update(); }; }}
				class="mb-4 rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-surface)] p-4 space-y-3">
				<div class="grid gap-3 sm:grid-cols-3">
					<div>
						<label class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]">Name *</label>
						<input name="name" type="text" class="tron-input w-full" style="min-height: 44px" required placeholder="e.g., Thermoseal Sheets" />
					</div>
					<div>
						<label class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]">Unit</label>
						<input name="unit" type="text" class="tron-input w-full" style="min-height: 44px" placeholder="pcs, sheets, rolls, mL" />
					</div>
					<div class="flex items-end">
						<button type="submit" class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)]">Add</button>
					</div>
				</div>
			</form>
		{/if}

		{#if data.materials.length === 0}
			<p class="text-sm text-[var(--color-tron-text-secondary)]">No materials tracked yet. Add one above.</p>
		{:else}
			<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				{#each data.materials as mat (mat.materialId)}
					<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
						<div class="flex items-center justify-between">
							<div>
								<p class="text-sm font-medium text-[var(--color-tron-text)]">{mat.name}</p>
								{#if mat.partNumber}
									<p class="text-[10px] font-mono text-[var(--color-tron-text-secondary)]">{mat.partNumber}</p>
								{/if}
							</div>
							<div class="text-right">
								<p class="text-2xl font-bold text-[var(--color-tron-cyan)]">{mat.currentQuantity}</p>
								<p class="text-[10px] text-[var(--color-tron-text-secondary)]">{mat.unit}</p>
							</div>
						</div>

						<!-- Quick transaction buttons -->
						{#if txMaterialId === mat.materialId}
							<form method="POST" action="?/recordTransaction"
								use:enhance={() => { return async ({ update }) => { txMaterialId = null; txQty = 1; txNotes = ''; await update(); }; }}
								class="mt-3 space-y-2 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] p-3">
								<input type="hidden" name="materialId" value={mat.materialId} />
								<input type="hidden" name="transactionType" value={txType} />
								<div class="flex gap-2">
									<button type="button" onclick={() => { txType = 'receive'; }}
										class="flex-1 rounded px-2 py-1.5 text-xs font-medium {txType === 'receive' ? 'bg-green-900/30 text-green-400 border border-green-500/30' : 'border border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]'}">
										+ Receive
									</button>
									<button type="button" onclick={() => { txType = 'consume'; }}
										class="flex-1 rounded px-2 py-1.5 text-xs font-medium {txType === 'consume' ? 'bg-red-900/30 text-red-400 border border-red-500/30' : 'border border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]'}">
										− Consume
									</button>
								</div>
								<div class="flex gap-2">
									<input name="quantity" type="number" min="1" bind:value={txQty} class="tron-input w-20" style="min-height: 36px" />
									<input name="notes" type="text" bind:value={txNotes} placeholder="Notes (optional)" class="tron-input flex-1" style="min-height: 36px" />
								</div>
								<div class="flex gap-2">
									<button type="submit" class="min-h-[36px] rounded px-3 py-1.5 text-xs font-medium {txType === 'receive' ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'}">
										{txType === 'receive' ? `+ ${txQty}` : `− ${txQty}`}
									</button>
									<button type="button" onclick={() => { txMaterialId = null; }} class="min-h-[36px] rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)]">Cancel</button>
								</div>
							</form>
						{:else}
							<div class="mt-3 flex gap-2">
								<button type="button" onclick={() => { txMaterialId = mat.materialId; txType = 'receive'; txQty = 1; }}
									class="min-h-[36px] flex-1 rounded border border-green-500/30 px-2 py-1.5 text-xs text-green-400 hover:bg-green-900/20">+ Receive</button>
								<button type="button" onclick={() => { txMaterialId = mat.materialId; txType = 'consume'; txQty = 1; }}
									class="min-h-[36px] flex-1 rounded border border-red-500/30 px-2 py-1.5 text-xs text-red-400 hover:bg-red-900/20">− Consume</button>
							</div>
						{/if}

						<p class="mt-2 text-[10px] text-[var(--color-tron-text-secondary)]">Updated: {new Date(mat.updatedAt).toLocaleDateString()}</p>
					</div>
				{/each}

				<!-- Derived card -->
				{#if data.derived.individualBacks > 0}
					<div class="rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/5 p-4">
						<p class="text-sm font-medium text-[var(--color-tron-cyan)]">Individual Backs (derived)</p>
						<p class="mt-1 text-2xl font-bold text-[var(--color-tron-cyan)]">{data.derived.individualBacks}</p>
						<p class="text-[10px] text-[var(--color-tron-cyan)]/70">sheets × {data.derived.cartridgesPerSheet} per sheet</p>
					</div>
				{/if}
			</div>
		{/if}
	</div>
</div>
