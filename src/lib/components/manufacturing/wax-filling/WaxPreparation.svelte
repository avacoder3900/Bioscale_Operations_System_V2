<script lang="ts">
	interface WaxLot {
		barcode: string;
		label: string;
		remainingVolumeUl: number;
		source: string;
	}

	interface Props {
		waxLots: WaxLot[];
		waxPerCartridgeUl: number;
		deadVolumeUl: number;
		onComplete: (data: { sourceLot: string; plannedCartridgeCount: number }) => void;
		readonly?: boolean;
	}

	let { waxLots, waxPerCartridgeUl, deadVolumeUl, onComplete, readonly: isReadonly = false }: Props = $props();

	// One screen: pick wax lot + cartridge count, see the fill volume, confirm.
	let sourceLot = $state('');
	let plannedCartridgeCount = $state(24);

	const selectedLot = $derived(waxLots.find((l) => l.barcode === sourceLot) ?? null);
	const fillVolumeUl = $derived(Math.ceil(waxPerCartridgeUl * plannedCartridgeCount + deadVolumeUl));
	const insufficientVolume = $derived(selectedLot !== null && fillVolumeUl > selectedLot.remainingVolumeUl);
	const canComplete = $derived(!!sourceLot && plannedCartridgeCount >= 1 && plannedCartridgeCount <= 24 && !insufficientVolume);

	function complete() {
		if (!canComplete) return;
		onComplete({ sourceLot, plannedCartridgeCount });
	}
</script>

<div class="space-y-5">
	<div>
		<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Wax fill setup</h2>
		<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
			Pick the wax lot and cartridge count, fill the 2 ml tube with the shown volume, then confirm.
		</p>
	</div>

	{#if isReadonly}
		<p class="rounded border border-[var(--color-tron-yellow)]/30 bg-[var(--color-tron-yellow)]/5 px-3 py-2 text-xs text-[var(--color-tron-yellow)]">Read-only — viewing past stage</p>
	{/if}

	{#if waxLots.length === 0}
		<div class="rounded-lg border border-amber-500/50 bg-amber-900/20 p-4 text-center">
			<p class="text-sm font-medium text-amber-300">No wax lots with remaining volume — create one at Wax Creation.</p>
		</div>
	{:else}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5">
			<div class="grid gap-4 sm:grid-cols-2">
				<!-- Wax lot -->
				<div>
					<label for="wax-lot-select" class="tron-label">Wax lot</label>
					<select id="wax-lot-select" class="tron-input mt-1 w-full" bind:value={sourceLot}>
						<option value="" disabled>Select a wax lot…</option>
						{#each waxLots as lot (lot.barcode)}
							<option value={lot.barcode}>{lot.label} — {lot.remainingVolumeUl.toLocaleString()} µL</option>
						{/each}
					</select>
				</div>
				<!-- Cartridge count -->
				<div>
					<label for="cartridge-count-input" class="tron-label">Cartridges</label>
					<input
						id="cartridge-count-input"
						type="number"
						min="1"
						max="24"
						class="tron-input mt-1 w-full"
						bind:value={plannedCartridgeCount}
					/>
					<p class="mt-1 text-[11px] text-[var(--color-tron-text-secondary)]">1–24</p>
				</div>
			</div>

			<!-- Live fill instruction -->
			<div class="mt-4 rounded border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/5 p-3">
				<p class="text-base font-semibold text-[var(--color-tron-text)]">
					Fill the 2 ml tube with <span class="text-[var(--color-tron-cyan)]">{fillVolumeUl.toLocaleString()} µL</span>
				</p>
				<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
					{waxPerCartridgeUl} µL × {plannedCartridgeCount} cartridge{plannedCartridgeCount !== 1 ? 's' : ''} + {deadVolumeUl} µL dead volume
					{#if selectedLot}· lot has {selectedLot.remainingVolumeUl.toLocaleString()} µL{/if}
				</p>
			</div>

			{#if insufficientVolume}
				<div class="mt-3 rounded-lg border border-red-500/50 bg-red-900/20 p-3">
					<p class="text-sm font-medium text-red-400">
						This lot only has {selectedLot?.remainingVolumeUl.toLocaleString()} µL — the run needs {fillVolumeUl.toLocaleString()} µL. Pick another lot or fewer cartridges.
					</p>
				</div>
			{/if}

			<button
				type="button"
				onclick={complete}
				disabled={!canComplete}
				class="mt-4 min-h-[44px] w-full rounded-lg border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-6 py-3 text-sm font-semibold text-[var(--color-tron-cyan)] transition-all hover:bg-[var(--color-tron-cyan)]/30 disabled:cursor-not-allowed disabled:opacity-40"
			>
				Wax setup complete
			</button>
		</div>
	{/if}
</div>
