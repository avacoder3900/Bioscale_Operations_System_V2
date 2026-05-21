<script lang="ts">
	import { enhance } from '$app/forms';

	let { data } = $props();

	let fillTime = $state(data.settings.fillTimePerCartridgeMin);
	let coolingTime = $state(data.settings.minCoolingTimeMin);
	let expandedAssayId = $state<string | null>(null);
	let showAddAssay = $state(false);
	let showAddCode = $state(false);
	let editingReasonId = $state<string | null>(null);
	let editLabel = $state('');
	let editSortOrder = $state(0);
	let newCode = $state('');
	let newLabel = $state('');
	let newSortOrder = $state(0);
	let successMsg = $state('');

	function handleResult() {
		return async ({ result }: { result: { type: string } }) => {
			if (result.type === 'success') {
				successMsg = 'Saved';
				setTimeout(() => { successMsg = ''; }, 2000);
			}
		};
	}
</script>

<div class="space-y-6">
	<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Reagent Filling Settings</h2>

	{#if successMsg}
		<div class="rounded border border-green-500/50 bg-green-900/20 px-4 py-2 text-sm text-green-300">{successMsg}</div>
	{/if}

	<!-- Configuration -->
	<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
		<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Configuration</h3>
		<form method="POST" action="?/updateSettings" use:enhance={handleResult} class="space-y-3">
			<div class="grid grid-cols-2 gap-4">
				<div>
					<label for="fillTime" class="text-xs text-[var(--color-tron-text-secondary)]">Fill time per cartridge (min)</label>
					<input id="fillTime" name="fillTime" type="number" step="0.05" min="0.1" max="10" bind:value={fillTime}
						class="mt-1 min-h-[44px] w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)]" />
				</div>
				<div>
					<label for="coolingTime" class="text-xs text-[var(--color-tron-text-secondary)]">Min cooling time (min)</label>
					<input id="coolingTime" name="coolingTime" type="number" min="1" max="120" bind:value={coolingTime}
						class="mt-1 min-h-[44px] w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)]" />
				</div>
			</div>
			<button type="submit"
				class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)]"
			>
				Save Settings
			</button>
		</form>
	</div>

	<!-- Assay Types -->
	<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
		<div class="mb-3 flex items-center justify-between">
			<h3 class="text-sm font-semibold text-[var(--color-tron-text)]">Assay Types</h3>
			<button type="button" onclick={() => { showAddAssay = !showAddAssay; }}
				class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/30 px-3 py-1.5 text-xs text-[var(--color-tron-cyan)]"
			>
				{showAddAssay ? 'Cancel' : '+ Add'}
			</button>
		</div>

		{#if showAddAssay}
			<form method="POST" action="?/createAssayType" use:enhance={handleResult} class="mb-4 flex gap-2">
				<input name="name" placeholder="Name (e.g. Cortisol)" required
					class="min-h-[44px] flex-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)]" />
				<input name="skuCode" placeholder="SKU (e.g. CORT)" required
					class="min-h-[44px] w-28 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)]" />
				<button type="submit"
					class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)]"
				>
					Create
				</button>
			</form>
		{/if}

		<div class="space-y-2">
			{#each data.assayTypes as at (at.id)}
				<div class="rounded border border-[var(--color-tron-border)]/50 bg-[var(--color-tron-bg)] p-3">
					<div class="flex items-center justify-between">
						<div class="flex items-center gap-2">
							<span class="text-sm font-medium text-[var(--color-tron-text)]">{at.name}</span>
							<span class="rounded bg-[var(--color-tron-cyan)]/10 px-1.5 py-0.5 text-xs text-[var(--color-tron-cyan)]">{at.skuCode}</span>
							{#if !at.isActive}
								<span class="rounded bg-red-900/30 px-1.5 py-0.5 text-xs text-red-400">Inactive</span>
							{/if}
						</div>
						<div class="flex items-center gap-2">
							<form method="POST" action="?/updateAssayType" use:enhance={handleResult}>
								<input type="hidden" name="id" value={at.id} />
								<input type="hidden" name="isActive" value={String(!at.isActive)} />
								<button type="submit" class="text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]">
									{at.isActive ? 'Deactivate' : 'Activate'}
								</button>
							</form>
							<button type="button" onclick={() => { expandedAssayId = expandedAssayId === at.id ? null : at.id; }}
								class="text-xs text-[var(--color-tron-cyan)]"
							>
								{expandedAssayId === at.id ? 'Hide' : 'Reagents'}
							</button>
						</div>
					</div>

					{#if expandedAssayId === at.id}
						<div class="mt-3 space-y-2 border-t border-[var(--color-tron-border)]/30 pt-3">
							{#each at.reagents as reagent (reagent.id)}
								<div class="flex items-center gap-2">
									<form method="POST" action="?/updateReagentName" use:enhance={handleResult} class="flex flex-1 items-center gap-2">
										<input type="hidden" name="definitionId" value={reagent.id} />
										<span class="w-16 text-xs text-[var(--color-tron-text-secondary)]">Well {reagent.wellPosition}</span>
										<input name="newName" value={reagent.reagentName}
											class="min-h-[36px] flex-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-2 py-1 text-sm text-[var(--color-tron-text)]" />
										<button type="submit" class="min-h-[36px] rounded border border-[var(--color-tron-border)] px-2 py-1 text-xs text-[var(--color-tron-text-secondary)]">Save</button>
									</form>
									<form method="POST" action="?/toggleReagentActive" use:enhance={handleResult}>
										<input type="hidden" name="definitionId" value={reagent.id} />
										<input type="hidden" name="isActive" value={String(!reagent.isActive)} />
										<button type="submit" class="min-h-[36px] text-xs {reagent.isActive ? 'text-green-400' : 'text-red-400'}">
											{reagent.isActive ? 'On' : 'Off'}
										</button>
									</form>
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	</div>

	<!-- Rejection Reasons -->
	<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5">
		<h3 class="mb-4 text-lg font-medium text-[var(--color-tron-cyan)]">Reagent Rejection Reasons</h3>

		<div class="overflow-x-auto">
			<table class="tron-table w-full text-sm">
				<thead>
					<tr>
						<th class="px-3 py-2 text-left text-[var(--color-tron-text-secondary)]">Code</th>
						<th class="px-3 py-2 text-left text-[var(--color-tron-text-secondary)]">Label</th>
						<th class="px-3 py-2 text-left text-[var(--color-tron-text-secondary)]">Sort Order</th>
						<th class="px-3 py-2 text-right text-[var(--color-tron-text-secondary)]">Actions</th>
					</tr>
				</thead>
				<tbody>
					{#each data.rejectionReasons as reason (reason.id)}
						{#if editingReasonId === reason.id}
							<tr>
								<td colspan="4" class="px-3 py-2">
									<form method="POST" action="?/updateReason" use:enhance={() => { return async ({ update }) => { editingReasonId = null; await update(); }; }} class="flex items-end gap-3">
										<input type="hidden" name="codeId" value={reason.id} />
										<span class="font-mono text-[var(--color-tron-text)]">{reason.code}</span>
										<input type="text" name="label" bind:value={editLabel} class="tron-input flex-1 text-sm" />
										<input type="number" name="sortOrder" bind:value={editSortOrder} class="tron-input text-sm" style="width:80px" />
										<button type="submit" class="rounded border border-green-500/50 px-2 py-1 text-xs text-green-400 hover:bg-green-900/20">Save</button>
										<button type="button" onclick={() => { editingReasonId = null; }} class="rounded border border-[var(--color-tron-border)] px-2 py-1 text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]">Cancel</button>
									</form>
								</td>
							</tr>
						{:else}
							<tr>
								<td class="px-3 py-2 font-mono text-[var(--color-tron-text)]">{reason.code}</td>
								<td class="px-3 py-2 text-[var(--color-tron-text)]">{reason.label}</td>
								<td class="px-3 py-2 text-[var(--color-tron-text)]">{reason.sortOrder}</td>
								<td class="px-3 py-2 text-right">
									<div class="flex justify-end gap-2">
										<button type="button" onclick={() => { editingReasonId = reason.id; editLabel = reason.label; editSortOrder = reason.sortOrder; }} class="rounded border border-[var(--color-tron-border)] px-2 py-1 text-xs text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10">Edit</button>
										<form method="POST" action="?/deleteReason" use:enhance onsubmit={(e) => { if (!confirm('Delete this reason?')) e.preventDefault(); }}>
											<input type="hidden" name="codeId" value={reason.id} />
											<button type="submit" class="rounded border border-red-500/50 px-2 py-1 text-xs text-red-400 hover:bg-red-900/20">Delete</button>
										</form>
									</div>
								</td>
							</tr>
						{/if}
					{/each}
				</tbody>
			</table>
		</div>

		{#if showAddCode}
			<form method="POST" action="?/createReason" use:enhance={() => { return async ({ update }) => { showAddCode = false; newCode = ''; newLabel = ''; newSortOrder = 0; await update(); }; }} class="mt-4 flex items-end gap-3 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] p-3">
				<label class="block">
					<span class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]">Code</span>
					<input type="text" name="code" bind:value={newCode} class="tron-input text-sm" placeholder="RREJ-XX" required />
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
				<button type="button" onclick={() => { showAddCode = false; }} class="min-h-[44px] rounded border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)]">Cancel</button>
			</form>
		{:else}
			<button
				type="button"
				onclick={() => { showAddCode = true; }}
				class="mt-4 rounded border border-[var(--color-tron-cyan)]/50 px-4 py-2 text-sm text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10"
			>
				+ Add Reason
			</button>
		{/if}
	</section>
</div>
