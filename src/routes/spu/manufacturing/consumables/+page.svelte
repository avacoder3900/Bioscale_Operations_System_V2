<script lang="ts">
	import { enhance } from '$app/forms';

	interface ConsumableItem {
		id: string;
		type: string;
		status: string;
		barcode: string | null;
		initialVolumeUl: number | null;
		remainingVolumeUl: number | null;
		totalCartridgesFilled: number;
		totalRunsUsed: number;
		initialLengthFt: number | null;
		remainingLengthFt: number | null;
		currentRobotId: string | null;
		lastUsed: string | null;
		assignedRunId: string | null;
		recentUsage: {
			usageType: string;
			runId: string | null;
			volumeChangedUl: number | null;
			operatorUsername: string | null;
			notes: string | null;
			createdAt: string;
		}[];
		createdAt: string;
	}

	interface Props {
		data: {
			consumables: {
				deck: ConsumableItem[];
				cooling_tray: ConsumableItem[];
				incubator_tube: ConsumableItem[];
				top_seal_roll: ConsumableItem[];
			};
		};
		form: { success?: boolean; error?: string; consumableId?: string } | null;
	}

	let { data, form }: Props = $props();

	let showCreate = $state(false);
	let selectedType = $state('deck');
	let expandedId = $state<string | null>(null);

	function typeLabel(type: string): string {
		switch (type) {
			case 'deck': return 'Deck';
			case 'cooling_tray': return 'Cooling Tray';
			case 'incubator_tube': return 'Incubator Tube';
			case 'top_seal_roll': return 'Top Seal Roll';
			default: return type;
		}
	}

	function statusColor(status: string): string {
		switch (status) {
			case 'active': return 'text-green-400 border-green-500/30 bg-green-900/20';
			case 'depleted': return 'text-red-400 border-red-500/30 bg-red-900/20';
			case 'retired': return 'text-[var(--color-tron-text-secondary)] border-[var(--color-tron-border)]';
			default: return 'text-[var(--color-tron-cyan)] border-[var(--color-tron-cyan)]/30';
		}
	}

	const allConsumables = $derived([
		...data.consumables.deck,
		...data.consumables.cooling_tray,
		...data.consumables.incubator_tube,
		...data.consumables.top_seal_roll
	]);

	const totalActive = $derived(allConsumables.filter(c => c.status === 'active').length);
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">Consumables</h1>
			<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
				{totalActive} active consumable{totalActive !== 1 ? 's' : ''} across {allConsumables.length} total
			</p>
		</div>
		<button
			type="button"
			onclick={() => { showCreate = !showCreate; }}
			class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/20"
		>
			{showCreate ? 'Cancel' : '+ Register Consumable'}
		</button>
	</div>

	{#if form?.success}
		<div class="rounded border border-green-500/30 bg-green-900/20 px-4 py-3 text-sm text-green-300">
			Consumable registered successfully.{form.consumableId ? ` ID: ${form.consumableId}` : ''}
		</div>
	{/if}
	{#if form?.error}
		<div class="rounded border border-red-500/30 bg-red-900/20 px-4 py-3 text-sm text-red-300">{form.error}</div>
	{/if}

	<!-- Create form -->
	{#if showCreate}
		<form
			method="POST"
			action="?/create"
			use:enhance={() => {
				return async ({ update }) => {
					showCreate = false;
					await update();
				};
			}}
			class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5 space-y-4"
		>
			<h3 class="text-sm font-semibold text-[var(--color-tron-cyan)]">Register New Consumable</h3>
			<div class="grid gap-4 sm:grid-cols-2">
				<label class="block">
					<span class="tron-label">Type</span>
					<select name="type" bind:value={selectedType} class="tron-input">
						<option value="deck">Deck</option>
						<option value="cooling_tray">Cooling Tray</option>
						<option value="incubator_tube">Incubator Tube</option>
						<option value="top_seal_roll">Top Seal Roll</option>
					</select>
				</label>
				<label class="block">
					<span class="tron-label">Barcode / Label (optional)</span>
					<input type="text" name="barcode" class="tron-input" placeholder="Scan or enter barcode..." />
				</label>
			</div>

			{#if selectedType === 'incubator_tube'}
				<label class="block">
					<span class="tron-label">Initial Volume (µL)</span>
					<input type="number" name="initialVolumeUl" min="0" step="1" class="tron-input" placeholder="e.g. 1500" />
				</label>
			{/if}

			{#if selectedType === 'top_seal_roll'}
				<label class="block">
					<span class="tron-label">Initial Length (ft)</span>
					<input type="number" name="initialLengthFt" min="0" step="0.1" class="tron-input" placeholder="e.g. 100" />
				</label>
			{/if}

			{#if selectedType === 'deck'}
				<label class="block">
					<span class="tron-label">Assigned Robot ID (optional)</span>
					<input type="text" name="currentRobotId" class="tron-input" placeholder="Robot ID..." />
				</label>
			{/if}

			<div class="flex gap-3">
				<button type="submit" class="tron-btn-primary">Register</button>
				<button
					type="button"
					onclick={() => { showCreate = false; }}
					class="rounded border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]"
				>
					Cancel
				</button>
			</div>
		</form>
	{/if}

	<!-- Summary cards by type -->
	<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
		{#each [['deck', 'Decks'], ['cooling_tray', 'Cooling Trays'], ['incubator_tube', 'Incubator Tubes'], ['top_seal_roll', 'Top Seal Rolls']] as [typeKey, label] (typeKey)}
			{@const items = data.consumables[typeKey as keyof typeof data.consumables]}
			{@const active = items.filter(c => c.status === 'active').length}
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
				<p class="text-xs font-medium text-[var(--color-tron-text-secondary)]">{label}</p>
				<p class="mt-1 text-2xl font-bold text-[var(--color-tron-text)]">{active}</p>
				<p class="text-xs text-[var(--color-tron-text-secondary)]">{items.length} total</p>
			</div>
		{/each}
	</div>

	<!-- Consumable tables by type -->
	{#each [['deck', 'Decks'], ['cooling_tray', 'Cooling Trays'], ['incubator_tube', 'Incubator Tubes'], ['top_seal_roll', 'Top Seal Rolls']] as [typeKey, label] (typeKey)}
		{@const items = data.consumables[typeKey as keyof typeof data.consumables]}
		{#if items.length > 0}
			<section>
				<h2 class="mb-3 text-lg font-medium text-[var(--color-tron-cyan)]">{label}</h2>
				<div class="overflow-x-auto">
					<table class="tron-table w-full text-sm">
						<thead>
							<tr>
								<th>ID</th>
								<th>Barcode</th>
								<th>Status</th>
								{#if typeKey === 'incubator_tube'}
									<th>Remaining (µL)</th>
									<th>Cartridges Filled</th>
									<th>Runs Used</th>
								{:else if typeKey === 'top_seal_roll'}
									<th>Remaining (ft)</th>
									<th>Initial (ft)</th>
								{:else if typeKey === 'deck'}
									<th>Robot</th>
									<th>Last Used</th>
								{/if}
								<th>Registered</th>
								<th>Actions</th>
							</tr>
						</thead>
						<tbody>
							{#each items as item (item.id)}
								<tr>
									<td class="font-mono text-[var(--color-tron-cyan)] text-xs">{item.id.slice(0, 8)}…</td>
									<td class="text-[var(--color-tron-text)]">{item.barcode ?? '—'}</td>
									<td>
										<span class="rounded border px-2 py-0.5 text-xs {statusColor(item.status)}">
											{item.status}
										</span>
									</td>
									{#if typeKey === 'incubator_tube'}
										<td class="font-mono">
											{item.remainingVolumeUl ?? '—'}
											{#if item.initialVolumeUl && item.remainingVolumeUl !== null}
												<span class="text-xs text-[var(--color-tron-text-secondary)]">
													/ {item.initialVolumeUl}
												</span>
											{/if}
										</td>
										<td>{item.totalCartridgesFilled}</td>
										<td>{item.totalRunsUsed}</td>
									{:else if typeKey === 'top_seal_roll'}
										<td class="font-mono">{item.remainingLengthFt ?? '—'}</td>
										<td class="text-[var(--color-tron-text-secondary)]">{item.initialLengthFt ?? '—'}</td>
									{:else if typeKey === 'deck'}
										<td class="text-[var(--color-tron-text-secondary)]">{item.currentRobotId ?? '—'}</td>
										<td class="text-[var(--color-tron-text-secondary)]">
											{item.lastUsed ? new Date(item.lastUsed).toLocaleDateString() : '—'}
										</td>
									{/if}
									<td class="whitespace-nowrap text-[var(--color-tron-text-secondary)] text-xs">
										{new Date(item.createdAt).toLocaleDateString()}
									</td>
									<td>
										<button
											type="button"
											onclick={() => { expandedId = expandedId === item.id ? null : item.id; }}
											class="text-xs text-[var(--color-tron-cyan)] underline hover:text-[var(--color-tron-cyan)]/80"
										>
											{expandedId === item.id ? 'Hide' : 'History'}
										</button>
									</td>
								</tr>
								{#if expandedId === item.id}
									<tr>
										<td colspan="99" class="bg-[var(--color-tron-surface)]/50 px-4 py-3">
											{#if item.recentUsage.length === 0}
												<p class="text-xs text-[var(--color-tron-text-secondary)]">No usage history.</p>
											{:else}
												<div class="space-y-1">
													<p class="text-xs font-semibold text-[var(--color-tron-text-secondary)] mb-2">Recent Usage (last 10):</p>
													{#each item.recentUsage as entry, i (i)}
														<div class="flex gap-3 text-xs text-[var(--color-tron-text-secondary)]">
															<span class="shrink-0 text-[var(--color-tron-cyan)]">{entry.usageType}</span>
															{#if entry.volumeChangedUl !== null}
																<span>−{entry.volumeChangedUl}µL</span>
															{/if}
															{#if entry.runId}
																<span class="font-mono">run:{entry.runId.slice(0, 8)}</span>
															{/if}
															{#if entry.notes}
																<span class="italic">{entry.notes}</span>
															{/if}
															<span class="ml-auto">{entry.operatorUsername ?? '?'} · {new Date(entry.createdAt).toLocaleString()}</span>
														</div>
													{/each}
												</div>
											{/if}
											<!-- Quick status change form -->
											<form
												method="POST"
												action="?/updateStatus"
												use:enhance={() => {
													return async ({ update }) => { await update(); };
												}}
												class="mt-3 flex items-center gap-2"
											>
												<input type="hidden" name="consumableId" value={item.id} />
												<select name="status" class="tron-input text-xs py-1">
													<option value="active">Active</option>
													<option value="depleted">Depleted</option>
													<option value="retired">Retired</option>
												</select>
												<button type="submit" class="rounded border border-[var(--color-tron-border)] px-3 py-1 text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]">
													Update Status
												</button>
											</form>
										</td>
									</tr>
								{/if}
							{/each}
						</tbody>
					</table>
				</div>
			</section>
		{/if}
	{/each}

	{#if allConsumables.length === 0}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-8 text-center">
			<p class="text-sm text-[var(--color-tron-text-secondary)]">No consumables registered yet.</p>
			<button
				type="button"
				onclick={() => { showCreate = true; }}
				class="mt-3 text-sm text-[var(--color-tron-cyan)] underline hover:text-[var(--color-tron-cyan)]/80"
			>
				Register your first consumable
			</button>
		</div>
	{/if}
</div>
