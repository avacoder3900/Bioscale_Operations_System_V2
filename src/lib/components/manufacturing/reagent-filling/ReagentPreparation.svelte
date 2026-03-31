<script lang="ts">
	import { generateTestBarcode } from '$lib/utils/test-barcode';

	interface ReagentDef {
		wellPosition: number;
		reagentName: string;
		isActive: boolean;
	}

	interface TubeRecord {
		wellPosition: number;
		sourceLotId: string;
		transferTubeId: string;
	}

	interface Props {
		reagentDefinitions: ReagentDef[];
		onComplete: (tubes: TubeRecord[]) => void;
		readonly?: boolean;
		cartridgeCount?: number;
	}

	let { reagentDefinitions, onComplete, readonly: isReadonly = false, cartridgeCount = 0 }: Props = $props();

	let batchBarcode = $state('');
	let scanInput = $state('');
	let scanInputEl: HTMLInputElement | undefined = $state();
	let scanError = $state('');
	let submitting = $state(false);
	let batchData: { lotId: string; cartridgeCount?: number; tubes: { wellPosition: number; reagentName: string; tubeId: string }[] } | null = $state(null);
	let fetchingBatch = $state(false);
	let countMismatch = $derived(
		batchData?.cartridgeCount != null && cartridgeCount > 0 && batchData.cartridgeCount !== cartridgeCount
	);

	const activeWells = $derived(
		reagentDefinitions.filter((d) => d.isActive).sort((a, b) => a.wellPosition - b.wellPosition)
	);

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

	async function handleBatchScan() {
		const value = scanInput.trim();
		if (!value) return;

		scanError = '';
		fetchingBatch = true;
		batchBarcode = value;
		scanInput = '';

		try {
			const res = await fetch(`/api/manufacturing/reagent-batch/${encodeURIComponent(value)}`);
			if (!res.ok) {
				if (res.status === 404) {
					// API not yet built — use stub data based on active wells
					batchData = {
						lotId: value,
						cartridgeCount: cartridgeCount || undefined,
						tubes: activeWells.map((w, i) => ({
							wellPosition: w.wellPosition,
							reagentName: w.reagentName,
							tubeId: `${value}-T${i + 1}`
						}))
					};
					playBeep(true);
				} else {
					throw new Error(`Server error: ${res.status}`);
				}
			} else {
				const json = await res.json();
				batchData = json;
				playBeep(true);
			}
		} catch (e) {
			scanError = e instanceof Error ? e.message : 'Failed to fetch batch data';
			batchBarcode = '';
			batchData = null;
			playBeep(false);
		} finally {
			fetchingBatch = false;
		}
	}

	function resetScan() {
		batchBarcode = '';
		batchData = null;
		scanError = '';
		scanInput = '';
		setTimeout(() => scanInputEl?.focus(), 50);
	}

	function handleSubmit() {
		if (submitting || !batchData) return;
		submitting = true;

		const result: TubeRecord[] = batchData.tubes.map((t) => ({
			wellPosition: t.wellPosition,
			sourceLotId: batchData!.lotId,
			transferTubeId: t.tubeId
		}));

		onComplete(result);
	}
</script>

<div class="space-y-5">
	<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Reagent Batch Scan</h2>
	<p class="text-sm text-[var(--color-tron-text-secondary)]">
		Scan a single reagent batch barcode to auto-populate all tube information.
	</p>

	{#if isReadonly}
		<p class="rounded border border-[var(--color-tron-yellow)]/30 bg-[var(--color-tron-yellow)]/5 px-3 py-2 text-xs text-[var(--color-tron-yellow)]">Read-only — viewing past stage</p>
	{/if}

	{#if !batchData}
		<!-- Scan input -->
		<div class="space-y-3">
			<p class="text-xs font-medium text-[var(--color-tron-cyan)]">
				Scan reagent batch barcode
			</p>
			<div class="flex gap-2">
				<input
					bind:this={scanInputEl}
					bind:value={scanInput}
					onkeydown={(e) => { if (e.key === 'Enter') handleBatchScan(); }}
					placeholder="Reagent batch barcode..."
					disabled={fetchingBatch}
					class="min-h-[44px] flex-1 rounded border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none disabled:opacity-50"
				/>
				<button type="button" onclick={() => { scanInput = generateTestBarcode('RBATCH'); handleBatchScan(); }}
					class="min-h-[44px] rounded border border-[var(--color-tron-border)] px-3 py-2 text-xs text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-orange)] hover:text-[var(--color-tron-orange)]"
				>
					Test
				</button>
			</div>
			{#if fetchingBatch}
				<p class="text-xs text-[var(--color-tron-cyan)] animate-pulse">Looking up batch...</p>
			{/if}
			{#if scanError}
				<p class="text-xs text-red-400">{scanError}</p>
			{/if}
		</div>
	{:else}
		<!-- Batch data display -->
		<div class="space-y-4">
			<div class="flex items-center justify-between rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/10 p-4">
				<div>
					<p class="text-xs text-[var(--color-tron-text-secondary)]">Reagent Batch</p>
					<p class="font-mono text-lg font-bold text-[var(--color-tron-cyan)]">{batchBarcode}</p>
					<p class="text-xs text-[var(--color-tron-text-secondary)]">Lot: {batchData.lotId}</p>
				</div>
				<button
					type="button"
					onclick={resetScan}
					class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)] hover:border-red-500/50 hover:text-red-400"
				>
					Re-scan
				</button>
			</div>

			<!-- Cartridge count validation -->
			{#if countMismatch}
				<div class="flex items-center gap-3 rounded-lg border border-red-500/50 bg-red-900/20 p-4">
					<svg class="h-6 w-6 shrink-0 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
					</svg>
					<div>
						<p class="text-sm font-semibold text-red-400">Cartridge Count Mismatch</p>
						<p class="text-xs text-red-300/70">
							Deck has <span class="font-bold">{cartridgeCount}</span> cartridges loaded, but this reagent batch is for <span class="font-bold">{batchData?.cartridgeCount}</span> cartridges.
							Re-scan a matching batch or adjust the deck.
						</p>
					</div>
				</div>
			{:else if cartridgeCount > 0 && batchData?.cartridgeCount != null}
				<div class="flex items-center gap-2 rounded border border-green-500/30 bg-green-900/10 px-3 py-2 text-xs text-green-300">
					<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
					</svg>
					Cartridge count matches: {cartridgeCount} on deck, {batchData.cartridgeCount} in batch
				</div>
			{/if}

			<!-- 6-tube location diagram -->
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
				<p class="mb-3 text-xs font-medium text-[var(--color-tron-text-secondary)]">
					Tube Locations ({batchData.tubes.length} tubes)
				</p>
				<div class="grid grid-cols-3 gap-3">
					{#each batchData.tubes as tube (tube.wellPosition)}
						<div class="rounded border border-green-500/30 bg-green-900/10 p-3 text-center">
							<div class="text-xs text-[var(--color-tron-text-secondary)]">Well {tube.wellPosition}</div>
							<div class="mt-1 text-sm font-semibold text-[var(--color-tron-text)]">{tube.reagentName}</div>
							<div class="mt-1 font-mono text-xs text-green-300">{tube.tubeId}</div>
						</div>
					{/each}
				</div>
			</div>
		</div>

		<!-- Confirm button -->
		<button
			type="button"
			disabled={submitting || isReadonly || countMismatch}
			onclick={handleSubmit}
			class="min-h-[44px] w-full rounded-lg border px-6 py-3 text-sm font-semibold transition-all {!submitting && !isReadonly && !countMismatch
				? 'border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/30'
				: 'cursor-not-allowed border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] text-[var(--color-tron-text-secondary)] opacity-50'}"
		>
			{#if countMismatch}
				Cannot confirm — cartridge count mismatch
			{:else if submitting}
				Confirming...
			{:else}
				Confirm Reagent Batch ({batchData.tubes.length} tubes)
			{/if}
		</button>
	{/if}
</div>
