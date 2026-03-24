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

	interface Props {
		acceptedCartridges: CartridgeItem[];
		currentBatch: SealBatch | null;
		onCreateBatch: (topSealLotId: string) => void;
		onScanCartridge: (batchId: string, cartridgeRecordId: string) => void;
		onCompleteBatch: (batchId: string) => void;
		onProceedToStorage: () => void;
		onRejectCartridge?: (cartridgeId: string) => void;
		readonly?: boolean;
	}

	let {
		acceptedCartridges,
		currentBatch,
		onCreateBatch,
		onScanCartridge,
		onCompleteBatch,
		onProceedToStorage,
		onRejectCartridge,
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
	// Track batch ID to reset local state when batch changes
	let lastBatchId = $state<string | null>(null);

	const MAX_PER_BATCH = 12;
	const unsealed = $derived(acceptedCartridges.filter((c) => !locallyScannedIds.has(c.cartridgeId)));
	const allSealed = $derived(acceptedCartridges.length === 0 || (unsealed.length === 0 && !currentBatch));
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
		locallyScannedIds.add(found.cartridgeId);
		scannedBarcodes = [...scannedBarcodes, found.cartridgeId];
		onScanCartridge(currentBatch.batchId, found.id);
	}

	function scanCartridge() {
		const value = cartridgeInput.trim();
		if (!value || !currentBatch) return;

		const found = unsealed.find((c) => c.cartridgeId === value);
		if (!found) {
			scanError = 'Cartridge not found in accepted list';
			playBeep(false);
			cartridgeInput = '';
			return;
		}

		cartridgeInput = '';
		addCartridge(found);
		setTimeout(() => cartridgeInputEl?.focus(), 100);
	}

	function clickCartridge(item: CartridgeItem) {
		if (!currentBatch || Math.max(currentBatch.scannedCount, scannedBarcodes.length) >= MAX_PER_BATCH) return;
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
							<div class="flex items-center gap-2">
								<span class="text-xs text-[var(--color-tron-text-secondary)]">Pos {cart.deckPosition}</span>
								{#if onRejectCartridge}
									<button
										type="button"
										onclick={() => onRejectCartridge?.(cart.id)}
										class="min-h-[32px] rounded border border-red-500/40 px-2 py-1 text-xs text-red-400 transition-colors hover:bg-red-900/20 hover:text-red-300"
									>
										Reject
									</button>
								{/if}
							</div>
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
					{currentBatch.scannedCount} / {currentBatch.totalTarget} scanned
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
					{@const isFilled = pos < currentBatch.scannedCount || barcode}
					{@const totalScanned = Math.max(currentBatch.scannedCount, scannedBarcodes.length)}
					{@const isNext = pos === totalScanned && totalScanned < MAX_PER_BATCH}
					<div
						class="flex flex-col items-center justify-center rounded border px-1 py-1.5 {isFilled
							? 'border-cyan-500/50 bg-cyan-900/30'
							: isNext
								? 'animate-pulse border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/20'
								: 'border-[var(--color-tron-border)]/50 bg-[var(--color-tron-surface)]/50'}"
					>
						<span class="text-[10px] text-[var(--color-tron-text-secondary)]">{pos + 1}</span>
						{#if barcode}
							<span class="mt-0.5 max-w-full truncate text-[10px] font-mono text-cyan-300" title={barcode}>{shortBarcode(barcode)}</span>
						{:else if isFilled}
							<span class="mt-0.5 text-[10px] text-cyan-400">sealed</span>
						{/if}
					</div>
				{/each}
			</div>

			<!-- Scan cartridge input -->
			{#if currentBatch.scannedCount < MAX_PER_BATCH}
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
			{/if}

			<!-- Available cartridges — click to add to batch -->
			{#if unsealed.length > 0 && currentBatch.scannedCount < MAX_PER_BATCH}
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
							<div class="flex items-center justify-between border-b border-[var(--color-tron-border)]/20 px-3 py-2.5 last:border-b-0">
							<button
								type="button"
								onclick={() => clickCartridge(cart)}
								disabled={isReadonly}
								class="flex flex-1 items-center gap-2 text-left text-sm transition-colors hover:text-[var(--color-tron-cyan)] disabled:opacity-50"
							>
								<span class="font-mono text-[var(--color-tron-text)]">{cart.cartridgeId}</span>
								<span class="rounded bg-[var(--color-tron-surface)] px-2 py-0.5 text-xs text-[var(--color-tron-text-secondary)]">
									Pos {cart.deckPosition}
								</span>
							</button>
							{#if onRejectCartridge}
								<button
									type="button"
									onclick={() => onRejectCartridge?.(cart.id)}
									disabled={isReadonly}
									class="ml-2 min-h-[32px] shrink-0 rounded border border-red-500/40 px-2 py-1 text-xs text-red-400 transition-colors hover:bg-red-900/20 hover:text-red-300 disabled:opacity-50"
								>
									Reject
								</button>
							{/if}
						</div>
						{/each}
						{#if filteredUnsealed.length === 0 && filterText}
							<p class="px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">No cartridges match "{filterText}"</p>
						{/if}
					</div>
				</div>
			{/if}

			<!-- Top Sealed button — show when server or local scans have added cartridges -->
			{#if currentBatch.scannedCount > 0 || scannedBarcodes.length > 0}
				{@const totalScanned = Math.max(currentBatch.scannedCount, scannedBarcodes.length)}
				<button type="button" onclick={() => onCompleteBatch(currentBatch!.batchId)}
					class="mt-4 min-h-[52px] w-full rounded-lg border border-green-500/50 bg-green-900/20 px-6 py-3 text-base font-bold text-green-400 transition-all hover:bg-green-900/30"
				>
					Top Sealed ({totalScanned} cartridge{totalScanned !== 1 ? 's' : ''})
				</button>
			{/if}
		</div>
	{/if}
</div>
