<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';

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

	interface FridgeOption {
		id: string;
		displayName: string;
		barcode: string;
	}

	interface Props {
		cartridges: CartridgeItem[];
		runSummary: RunSummary;
		fridges?: FridgeOption[];
		onRecordStorage: (cartridgeIds: string[], location: string) => void;
		onComplete: () => void;
		readonly?: boolean;
	}

	let { cartridges, runSummary, fridges = [], onRecordStorage, onComplete, readonly: isReadonly = false }: Props = $props();

	let assignments = $state(new SvelteMap<string, string>());
	let storageLocation = $state('');
	let selectedFridge = $state<FridgeOption | null>(null);

	const needsStorage = $derived(
		cartridges.filter(
			(c) => c.inspectionStatus === 'Accepted' && !c.storageLocation
		)
	);
	const stored = $derived(cartridges.filter((c) => c.inspectionStatus === 'Accepted' && !!c.storageLocation));
	const allAssigned = $derived(needsStorage.length > 0 && needsStorage.every((c) => assignments.has(c.id)));
	const allStored = $derived(needsStorage.length === 0 && stored.length > 0);

	function selectFridge(fridge: FridgeOption) {
		selectedFridge = fridge;
		storageLocation = fridge.barcode || fridge.displayName;
		// Clear stale assignments so user must re-apply with new fridge
		if (assignments.size > 0) {
			assignments = new SvelteMap();
		}
	}

	function applyToAll() {
		const value = storageLocation.trim();
		if (!value || needsStorage.length === 0) return;
		for (const c of needsStorage) {
			assignments.set(c.id, value);
		}
		assignments = new SvelteMap(assignments);
	}

	function assignSingle(cartridgeId: string) {
		const value = storageLocation.trim();
		if (!value) return;
		assignments.set(cartridgeId, value);
		assignments = new SvelteMap(assignments);
	}

	function unassign(cartridgeId: string) {
		assignments.delete(cartridgeId);
		assignments = new SvelteMap(assignments);
	}

	function clearAll() {
		assignments = new SvelteMap();
		selectedFridge = null;
		storageLocation = '';
	}

	function submitStorage() {
		const grouped = new Map<string, string[]>();
		for (const [cid, loc] of assignments) {
			const list = grouped.get(loc) ?? [];
			list.push(cid);
			grouped.set(loc, list);
		}
		for (const [loc, cids] of grouped) {
			onRecordStorage(cids, loc);
		}
		assignments = new SvelteMap();
		storageLocation = '';
		selectedFridge = null;
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
	{#if !allStored && !isReadonly}
		<div class="space-y-3">
			<p class="text-sm text-[var(--color-tron-text-secondary)]">
				{needsStorage.length} accepted cartridge{needsStorage.length !== 1 ? 's' : ''} need storage assignment
			</p>

			<!-- Fridge quick-select buttons -->
			{#if fridges.length > 0}
				<div class="space-y-2">
					<p class="text-xs font-medium text-[var(--color-tron-text-secondary)]">Select a fridge</p>
					<div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
						{#each fridges as fridge (fridge.id)}
							{@const isSelected = selectedFridge?.id === fridge.id}
							<button
								type="button"
								onclick={() => selectFridge(fridge)}
								disabled={needsStorage.length === 0}
								class="flex items-center gap-3 rounded-lg border p-3 text-left transition-all disabled:opacity-50
									{isSelected
										? 'border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/20 ring-1 ring-[var(--color-tron-cyan)]'
										: 'border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] hover:border-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10'}"
							>
								<div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg {isSelected ? 'bg-[var(--color-tron-cyan)]/30' : 'bg-[var(--color-tron-cyan)]/10'}">
									<svg class="h-6 w-6 text-[var(--color-tron-cyan)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
										<path stroke-linecap="round" stroke-linejoin="round" d="M6 2h12a1 1 0 011 1v18a1 1 0 01-1 1H6a1 1 0 01-1-1V3a1 1 0 011-1zm0 12h12M10 6h1" />
									</svg>
								</div>
								<div class="min-w-0 flex-1">
									<p class="text-sm font-semibold text-[var(--color-tron-text)] truncate">{fridge.displayName}</p>
									{#if fridge.barcode}
										<p class="font-mono text-[10px] text-[var(--color-tron-text-secondary)] truncate">{fridge.barcode}</p>
									{/if}
								</div>
								{#if isSelected}
									<svg class="h-5 w-5 shrink-0 text-[var(--color-tron-cyan)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
										<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
									</svg>
								{/if}
							</button>
						{/each}
					</div>
				</div>

				<div class="flex items-center gap-3">
					<div class="h-px flex-1 bg-[var(--color-tron-border)]"></div>
					<span class="text-xs text-[var(--color-tron-text-secondary)]">or scan / type</span>
					<div class="h-px flex-1 bg-[var(--color-tron-border)]"></div>
				</div>
			{/if}

			<!-- Manual scan/type input -->
			<div class="flex gap-2">
				<input
					bind:value={storageLocation}
					oninput={() => { selectedFridge = null; }}
					onkeydown={(e) => { if (e.key === 'Enter') applyToAll(); }}
					placeholder="Storage location (scan or type)..."
					class="min-h-[44px] flex-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
				/>
				<button type="button" onclick={applyToAll} disabled={!storageLocation.trim() || needsStorage.length === 0}
					class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)] disabled:opacity-50"
				>
					Apply to All ({needsStorage.length})
				</button>
			</div>

			<!-- Per-cartridge list -->
			<div class="space-y-1.5">
				<div class="flex items-center justify-between">
					<p class="text-xs font-medium text-[var(--color-tron-text-secondary)]">Cartridge Assignments</p>
					{#if assignments.size > 0}
						<button type="button" onclick={clearAll} class="text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-red)] transition-colors">
							Clear All
						</button>
					{/if}
				</div>
				<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] divide-y divide-[var(--color-tron-border)]">
					{#each needsStorage as c (c.id)}
						{@const assigned = assignments.get(c.id)}
						<div class="flex items-center gap-2 px-3 py-2">
							<span class="font-mono text-xs text-[var(--color-tron-text)] flex-shrink-0 w-24 truncate">{c.cartridgeId.slice(-8)}</span>
							{#if assigned}
								<span class="flex-1 text-xs text-green-400 font-mono truncate">→ {assigned}</span>
								<button type="button" onclick={() => unassign(c.id)}
									class="text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-red)] transition-colors shrink-0">
									✕
								</button>
							{:else}
								<span class="flex-1 text-xs text-[var(--color-tron-text-secondary)] italic">unassigned</span>
								<button type="button" onclick={() => assignSingle(c.id)}
									disabled={!storageLocation.trim()}
									class="text-xs text-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]/80 disabled:opacity-30 transition-colors shrink-0">
									Assign
								</button>
							{/if}
						</div>
					{/each}
				</div>
			</div>

			<!-- Submit storage -->
			{#if assignments.size > 0}
				<button type="button" onclick={submitStorage}
					class="min-h-[44px] w-full rounded-lg border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-6 py-3 text-sm font-semibold text-[var(--color-tron-cyan)] transition-all hover:bg-[var(--color-tron-cyan)]/30"
				>
					Record Storage ({assignments.size} cartridge{assignments.size !== 1 ? 's' : ''})
				</button>
			{/if}
		</div>
	{:else if !allStored}
		<p class="text-sm text-[var(--color-tron-text-secondary)]">
			{needsStorage.length} accepted cartridge{needsStorage.length !== 1 ? 's' : ''} awaiting storage assignment
		</p>
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

	{#if !isReadonly}
		<button type="button" disabled={!allStored} onclick={onComplete}
			class="min-h-[44px] w-full rounded-lg border px-6 py-3 text-sm font-semibold transition-all {allStored
				? 'border-emerald-500/50 bg-emerald-900/20 text-emerald-300 hover:bg-emerald-900/30'
				: 'cursor-not-allowed border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] text-[var(--color-tron-text-secondary)] opacity-50'}"
		>
			{allStored ? 'Complete Run' : `${needsStorage.length} awaiting storage`}
		</button>
	{/if}
</div>
