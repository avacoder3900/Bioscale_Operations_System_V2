<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';

	interface CartridgeItem {
		cartridgeId: string;
		qcStatus: string;
		currentInventory: string;
		storageLocation: string | null;
	}

	interface RunSummary {
		runId: string;
		cartridgeCount: number;
		acceptedCount: number;
		rejectedCount: number;
	}

	interface FridgeOption {
		id: string;
		displayName: string;
		barcode: string;
	}

	interface LockedCartridge {
		cartridgeId: string;
		status: string;
	}

	interface Props {
		cartridges: CartridgeItem[];
		runSummary: RunSummary;
		fridges?: FridgeOption[];
		onRecordStorage: (cartridgeIds: string[], location: string) => void;
		onComplete: () => void;
		onSaveNote?: (noteBody: string) => Promise<{ ok: boolean; error?: string; cartridgeCount?: number }>;
		existingNote?: string;
		readonly?: boolean;
		lockedCartridges?: LockedCartridge[];
	}

	let { cartridges, runSummary, fridges = [], onRecordStorage, onComplete, onSaveNote, existingNote = '', readonly: isReadonly = false, lockedCartridges = [] }: Props = $props();

	// Friendly status labels for the locked-carts panel. The lock statuses come
	// from LOCKED_STATUSES in src/lib/server/manufacturing/locked-cartridges.ts
	// — keep these labels in sync.
	const LOCKED_LABELS: Record<string, string> = {
		linked: 'linked to SPU run',
		underway: 'currently in SPU run',
		completed: 'already completed (SPU run finished)',
		voided: 'voided',
		scrapped: 'scrapped'
	};

	// Operator-entered run note — saved against the wax run AND every cartridge
	// in the run via the recordWaxRunNote action. Re-saving overwrites the
	// previous wax_run note. Save is independent of clicking Complete Run.
	let noteBody = $state(existingNote);
	let noteSaving = $state(false);
	let noteError = $state('');
	let noteSavedAt = $state<Date | null>(null);
	let noteSavedCount = $state(0);

	async function saveNote() {
		if (!onSaveNote || !noteBody.trim() || noteSaving) return;
		noteSaving = true;
		noteError = '';
		try {
			const result = await onSaveNote(noteBody.trim());
			if (!result.ok) {
				noteError = result.error ?? 'Failed to save note';
			} else {
				noteSavedAt = new Date();
				noteSavedCount = result.cartridgeCount ?? 0;
			}
		} catch (e) {
			noteError = e instanceof Error ? e.message : 'Failed to save note';
		} finally {
			noteSaving = false;
		}
	}

	// Per-cartridge storage assignments (local state before submit)
	let assignments = $state(new SvelteMap<string, string>());
	let storageLocation = $state('');
	let selectedFridge = $state<FridgeOption | null>(null);

	const needsStorage = $derived(
		cartridges.filter(
			(c) => c.qcStatus === 'Accepted' && c.currentInventory !== 'Stored'
		)
	);
	const stored = $derived(cartridges.filter((c) => c.currentInventory === 'Stored'));
	const allAssigned = $derived(needsStorage.length > 0 && needsStorage.every((c) => assignments.has(c.cartridgeId)));
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
			assignments.set(c.cartridgeId, value);
		}
		// Trigger reactivity
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
		// Group cartridges by location
		const grouped = new Map<string, string[]>();
		for (const [cid, loc] of assignments) {
			const list = grouped.get(loc) ?? [];
			list.push(cid);
			grouped.set(loc, list);
		}
		// Submit each group
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
	</p>

	<!-- Locked-cart panel: carts that were on this run but were pulled off
		 (relinked to an SPU, voided, scrapped, etc). The wax-flow guard
		 (protectLockedCarts) blocks any write to these, so we surface them
		 here as informational rather than letting them strand the Storage
		 stage. The Complete Run gate ignores them — operator can finish the
		 rest of the run normally. -->
	{#if lockedCartridges.length > 0}
		<div class="rounded-lg border border-amber-500/50 bg-amber-900/15 p-3">
			<p class="text-xs font-semibold text-amber-300">
				{lockedCartridges.length} cartridge{lockedCartridges.length === 1 ? '' : 's'} removed from this run — won't be stored here
			</p>
			<p class="mt-1 text-[11px] text-amber-300/80">
				These were re-linked to an SPU run or otherwise moved on. They'll be skipped automatically; Complete Run will still work for the remaining {cartridges.length}.
			</p>
			<div class="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">
				{#each lockedCartridges as lc (lc.cartridgeId)}
					<div class="rounded bg-amber-900/25 px-2 py-1 text-[11px]">
						<span class="font-mono text-amber-200">{lc.cartridgeId.slice(-8)}</span>
						<span class="ml-2 text-amber-300/70">{LOCKED_LABELS[lc.status] ?? lc.status}</span>
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Run summary -->
	<div class="grid grid-cols-3 gap-3">
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
					{#each needsStorage as c (c.cartridgeId)}
						{@const assigned = assignments.get(c.cartridgeId)}
						<div class="flex items-center gap-2 px-3 py-2">
							<span class="font-mono text-xs text-[var(--color-tron-text)] flex-shrink-0 w-24 truncate">{c.cartridgeId.slice(-8)}</span>
							{#if assigned}
								<span class="flex-1 text-xs text-green-400 font-mono truncate">→ {assigned}</span>
								<button type="button" onclick={() => unassign(c.cartridgeId)}
									class="text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-red)] transition-colors shrink-0">
									✕
								</button>
							{:else}
								<span class="flex-1 text-xs text-[var(--color-tron-text-secondary)] italic">unassigned</span>
								<button type="button" onclick={() => assignSingle(c.cartridgeId)}
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
				{#each stored as c (c.cartridgeId)}
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

	<!-- Run note — append-only metadata. Saves to the run AND every cartridge
		 in the run. Re-saving overwrites. Independent of clicking Complete Run. -->
	{#if onSaveNote && !isReadonly}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
			<div class="mb-2 flex items-center justify-between">
				<label for="wax-run-note" class="text-xs font-medium text-[var(--color-tron-text-secondary)]">
					Run Note (optional)
				</label>
				{#if runSummary.cartridgeCount > 0}
					<span class="text-[10px] text-[var(--color-tron-text-secondary)]/70">
						Applies to {runSummary.cartridgeCount} cartridge{runSummary.cartridgeCount === 1 ? '' : 's'}
					</span>
				{/if}
			</div>
			<textarea
				id="wax-run-note"
				bind:value={noteBody}
				rows="3"
				disabled={noteSaving}
				placeholder="Anything the operator wants attached to this run before completing..."
				class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] placeholder-[var(--color-tron-text-secondary)]/50 focus:border-[var(--color-tron-cyan)] focus:outline-none disabled:opacity-50"
			></textarea>
			<div class="mt-2 flex items-center justify-between gap-3">
				<div class="text-xs">
					{#if noteError}
						<span class="text-red-400">{noteError}</span>
					{:else if noteSaving}
						<span class="text-[var(--color-tron-cyan)] animate-pulse">Saving...</span>
					{:else if noteSavedAt}
						<span class="text-green-400">
							Saved to run + {noteSavedCount} cartridge{noteSavedCount === 1 ? '' : 's'} at {noteSavedAt.toLocaleTimeString()}
						</span>
					{:else if existingNote}
						<span class="text-[var(--color-tron-text-secondary)]/60">Existing note loaded — edit + Save to overwrite.</span>
					{:else}
						<span class="text-[var(--color-tron-text-secondary)]/60">Save anytime — re-saving overwrites the previous note.</span>
					{/if}
				</div>
				<button
					type="button"
					onclick={saveNote}
					disabled={!noteBody.trim() || noteSaving}
					class="min-h-[36px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-1.5 text-xs font-semibold text-[var(--color-tron-cyan)] transition-all hover:bg-[var(--color-tron-cyan)]/30 disabled:cursor-not-allowed disabled:opacity-40"
				>
					{noteSaving ? 'Saving...' : 'Save Note'}
				</button>
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
