<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';

	interface RemovalHistoryEntry {
		id: string;
		cartridgeIds: string[];
		cartridgeCount: number;
		reason: string;
		operatorUsername: string;
		removedAt: string;
	}
	interface Props {
		data: { removalHistory: RemovalHistoryEntry[] };
		form: { removeWaxStored?: { error?: string; success?: boolean; removalId?: string; count?: number } } | null;
	}
	let { data, form }: Props = $props();

	let scannedIds = $state<string[]>([]);
	let scanInput = $state('');
	let reason = $state('');
	let submitting = $state(false);
	let lastScanError = $state('');
	let scanInputEl: HTMLInputElement | undefined = $state();
	let expandedGroupId = $state<string | null>(null);

	function addScan() {
		const v = scanInput.trim();
		if (!v) return;
		if (scannedIds.includes(v)) {
			lastScanError = `Already scanned: ${v}`;
			scanInput = '';
			return;
		}
		scannedIds = [...scannedIds, v];
		scanInput = '';
		lastScanError = '';
	}

	function handleScanKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			addScan();
		}
	}

	function removeScan(id: string) {
		scannedIds = scannedIds.filter((s) => s !== id);
	}

	function clearAll() {
		scannedIds = [];
		reason = '';
		lastScanError = '';
	}

	function submitRemoval() {
		return async ({ update }: { update: () => Promise<void> }) => {
			submitting = true;
			await update();
			submitting = false;
			if (form?.removeWaxStored?.success) {
				scannedIds = [];
				reason = '';
				lastScanError = '';
				await invalidateAll();
				scanInputEl?.focus();
			}
		};
	}

	function toggleGroup(id: string) {
		expandedGroupId = expandedGroupId === id ? null : id;
	}

	function formatDate(iso: string): string {
		if (!iso) return '';
		const d = new Date(iso);
		return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
	}
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<h2 class="text-xl font-semibold text-[var(--color-tron-text)]">Cartridge Scrap</h2>
			<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
				Scan one or more wax-stored cartridges, provide a reason, and remove them as a group.
				Each removal is logged with operator, timestamp, and a scrap inventory transaction.
			</p>
		</div>
		{#if scannedIds.length > 0 || reason}
			<button
				type="button"
				onclick={clearAll}
				class="rounded border border-[var(--color-tron-border)] px-3 py-1 text-xs text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-red)]/50 hover:text-[var(--color-tron-red)]"
			>
				Clear
			</button>
		{/if}
	</div>

	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-6">
		<form
			method="POST"
			action="?/removeWaxStoredCartridges"
			use:enhance={submitRemoval}
			class="grid gap-4 lg:grid-cols-[1fr_1fr]"
		>
			<input type="hidden" name="cartridgeIds" value={JSON.stringify(scannedIds)} />
			<input type="hidden" name="reason" value={reason} />

			<!-- Left: scan input + staged scans -->
			<div class="flex flex-col gap-3">
				<div>
					<label for="manual-removal-scan" class="block text-xs font-medium text-[var(--color-tron-text-secondary)] uppercase tracking-wider">
						Scan Cartridge Barcode
					</label>
					<div class="mt-1 flex items-center gap-2">
						<input
							bind:this={scanInputEl}
							bind:value={scanInput}
							onkeydown={handleScanKeydown}
							id="manual-removal-scan"
							type="text"
							placeholder="Scan or type cartridge ID and press Enter"
							class="flex-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
							autocomplete="off"
							disabled={submitting}
						/>
						<button
							type="button"
							onclick={addScan}
							disabled={!scanInput.trim() || submitting}
							class="rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-3 py-2 text-xs font-medium text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/20 disabled:opacity-50"
						>
							Add
						</button>
					</div>
					{#if lastScanError}
						<p class="mt-1 text-xs text-amber-300">{lastScanError}</p>
					{/if}
				</div>

				<div>
					<div class="flex items-center justify-between">
						<span class="text-xs font-medium text-[var(--color-tron-text-secondary)] uppercase tracking-wider">
							Staged Cartridges
						</span>
						<span class="text-xs text-[var(--color-tron-text-secondary)]">
							{scannedIds.length} scanned
						</span>
					</div>
					<div class="mt-2 min-h-[72px] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] p-2">
						{#if scannedIds.length === 0}
							<p class="text-center text-xs text-[var(--color-tron-text-secondary)] py-4">
								No cartridges scanned yet.
							</p>
						{:else}
							<div class="flex flex-wrap gap-2">
								{#each scannedIds as cid (cid)}
									<span class="inline-flex items-center gap-1 rounded border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/10 px-2 py-1 font-mono text-xs text-[var(--color-tron-cyan)]">
										{cid}
										<button
											type="button"
											onclick={() => removeScan(cid)}
											disabled={submitting}
											class="text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-red)]"
											aria-label="Remove {cid}"
										>
											×
										</button>
									</span>
								{/each}
							</div>
						{/if}
					</div>
				</div>
			</div>

			<!-- Right: reason + submit -->
			<div class="flex flex-col gap-3">
				<div>
					<label for="manual-removal-reason" class="block text-xs font-medium text-[var(--color-tron-text-secondary)] uppercase tracking-wider">
						Reason
					</label>
					<textarea
						id="manual-removal-reason"
						bind:value={reason}
						rows="4"
						placeholder="Why are these cartridges being removed? (required)"
						class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
						disabled={submitting}
					></textarea>
				</div>

				{#if form?.removeWaxStored?.error}
					<div class="rounded border border-[var(--color-tron-red)]/50 bg-red-900/20 px-3 py-2 text-xs text-red-300">
						{form.removeWaxStored.error}
					</div>
				{:else if form?.removeWaxStored?.success}
					<div class="rounded border border-emerald-500/50 bg-emerald-900/20 px-3 py-2 text-xs text-emerald-300">
						Removed {form.removeWaxStored.count} cartridge{form.removeWaxStored.count === 1 ? '' : 's'}.
					</div>
				{/if}

				<button
					type="submit"
					disabled={submitting || scannedIds.length === 0 || !reason.trim()}
					class="rounded border border-[var(--color-tron-red)]/50 bg-red-900/20 px-4 py-2 text-sm font-medium text-red-300 hover:bg-red-900/30 disabled:opacity-40 disabled:cursor-not-allowed"
				>
					{submitting ? 'Removing…' : `Remove ${scannedIds.length} cartridge${scannedIds.length === 1 ? '' : 's'}`}
				</button>
			</div>
		</form>
	</div>

	<div>
		<h3 class="text-sm font-semibold text-[var(--color-tron-text)]">Recent Removals</h3>
		{#if data.removalHistory.length === 0}
			<p class="mt-2 text-xs text-[var(--color-tron-text-secondary)]">No manual removals yet.</p>
		{:else}
			<div class="mt-2 overflow-hidden rounded border border-[var(--color-tron-border)]">
				<table class="w-full text-left text-xs">
					<thead class="bg-[var(--color-tron-bg)] text-[var(--color-tron-text-secondary)] uppercase tracking-wider">
						<tr>
							<th class="px-3 py-2 font-medium">When</th>
							<th class="px-3 py-2 font-medium">Operator</th>
							<th class="px-3 py-2 font-medium text-right">Count</th>
							<th class="px-3 py-2 font-medium">Reason</th>
							<th class="px-3 py-2 font-medium"></th>
						</tr>
					</thead>
					<tbody class="divide-y divide-[var(--color-tron-border)]/50">
						{#each data.removalHistory as entry (entry.id)}
							<tr class="bg-[var(--color-tron-surface)] text-[var(--color-tron-text)]">
								<td class="px-3 py-2 font-mono">{formatDate(entry.removedAt)}</td>
								<td class="px-3 py-2">{entry.operatorUsername}</td>
								<td class="px-3 py-2 text-right tabular-nums">{entry.cartridgeCount}</td>
								<td class="px-3 py-2 text-[var(--color-tron-text-secondary)]">{entry.reason}</td>
								<td class="px-3 py-2">
									<button
										type="button"
										onclick={() => toggleGroup(entry.id)}
										class="text-[var(--color-tron-cyan)] hover:underline"
									>
										{expandedGroupId === entry.id ? 'Hide' : 'Cartridges'}
									</button>
								</td>
							</tr>
							{#if expandedGroupId === entry.id}
								<tr class="bg-[var(--color-tron-bg)]/40">
									<td colspan="5" class="px-3 py-2">
										<div class="flex flex-wrap gap-1">
											{#each entry.cartridgeIds as cid (cid)}
												<span class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-0.5 font-mono text-[11px] text-[var(--color-tron-text-secondary)]">
													{cid}
												</span>
											{/each}
										</div>
									</td>
								</tr>
							{/if}
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
</div>
