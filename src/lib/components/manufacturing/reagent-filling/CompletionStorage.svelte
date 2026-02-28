<script lang="ts">
	interface CartridgeItem {
		id: string;
		cartridgeId: string;
		inspectionStatus: string;
		currentStatus: string;
		storageLocation: string | null;
	}

	interface RunSummary {
		runId: string;
		assayTypeName: string;
		cartridgeCount: number;
		acceptedCount: number;
		rejectedCount: number;
		qaqcCount: number;
	}

	interface Props {
		cartridges: CartridgeItem[];
		runSummary: RunSummary;
		onRecordStorage: (cartridgeIds: string[], location: string) => void;
		onComplete: () => void;
		readonly?: boolean;
	}

	let { cartridges, runSummary, onRecordStorage, onComplete, readonly: isReadonly = false }: Props = $props();

	let storageLocation = $state('');
	let storageInputEl: HTMLInputElement | undefined = $state();

	const needsStorage = $derived(
		cartridges.filter(
			(c) => c.inspectionStatus === 'Accepted' && c.currentStatus !== 'Stored'
		)
	);
	const stored = $derived(cartridges.filter((c) => c.currentStatus === 'Stored'));
	const allStored = $derived(needsStorage.length === 0 && stored.length > 0);

	function applyToAll() {
		const value = storageLocation.trim();
		if (!value || needsStorage.length === 0) return;
		onRecordStorage(needsStorage.map((c) => c.id), value);
		storageLocation = '';
	}
</script>

<div class="space-y-5">
	<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Completion &amp; Storage</h2>

	<p class="text-sm text-[var(--color-tron-text-secondary)]">
		Run <span class="font-mono text-[var(--color-tron-cyan)]">{runSummary.runId}</span>
		&bull; {runSummary.assayTypeName}
	</p>

	<!-- Run summary -->
	<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
		<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3 text-center">
			<div class="text-2xl font-bold text-[var(--color-tron-cyan)]">{runSummary.cartridgeCount}</div>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">Total</div>
		</div>
		<div class="rounded border border-green-500/30 bg-green-900/10 p-3 text-center">
			<div class="text-2xl font-bold text-green-400">{runSummary.acceptedCount}</div>
			<div class="text-xs text-green-300/70">Accepted</div>
		</div>
		<div class="rounded border border-red-500/30 bg-red-900/10 p-3 text-center">
			<div class="text-2xl font-bold text-red-400">{runSummary.rejectedCount}</div>
			<div class="text-xs text-red-300/70">Rejected</div>
		</div>
		<div class="rounded border border-amber-500/30 bg-amber-900/10 p-3 text-center">
			<div class="text-2xl font-bold text-amber-400">{runSummary.qaqcCount}</div>
			<div class="text-xs text-amber-300/70">QA/QC</div>
		</div>
	</div>

	<!-- Storage assignment -->
	{#if !allStored}
		<div class="space-y-2">
			<p class="text-sm text-[var(--color-tron-text-secondary)]">
				{needsStorage.length} accepted cartridge{needsStorage.length !== 1 ? 's' : ''} need storage assignment
			</p>
			<div class="flex gap-2">
				<input
					bind:this={storageInputEl}
					bind:value={storageLocation}
					onkeydown={(e) => { if (e.key === 'Enter') applyToAll(); }}
					placeholder="Storage location (scan or type)..."
					class="min-h-[44px] flex-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
				/>
				<button type="button" onclick={applyToAll} disabled={!storageLocation.trim() || needsStorage.length === 0}
					class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)] disabled:opacity-50"
				>
					Apply to All ({needsStorage.length})
				</button>
				<button
					type="button"
					onclick={() => { storageLocation = 'fridge-1'; applyToAll(); }}
					class="min-h-[44px] rounded border border-[var(--color-tron-border)] px-3 py-2 text-xs text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-orange)] hover:text-[var(--color-tron-orange)]"
				>
					Test
				</button>
			</div>
		</div>
	{/if}

	<!-- Stored list -->
	{#if stored.length > 0}
		<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
			<p class="mb-2 text-xs font-medium text-green-400">{stored.length} stored</p>
			<div class="grid grid-cols-3 gap-1 sm:grid-cols-4">
				{#each stored as c (c.id)}
					<div class="rounded bg-green-900/20 px-2 py-1 font-mono text-xs text-green-300">
						{c.cartridgeId.slice(-8)}
						{#if c.storageLocation}
							<span class="text-green-300/60"> @ {c.storageLocation}</span>
						{/if}
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<button type="button" disabled={!allStored} onclick={onComplete}
		class="min-h-[44px] w-full rounded-lg border px-6 py-3 text-sm font-semibold transition-all {allStored
			? 'border-emerald-500/50 bg-emerald-900/20 text-emerald-300 hover:bg-emerald-900/30'
			: 'cursor-not-allowed border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] text-[var(--color-tron-text-secondary)] opacity-50'}"
	>
		{allStored ? 'Complete Run' : `${needsStorage.length} awaiting storage`}
	</button>
</div>
