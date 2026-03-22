<script lang="ts">
	import { enhance } from '$app/forms';

	interface Roll {
		rollId: string;
		barcode: string | null;
		initialLengthFt: number;
		remainingLengthFt: number;
		status: string;
		createdBy: string;
		createdAt: string;
		updatedAt: string;
	}

	interface CutRecord {
		id: string;
		rollId: string;
		quantityCut: number;
		lengthPerCutFt: number;
		totalLengthUsedFt: number;
		operatorId: string;
		notes: string | null;
		createdAt: string;
	}

	interface Props {
		data: { rolls: Roll[]; recentCuts: CutRecord[] };
		form: { success?: boolean; error?: string } | null;
	}

	let { data, form }: Props = $props();

	let showRegister = $state(false);
	let newBarcode = $state('');
	let cuttingRollId = $state<string | null>(null);
	let cutQuantity = $state(10);
	let cutNotes = $state('');
	// Optional: comma-separated cartridge IDs to link roll lot to CartridgeRecord.topSeal
	let cutCartridgeIds = $state('');

	const activeRolls = $derived(data.rolls.filter((r) => r.status === 'Active'));
	const otherRolls = $derived(data.rolls.filter((r) => r.status !== 'Active'));

	function usagePercent(roll: Roll): number {
		if (roll.initialLengthFt <= 0) return 100;
		return Math.round(((roll.initialLengthFt - roll.remainingLengthFt) / roll.initialLengthFt) * 100);
	}
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">Top Seal Cutting</h1>
		<button
			type="button"
			onclick={() => { showRegister = !showRegister; }}
			class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/20"
		>
			{showRegister ? 'Cancel' : '+ Register Roll'}
		</button>
	</div>

	{#if form?.success}
		<div class="rounded border border-green-500/30 bg-green-900/20 px-4 py-3 text-sm text-green-300">Action completed.</div>
	{/if}
	{#if form?.error}
		<div class="rounded border border-red-500/30 bg-red-900/20 px-4 py-3 text-sm text-red-300">{form.error}</div>
	{/if}

	{#if showRegister}
		<form method="POST" action="?/registerRoll" use:enhance={() => { return async ({ update }) => { showRegister = false; newBarcode = ''; await update(); }; }} class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5 space-y-4">
			<h3 class="text-sm font-semibold text-[var(--color-tron-cyan)]">Register New Roll</h3>
			<label class="block">
				<span class="tron-label">Roll Barcode (optional)</span>
				<input type="text" name="barcode" bind:value={newBarcode} class="tron-input" placeholder="Scan or type barcode..." />
			</label>
			<button type="submit" class="tron-btn-primary">Register</button>
		</form>
	{/if}

	<!-- Active Rolls -->
	<section>
		<h2 class="mb-3 text-lg font-medium text-[var(--color-tron-cyan)]">Active Rolls ({activeRolls.length})</h2>
		{#if activeRolls.length === 0}
			<p class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-6 text-center text-sm text-[var(--color-tron-text-secondary)]">No active rolls. Register one to begin cutting.</p>
		{:else}
			<div class="space-y-3">
				{#each activeRolls as roll (roll.rollId)}
					<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
						<div class="flex items-center justify-between">
							<div>
								<p class="font-mono text-sm font-semibold text-[var(--color-tron-cyan)]">{roll.rollId}</p>
								{#if roll.barcode}
									<p class="text-xs text-[var(--color-tron-text-secondary)]">Barcode: {roll.barcode}</p>
								{/if}
							</div>
							<span class="tron-badge tron-badge-success">Active</span>
						</div>

						<!-- Length bar -->
						<div class="mt-3">
							<div class="flex justify-between text-xs text-[var(--color-tron-text-secondary)]">
								<span>{roll.remainingLengthFt.toFixed(1)} ft remaining</span>
								<span>{usagePercent(roll)}% used</span>
							</div>
							<div class="tron-progress mt-1">
								<div class="tron-progress-bar" style="width: {100 - usagePercent(roll)}%"></div>
							</div>
						</div>

						<!-- Actions -->
						<div class="mt-3 flex gap-2">
							{#if cuttingRollId === roll.rollId}
								<form method="POST" action="?/recordCut" use:enhance={() => { return async ({ update }) => { cuttingRollId = null; cutQuantity = 10; cutNotes = ''; cutCartridgeIds = ''; await update(); }; }} class="flex flex-1 flex-col gap-2">
									<input type="hidden" name="rollId" value={roll.rollId} />
									<div class="flex flex-1 items-end gap-2">
										<label class="block">
											<span class="text-xs text-[var(--color-tron-text-secondary)]">Strips</span>
											<input type="number" name="quantity" bind:value={cutQuantity} min="1" max="100" class="tron-input text-sm" style="width:80px" />
										</label>
										<label class="block flex-1">
											<span class="text-xs text-[var(--color-tron-text-secondary)]">Notes</span>
											<input type="text" name="notes" bind:value={cutNotes} class="tron-input text-sm" placeholder="Optional" />
										</label>
									</div>
									<label class="block">
										<span class="text-xs text-[var(--color-tron-text-secondary)]">Cartridge IDs (comma-separated, links roll lot to CartridgeRecord)</span>
										<input type="text" name="cartridgeIds" bind:value={cutCartridgeIds} class="tron-input text-xs w-full" placeholder="e.g. abc123, def456 — leave blank if not applying yet" />
									</label>
									<div class="flex gap-2">
										<button type="submit" class="min-h-[44px] rounded border border-green-500/50 bg-green-900/20 px-3 py-2 text-xs text-green-300 hover:bg-green-900/30">Cut</button>
										<button type="button" onclick={() => { cuttingRollId = null; }} class="min-h-[44px] rounded border border-[var(--color-tron-border)] px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">Cancel</button>
									</div>
								</form>
							{:else}
								<button
									type="button"
									onclick={() => { cuttingRollId = roll.rollId; }}
									class="rounded border border-[var(--color-tron-cyan)]/50 px-3 py-1.5 text-xs text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10"
								>
									Record Cut
								</button>
								<form method="POST" action="?/retireRoll" use:enhance onsubmit={(e) => { if (!confirm('Retire this roll?')) e.preventDefault(); }}>
									<input type="hidden" name="rollId" value={roll.rollId} />
									<button type="submit" class="rounded border border-red-500/50 px-3 py-1.5 text-xs text-red-400 hover:bg-red-900/20">Retire</button>
								</form>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</section>

	<!-- Recent Cuts -->
	{#if data.recentCuts.length > 0}
		<section>
			<h2 class="mb-3 text-lg font-medium text-[var(--color-tron-cyan)]">Recent Cuts</h2>
			<div class="overflow-x-auto">
				<table class="tron-table w-full text-sm">
					<thead>
						<tr>
							<th>Roll</th>
							<th>Qty</th>
							<th>Length Used</th>
							<th>Notes</th>
							<th>Date</th>
						</tr>
					</thead>
					<tbody>
						{#each data.recentCuts as cut (cut.id)}
							<tr>
								<td class="font-mono text-[var(--color-tron-cyan)]">{cut.rollId}</td>
								<td>{cut.quantityCut} strips</td>
								<td>{cut.totalLengthUsedFt.toFixed(1)} ft</td>
								<td class="text-[var(--color-tron-text-secondary)]">{cut.notes ?? '-'}</td>
								<td class="text-[var(--color-tron-text-secondary)]">{new Date(cut.createdAt).toLocaleDateString()}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{/if}

	<!-- Retired/Depleted Rolls -->
	{#if otherRolls.length > 0}
		<section>
			<h2 class="mb-3 text-lg font-medium text-[var(--color-tron-text-secondary)]">Retired / Depleted Rolls</h2>
			<div class="space-y-2">
				{#each otherRolls as roll (roll.rollId)}
					<div class="flex items-center justify-between rounded border border-[var(--color-tron-border)]/50 bg-[var(--color-tron-surface)]/50 px-4 py-2 text-sm">
						<span class="font-mono text-[var(--color-tron-text-secondary)]">{roll.rollId}</span>
						<span class="text-xs text-[var(--color-tron-text-secondary)]">{roll.remainingLengthFt.toFixed(1)} ft remaining</span>
						<span class="tron-badge {roll.status === 'Depleted' ? 'tron-badge-error' : 'tron-badge-neutral'}">{roll.status}</span>
					</div>
				{/each}
			</div>
		</section>
	{/if}
</div>
