<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { generateTestBarcode } from '$lib/utils/test-barcode';

	interface CartridgeItem {
		id: string;
		cartridgeId: string;
		deckPosition: number;
	}

	interface SealBatch {
		batchId: string;
		topSealLotId: string;
		scannedCount: number;
		totalTarget: number;
		firstScanTime: Date | null;
		elapsedSeconds: number;
	}

	/** Mirrors ScanCheckResult in $lib/server/cartridge-scan-check (server types can't be imported here) */
	interface ScanCheckResult {
		barcode: string;
		position: number;
		ok: boolean;
		flags: { code: string; message: string }[];
	}

	interface Props {
		acceptedCartridges: CartridgeItem[];
		currentBatch: SealBatch | null;
		onCreateBatch: (topSealLotId: string) => void;
		onCompleteBatch: (batchId: string, cartridgeRecordIds: string[]) => void;
		/** Runs the batch checker over every scanned barcode at once */
		onCheck: (barcodes: string[], allowedIds: string[]) => Promise<ScanCheckResult[]>;
		onProceedToStorage: () => void;
		readonly?: boolean;
	}

	let {
		acceptedCartridges,
		currentBatch,
		onCreateBatch,
		onCompleteBatch,
		onCheck,
		onProceedToStorage,
		readonly: isReadonly = false
	}: Props = $props();

	let lotInput = $state('');
	let cartridgeInput = $state('');
	let scanError = $state('');
	let lotInputEl: HTMLInputElement | undefined = $state();
	let cartridgeInputEl: HTMLInputElement | undefined = $state();
	let filterText = $state('');

	// Track locally scanned IDs + barcodes for slot display
	let locallyScannedIds = new SvelteSet<string>();
	let scannedBarcodes = $state<string[]>([]);
	// Record IDs in scan order — sent to the server once, on batch completion
	let scannedRecordIds = $state<string[]>([]);
	// Track batch ID to reset local state when batch changes
	let lastBatchId = $state<string | null>(null);

	const MAX_PER_BATCH = 12;
	// Local scans are the only source of truth while a batch is open — the server
	// is not told about individual scans any more, so scannedCount stays 0 until
	// the batch is completed in one call.
	const totalScanned = $derived(scannedBarcodes.length);

	// Batch check state — the whole batch is checked once, after scanning
	let checking = $state(false);
	let checkResults = $state<ScanCheckResult[] | null>(null);
	let checkError = $state('');

	const flagged = $derived((checkResults ?? []).filter((r) => !r.ok));
	const checkPassed = $derived(checkResults !== null && flagged.length === 0);

	/** Any edit to the scan set invalidates a previous check */
	function invalidateCheck() {
		checkResults = null;
		checkError = '';
	}

	function flagsFor(index: number): { code: string; message: string }[] {
		return checkResults?.find((r) => r.position === index)?.flags ?? [];
	}

	async function runCheck() {
		if (checking || totalScanned === 0) return;
		checking = true;
		checkError = '';
		try {
			checkResults = await onCheck(
				[...scannedBarcodes],
				acceptedCartridges.map((c) => c.cartridgeId)
			);
		} catch (err) {
			checkResults = null;
			checkError = err instanceof Error ? err.message : 'Check failed';
		} finally {
			checking = false;
		}
	}

	function removeScan(index: number) {
		const barcode = scannedBarcodes[index];
		if (barcode !== undefined) locallyScannedIds.delete(barcode);
		scannedBarcodes = scannedBarcodes.filter((_, i) => i !== index);
		scannedRecordIds = scannedRecordIds.filter((_, i) => i !== index);
		invalidateCheck();
	}
	const unsealed = $derived(acceptedCartridges.filter((c) => !locallyScannedIds.has(c.cartridgeId)));
	const allSealed = $derived(unsealed.length === 0 && !currentBatch);
	const filteredUnsealed = $derived(
		filterText
			? unsealed.filter((c) => c.cartridgeId.toLowerCase().includes(filterText.toLowerCase()))
			: unsealed
	);

	// Clear local tracking when batch changes (server refreshed data)
	$effect(() => {
		const batchId = currentBatch?.batchId ?? null;
		if (batchId !== lastBatchId) {
			lastBatchId = batchId;
			locallyScannedIds.clear();
			scannedBarcodes = [];
			scannedRecordIds = [];
		}
	});

	function playBeep(success: boolean) {
		try {
			const ctx = new AudioContext();
			const osc = ctx.createOscillator();
			const gain = ctx.createGain();
			osc.connect(gain);
			gain.connect(ctx.destination);
			osc.frequency.value = success ? 880 : 220;
			osc.type = 'sine';
			gain.gain.value = 0.3;
			osc.start();
			osc.stop(ctx.currentTime + 0.15);
		} catch { /* audio not available */ }
	}

	function submitLot() {
		const value = lotInput.trim();
		if (!value) return;
		onCreateBatch(value);
		lotInput = '';
		playBeep(true);
		setTimeout(() => cartridgeInputEl?.focus(), 100);
	}

	function addCartridge(found: CartridgeItem) {
		if (!currentBatch) return;
		scanError = '';
		playBeep(true);
		invalidateCheck();
		locallyScannedIds.add(found.cartridgeId);
		scannedBarcodes = [...scannedBarcodes, found.cartridgeId];
		scannedRecordIds = [...scannedRecordIds, found.id];
	}

	/**
	 * Capture only — every scan lands, nothing is judged here. Duplicates,
	 * over-capacity scans, cartridges outside the accepted list and already-sealed
	 * cartridges are all caught by the batch check once scanning is finished.
	 */
	function scanCartridge() {
		const value = cartridgeInput.trim();
		if (!value || !currentBatch) return;

		cartridgeInput = '';
		// The record ID is only known for cartridges in the accepted list; an
		// unrecognised barcode is still captured so the checker can flag it.
		const found = acceptedCartridges.find((c) => c.cartridgeId === value);
		addCartridge({ id: found?.id ?? value, cartridgeId: value, deckPosition: found?.deckPosition ?? 0 });
		setTimeout(() => cartridgeInputEl?.focus(), 100);
	}

	function clickCartridge(item: CartridgeItem) {
		if (!currentBatch || totalScanned >= MAX_PER_BATCH) return;
		addCartridge(item);
	}

	function formatDuration(seconds: number): string {
		const m = Math.floor(seconds / 60);
		const s = seconds % 60;
		return `${m}:${String(s).padStart(2, '0')}`;
	}

	/** Shorten barcode for grid display */
	function shortBarcode(barcode: string): string {
		if (barcode.length <= 8) return barcode;
		// Show last 6 chars with ellipsis
		return '…' + barcode.slice(-6);
	}
</script>

<div class="space-y-5">
	<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Top Sealing</h2>
	<p class="text-sm text-[var(--color-tron-text-secondary)]">
		Seal accepted cartridges in batches of up to {MAX_PER_BATCH}. {unsealed.length} cartridge{unsealed.length !== 1 ? 's' : ''} remaining.
	</p>

	{#if allSealed}
		<!-- All cartridges sealed — proceed to storage -->
		<div class="space-y-4">
			<div class="rounded-lg border border-green-500/30 bg-green-900/10 p-4 text-center">
				<svg class="mx-auto h-8 w-8 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
				</svg>
				<p class="mt-2 text-base font-semibold text-green-400">All cartridges sealed</p>
				<p class="mt-1 text-sm text-green-300/70">Ready to proceed to storage.</p>
			</div>
			{#if !isReadonly}
				<button
					type="button"
					onclick={onProceedToStorage}
					class="min-h-[52px] w-full rounded-lg border border-green-500/50 bg-green-900/20 px-6 py-4 text-lg font-bold text-green-400 transition-all hover:bg-green-900/30"
				>
					Proceed to Storage
				</button>
			{/if}
		</div>
	{:else if !currentBatch}
		<!-- Start new batch: scan top seal lot -->
		<div class="space-y-2">
			<label for="seal-lot" class="text-sm text-[var(--color-tron-text-secondary)]">Scan top seal raw material lot to start a batch</label>
			<div class="flex gap-2">
				<input
					id="seal-lot"
					bind:this={lotInputEl}
					bind:value={lotInput}
					onkeydown={(e) => { if (e.key === 'Enter') submitLot(); }}
					placeholder="Top seal lot barcode..."
					class="min-h-[44px] flex-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
				/>
				<button type="button" onclick={submitLot}
					class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)]"
				>
					Start
				</button>
				<button
					type="button"
					onclick={() => { lotInput = generateTestBarcode('SEAL'); submitLot(); }}
					class="min-h-[44px] rounded border border-[var(--color-tron-border)] px-3 py-2 text-xs text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-orange)] hover:text-[var(--color-tron-orange)]"
				>
					Test
				</button>
			</div>
		</div>

		<!-- Show available cartridges even before batch starts -->
		{#if acceptedCartridges.length > 0}
			<div class="mt-4">
				<p class="mb-2 text-sm font-medium text-[var(--color-tron-text-secondary)]">
					{acceptedCartridges.length} cartridge{acceptedCartridges.length !== 1 ? 's' : ''} ready for sealing
				</p>
				<div class="max-h-40 overflow-y-auto rounded border border-[var(--color-tron-border)]/30 bg-[var(--color-tron-surface)]/30">
					{#each acceptedCartridges as cart (cart.id)}
						<div class="flex items-center justify-between border-b border-[var(--color-tron-border)]/20 px-3 py-2 text-sm last:border-b-0">
							<span class="font-mono text-[var(--color-tron-text)]">{cart.cartridgeId}</span>
							<span class="text-xs text-[var(--color-tron-text-secondary)]">Pos {cart.deckPosition}</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	{:else}
		<!-- Active batch -->
		<div class="rounded border border-cyan-500/30 bg-cyan-900/10 p-4">
			<div class="flex items-center justify-between text-sm">
				<div>
					<span class="text-[var(--color-tron-text-secondary)]">Batch:</span>
					<span class="font-mono text-[var(--color-tron-cyan)]">{currentBatch.batchId}</span>
				</div>
				<div class="text-[var(--color-tron-text-secondary)]">
					Lot: <span class="font-mono">{currentBatch.topSealLotId}</span>
				</div>
			</div>

			<div class="mt-3 flex items-center justify-between">
				<span class="text-sm text-[var(--color-tron-text)]">
					{totalScanned} / {currentBatch.totalTarget} scanned
				</span>
				{#if currentBatch.firstScanTime}
					<span class="text-xs text-[var(--color-tron-text-secondary)]">
						Elapsed: {formatDuration(currentBatch.elapsedSeconds)}
					</span>
				{/if}
			</div>

			<!-- 2x6 batch grid with barcodes -->
			<div class="mt-3 grid grid-cols-6 gap-1.5">
				{#each Array.from({ length: currentBatch.totalTarget }, (_, i) => i) as pos (pos)}
					{@const barcode = scannedBarcodes[pos]}
					{@const isFilled = pos < totalScanned || barcode}
					{@const isNext = pos === totalScanned && totalScanned < MAX_PER_BATCH}
					{@const slotFlags = flagsFor(pos)}
					{@const isFlagged = slotFlags.length > 0}
					<div
						title={isFlagged ? slotFlags.map((f) => f.message).join('; ') : undefined}
						class="flex flex-col items-center justify-center rounded border px-1 py-1.5 {isFlagged
							? 'border-red-500 bg-red-900/30'
							: isFilled
								? 'border-cyan-500/50 bg-cyan-900/30'
								: isNext
									? 'animate-pulse border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/20'
									: 'border-[var(--color-tron-border)]/50 bg-[var(--color-tron-surface)]/50'}"
					>
						<span class="text-[10px] text-[var(--color-tron-text-secondary)]">{pos + 1}</span>
						{#if barcode}
							<span class="mt-0.5 max-w-full truncate text-[10px] font-mono {isFlagged ? 'text-red-300' : 'text-cyan-300'}" title={barcode}>{shortBarcode(barcode)}</span>
						{:else if isFilled}
							<span class="mt-0.5 text-[10px] text-cyan-400">sealed</span>
						{/if}
					</div>
				{/each}
			</div>

			<!-- Scan cartridge input — always available; over-capacity scans are flagged by the check -->
			{#if totalScanned >= MAX_PER_BATCH}
				<p class="mt-3 text-xs text-amber-300">
					Batch full ({MAX_PER_BATCH}) — further scans will be flagged.
				</p>
			{/if}
			<div class="mt-3 flex gap-2">
				<input
					bind:this={cartridgeInputEl}
					bind:value={cartridgeInput}
					onkeydown={(e) => { if (e.key === 'Enter') scanCartridge(); }}
					placeholder="Scan cartridge barcode..."
					class="min-h-[44px] flex-1 rounded border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
				/>
				{#if unsealed.length > 0}
					<button
						type="button"
						onclick={() => { cartridgeInput = unsealed[0].cartridgeId; scanCartridge(); }}
						class="min-h-[44px] rounded border border-[var(--color-tron-border)] px-3 py-2 text-xs text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-orange)] hover:text-[var(--color-tron-orange)]"
					>
						Test
					</button>
				{/if}
			</div>
			{#if scanError}
				<p class="mt-1 text-xs text-red-400">{scanError}</p>
			{/if}

			<!-- Available cartridges — click to add to batch -->
			{#if unsealed.length > 0 && totalScanned < MAX_PER_BATCH}
				<div class="mt-4">
					<div class="flex items-center justify-between">
						<p class="text-sm font-medium text-[var(--color-tron-text)]">
							Available Cartridges ({unsealed.length})
						</p>
						{#if unsealed.length > 6}
							<input
								bind:value={filterText}
								placeholder="Filter..."
								class="w-32 rounded border border-[var(--color-tron-border)]/50 bg-[var(--color-tron-bg)] px-2 py-1 text-xs text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
							/>
						{/if}
					</div>
					<p class="mb-2 text-xs text-[var(--color-tron-text-secondary)]">Click a cartridge to add it to the batch</p>
					<div class="max-h-60 overflow-y-auto rounded border border-[var(--color-tron-border)]/30 bg-[var(--color-tron-surface)]/30">
						{#each filteredUnsealed as cart (cart.id)}
							<button
								type="button"
								onclick={() => clickCartridge(cart)}
								disabled={isReadonly}
								class="flex w-full items-center justify-between border-b border-[var(--color-tron-border)]/20 px-3 py-2.5 text-left text-sm transition-colors last:border-b-0 hover:bg-[var(--color-tron-cyan)]/10 disabled:opacity-50"
							>
								<span class="font-mono text-[var(--color-tron-text)]">{cart.cartridgeId}</span>
								<span class="rounded bg-[var(--color-tron-surface)] px-2 py-0.5 text-xs text-[var(--color-tron-text-secondary)]">
									Pos {cart.deckPosition}
								</span>
							</button>
						{/each}
						{#if filteredUnsealed.length === 0 && filterText}
							<p class="px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">No cartridges match "{filterText}"</p>
						{/if}
					</div>
				</div>
			{/if}

			<!-- Check results — every flagged barcode must be resolved before sealing -->
			{#if checkError}
				<p class="mt-4 rounded border border-red-500/40 bg-red-900/10 px-3 py-2 text-sm text-red-300">{checkError}</p>
			{/if}
			{#if flagged.length > 0}
				<div class="mt-4 rounded-lg border border-red-500/50 bg-red-900/10 p-4">
					<p class="text-sm font-semibold text-red-400">
						{flagged.length} cartridge{flagged.length !== 1 ? 's' : ''} flagged — remove or re-scan to continue
					</p>
					<ul class="mt-3 space-y-2">
						{#each flagged as f (f.position)}
							<li class="flex items-center justify-between gap-3 rounded border border-red-500/30 bg-[var(--color-tron-bg)]/40 px-3 py-2">
								<div class="min-w-0">
									<span class="font-mono text-xs text-[var(--color-tron-text)]">#{f.position + 1} {f.barcode}</span>
									<p class="text-xs text-red-300">{f.flags.map((x) => x.message).join(' · ')}</p>
								</div>
								<button
									type="button"
									onclick={() => removeScan(f.position)}
									class="shrink-0 rounded border border-red-500/50 px-3 py-1.5 text-xs text-red-300 transition-colors hover:bg-red-900/30"
								>
									Remove
								</button>
							</li>
						{/each}
					</ul>
				</div>
			{:else if checkPassed}
				<p class="mt-4 rounded border border-green-500/40 bg-green-900/10 px-3 py-2 text-sm text-green-400">
					All {totalScanned} barcode{totalScanned !== 1 ? 's' : ''} passed the check.
				</p>
			{/if}

			<!-- Check, then commit every scan in the batch in one request -->
			{#if totalScanned > 0 && !checkPassed}
				<button type="button" onclick={runCheck} disabled={checking}
					class="mt-4 min-h-[52px] w-full rounded-lg border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-6 py-3 text-base font-bold text-[var(--color-tron-cyan)] transition-all hover:bg-[var(--color-tron-cyan)]/30 disabled:opacity-50"
				>
					{checking ? 'Checking…' : `Check ${totalScanned} Barcode${totalScanned !== 1 ? 's' : ''}`}
				</button>
			{:else if checkPassed}
				<button type="button" onclick={() => onCompleteBatch(currentBatch!.batchId, scannedRecordIds)}
					class="mt-4 min-h-[52px] w-full rounded-lg border border-green-500/50 bg-green-900/20 px-6 py-3 text-base font-bold text-green-400 transition-all hover:bg-green-900/30"
				>
					Top Sealed ({totalScanned} cartridge{totalScanned !== 1 ? 's' : ''})
				</button>
			{/if}
		</div>
	{/if}
</div>
