<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	let expandedStage = $state<string | null>(null);
	let showManualEdit = $state(false);
	let editPartId = $state('');
	let editType = $state<'receive' | 'consume'>('receive');
	let editQty = $state(1);
	let editReason = $state('');
	let editAdminUser = $state('');
	let editAdminPass = $state('');

	function toggle(id: string) {
		expandedStage = expandedStage === id ? null : id;
	}

	function resetEditForm() {
		editPartId = '';
		editType = 'receive';
		editQty = 1;
		editReason = '';
		editAdminUser = '';
		editAdminPass = '';
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
	{#if form?.success}
		<div class="rounded border border-green-500/30 bg-green-900/20 px-4 py-3 text-sm text-green-300">Manual edit recorded successfully.</div>
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
					<button type="button" onclick={() => toggle(stage.id)}
						class="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-[var(--color-tron-cyan)]/5">
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

	<!-- ═══ SECTION 3: Cartridge Parts Stock (read-only) ═══ -->
	<div>
		<div class="mb-3 flex items-center justify-between">
			<h2 class="text-sm font-semibold uppercase tracking-wide text-[var(--color-tron-text-secondary)]">Cartridge Parts Stock</h2>
			<div class="flex items-center gap-2">
				<a href="/receiving" class="rounded border border-[var(--color-tron-cyan)]/40 px-3 py-1.5 text-xs text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10">ROG (Receiving) →</a>
				<a href="/parts" class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]">Manage Parts →</a>
			</div>
		</div>

		{#if data.parts.length === 0}
			<p class="text-sm text-[var(--color-tron-text-secondary)]">No cartridge parts defined. <a href="/parts" class="text-[var(--color-tron-cyan)] hover:underline">Add parts</a> with BOM type "cartridge".</p>
		{:else}
			<div class="overflow-x-auto rounded-lg border border-[var(--color-tron-border)]">
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
							<th class="px-4 py-3 text-left text-xs font-medium text-[var(--color-tron-text-secondary)]">Part</th>
							<th class="px-4 py-3 text-left text-xs font-medium text-[var(--color-tron-text-secondary)]">Part #</th>
							<th class="px-4 py-3 text-right text-xs font-medium text-[var(--color-tron-text-secondary)]">On Hand</th>
							<th class="px-4 py-3 text-left text-xs font-medium text-[var(--color-tron-text-secondary)]">Unit</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-[var(--color-tron-border)]/30">
						{#each data.parts as part (part.id)}
							<tr class="hover:bg-[var(--color-tron-cyan)]/5">
								<td class="px-4 py-2.5 text-[var(--color-tron-text)]">{part.name}</td>
								<td class="px-4 py-2.5 font-mono text-xs text-[var(--color-tron-text-secondary)]">{part.partNumber}</td>
								<td class="px-4 py-2.5 text-right font-mono font-bold {part.inventoryCount > 0 ? 'text-[var(--color-tron-cyan)]' : 'text-red-400'}">{part.inventoryCount}</td>
								<td class="px-4 py-2.5 text-xs text-[var(--color-tron-text-secondary)]">{part.unitOfMeasure}</td>
							</tr>
						{/each}
						{#if data.derived.individualBacks > 0}
							<tr class="border-t-2 border-[var(--color-tron-cyan)]/30">
								<td class="px-4 py-2.5 text-[var(--color-tron-cyan)]">Individual Backs (derived)</td>
								<td class="px-4 py-2.5 text-xs text-[var(--color-tron-text-secondary)]">—</td>
								<td class="px-4 py-2.5 text-right font-mono font-bold text-[var(--color-tron-cyan)]">{data.derived.individualBacks}</td>
								<td class="px-4 py-2.5 text-xs text-[var(--color-tron-text-secondary)]">sheets × {data.derived.cartridgesPerSheet}</td>
							</tr>
						{/if}
					</tbody>
				</table>
			</div>
		{/if}
	</div>

	<!-- ═══ SECTION 4: Manual Edits (admin protected) ═══ -->
	<div>
		<div class="mb-3 flex items-center justify-between">
			<h2 class="text-sm font-semibold uppercase tracking-wide text-[var(--color-tron-text-secondary)]">Manual Edits</h2>
			<button type="button" onclick={() => { showManualEdit = !showManualEdit; if (!showManualEdit) resetEditForm(); }}
				class="rounded border border-amber-500/40 px-3 py-1.5 text-xs text-amber-400 hover:bg-amber-900/20">
				{showManualEdit ? 'Cancel' : '⚠️ Manual Adjustment'}
			</button>
		</div>

		<p class="mb-3 text-xs text-[var(--color-tron-text-secondary)]">
			All inventory should come in through <a href="/receiving" class="text-[var(--color-tron-cyan)] hover:underline">ROG (Receiving)</a>.
			Manual edits require admin authorization and a documented reason.
		</p>

		{#if showManualEdit}
			<form
				method="POST"
				action="?/manualEdit"
				use:enhance={() => { return async ({ update, result }) => { if (result.type === 'success') { showManualEdit = false; resetEditForm(); } await update(); }; }}
				class="rounded-lg border border-amber-500/30 bg-amber-900/10 p-4 space-y-4"
			>
				<h3 class="text-sm font-semibold text-amber-300">⚠️ Manual Inventory Adjustment</h3>

				<div class="grid gap-3 sm:grid-cols-2">
					<!-- Part selection -->
					<div class="sm:col-span-2">
						<label class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]">Part *</label>
						<select name="partId" bind:value={editPartId} required class="tron-input w-full" style="min-height: 44px">
							<option value="">Select a part...</option>
							{#each data.parts as part (part.id)}
								<option value={part.id}>{part.name} ({part.partNumber}) — current: {part.inventoryCount}</option>
							{/each}
						</select>
					</div>

					<!-- Type -->
					<div>
						<label class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]">Adjustment Type *</label>
						<div class="flex gap-2">
							<button type="button" onclick={() => { editType = 'receive'; }}
								class="min-h-[44px] flex-1 rounded border text-sm font-medium {editType === 'receive' ? 'border-green-500/50 bg-green-900/30 text-green-400' : 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]'}">
								+ Add
							</button>
							<button type="button" onclick={() => { editType = 'consume'; }}
								class="min-h-[44px] flex-1 rounded border text-sm font-medium {editType === 'consume' ? 'border-red-500/50 bg-red-900/30 text-red-400' : 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]'}">
								− Remove
							</button>
						</div>
						<input type="hidden" name="transactionType" value={editType} />
					</div>

					<!-- Quantity -->
					<div>
						<label class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]">Quantity *</label>
						<input name="quantity" type="number" min="1" bind:value={editQty} required class="tron-input w-full" style="min-height: 44px" />
					</div>

					<!-- Reason -->
					<div class="sm:col-span-2">
						<label class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]">Reason / Explanation *</label>
						<textarea name="reason" bind:value={editReason} required rows="2"
							class="tron-input w-full px-3 py-2" placeholder="Why is this manual adjustment needed?"
						></textarea>
					</div>

					<!-- Admin credentials -->
					<div>
						<label class="mb-1 block text-xs text-amber-300">Admin Username *</label>
						<input name="adminUsername" type="text" bind:value={editAdminUser} required autocomplete="username"
							class="tron-input w-full" style="min-height: 44px; border-color: rgba(245,158,11,0.3)" placeholder="Admin username" />
					</div>
					<div>
						<label class="mb-1 block text-xs text-amber-300">Admin Password *</label>
						<input name="adminPassword" type="password" bind:value={editAdminPass} required autocomplete="current-password"
							class="tron-input w-full" style="min-height: 44px; border-color: rgba(245,158,11,0.3)" placeholder="Admin password" />
					</div>
				</div>

				<button type="submit"
					disabled={!editPartId || !editReason || !editAdminUser || !editAdminPass}
					class="min-h-[44px] rounded-lg border border-amber-500/50 bg-amber-900/30 px-6 py-3 text-sm font-semibold text-amber-300 transition-all hover:bg-amber-900/40 disabled:opacity-50"
				>
					Submit Manual Edit
				</button>
			</form>
		{/if}

		<!-- Recent manual edits log -->
		{#if data.recentEdits.length > 0}
			<div class="mt-4 overflow-x-auto rounded-lg border border-[var(--color-tron-border)]">
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
							<th class="px-3 py-2 text-left text-xs text-[var(--color-tron-text-secondary)]">Date</th>
							<th class="px-3 py-2 text-left text-xs text-[var(--color-tron-text-secondary)]">Part</th>
							<th class="px-3 py-2 text-left text-xs text-[var(--color-tron-text-secondary)]">Type</th>
							<th class="px-3 py-2 text-right text-xs text-[var(--color-tron-text-secondary)]">Qty</th>
							<th class="px-3 py-2 text-left text-xs text-[var(--color-tron-text-secondary)]">By</th>
							<th class="px-3 py-2 text-left text-xs text-[var(--color-tron-text-secondary)]">Reason</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-[var(--color-tron-border)]/30">
						{#each data.recentEdits as edit (edit.id)}
							<tr>
								<td class="whitespace-nowrap px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">{new Date(edit.timestamp).toLocaleDateString()}</td>
								<td class="px-3 py-2 text-[var(--color-tron-text)]">{edit.partName}</td>
								<td class="px-3 py-2">
									<span class="rounded px-1.5 py-0.5 text-[10px] font-medium {edit.type === 'receive' ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'}">
										{edit.type === 'receive' ? '+ Add' : '− Remove'}
									</span>
								</td>
								<td class="px-3 py-2 text-right font-mono {edit.type === 'receive' ? 'text-green-400' : 'text-red-400'}">{edit.type === 'receive' ? '+' : '−'}{edit.quantity}</td>
								<td class="px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">{edit.username}</td>
								<td class="max-w-[200px] truncate px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]" title={edit.reason}>{edit.reason}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
</div>
