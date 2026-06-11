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

	// Step 1: Select wax lot (dropdown — WAX-FLOW-3 replaced the barcode scan)
	// Step 2: Cartridge count
	// Step 3: Fill the 2 ml tube with the computed volume (confirm)
	let step = $state<1 | 2 | 3>(1);
	let sourceLot = $state('');
	let plannedCartridgeCount = $state(24);

	const selectedLot = $derived(waxLots.find((l) => l.barcode === sourceLot) ?? null);
	const fillVolumeUl = $derived(Math.ceil(waxPerCartridgeUl * plannedCartridgeCount + deadVolumeUl));
	const insufficientVolume = $derived(selectedLot !== null && fillVolumeUl > selectedLot.remainingVolumeUl);

	function confirmLot() {
		if (!sourceLot) return;
		step = 2;
	}

	function confirmCartridgeCount() {
		if (plannedCartridgeCount < 1 || plannedCartridgeCount > 24) return;
		step = 3;
	}

	function confirmFill() {
		if (!sourceLot) return;
		onComplete({ sourceLot, plannedCartridgeCount });
	}
</script>

<div class="space-y-5">
	<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Wax Preparation</h2>
	<p class="text-sm text-[var(--color-tron-text-secondary)]">
		Select the wax lot, set the cartridge count, and fill the 2ml incubator tube before deck loading.
	</p>

	{#if isReadonly}
		<p class="rounded border border-[var(--color-tron-yellow)]/30 bg-[var(--color-tron-yellow)]/5 px-3 py-2 text-xs text-[var(--color-tron-yellow)]">Read-only — viewing past stage</p>
	{/if}

	<!-- Step indicators (3 steps) -->
	<div class="flex items-center gap-2">
		{#each [1, 2, 3] as s (s)}
			<div class="flex items-center gap-2">
				<div
					class="flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold {step > s
						? 'bg-green-500 text-white'
						: step === s
							? 'bg-[var(--color-tron-cyan)] text-white'
							: 'border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] text-[var(--color-tron-text-secondary)]'}"
				>
					{#if step > s}
						<svg
							class="h-4 w-4"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
							stroke-width="3"
						>
							<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
						</svg>
					{:else}
						{s}
					{/if}
				</div>
				{#if s < 3}
					<div class="h-px w-6 {step > s ? 'bg-green-500' : 'bg-[var(--color-tron-border)]'}"></div>
				{/if}
			</div>
		{/each}
	</div>

	<!-- Step 1: Select wax lot -->
	{#if step === 1}
		<div
			class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5"
		>
			{#if waxLots.length === 0}
				<div class="rounded-lg border border-amber-500/50 bg-amber-900/20 p-4 text-center">
					<p class="text-sm font-medium text-amber-300">
						No wax lots with remaining volume — create one at Wax Creation.
					</p>
				</div>
			{:else}
				<div class="space-y-4">
					<div>
						<label for="wax-lot-select" class="tron-label">Select wax lot</label>
						<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
							Pick the wax source this run will draw from.
						</p>
					</div>
					<select
						id="wax-lot-select"
						class="tron-input w-full"
						bind:value={sourceLot}
					>
						<option value="" disabled>Select a wax lot...</option>
						{#each waxLots as lot (lot.barcode)}
							<option value={lot.barcode}>
								{lot.label} — {lot.remainingVolumeUl.toLocaleString()} µL remaining
							</option>
						{/each}
					</select>
					{#if selectedLot}
						<div class="space-y-1 text-xs text-[var(--color-tron-text-secondary)]">
							<div>Lot: <span class="font-mono text-[var(--color-tron-cyan)]">{selectedLot.barcode}</span></div>
							<div>Remaining: <span class="font-mono text-[var(--color-tron-cyan)]">{selectedLot.remainingVolumeUl.toLocaleString()} µL</span></div>
						</div>
					{/if}
					<button
						type="button"
						onclick={confirmLot}
						disabled={!sourceLot}
						class="min-h-[44px] w-full rounded-lg border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-6 py-3 text-sm font-semibold text-[var(--color-tron-cyan)] transition-all hover:bg-[var(--color-tron-cyan)]/30 disabled:opacity-40 disabled:cursor-not-allowed"
					>
						Continue
					</button>
				</div>
			{/if}
		</div>
	{/if}

	<!-- Step 2: Planned cartridge count -->
	{#if step === 2}
		<div
			class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5"
		>
			<div class="space-y-4">
				<div>
					<label for="cartridge-count-input" class="tron-label text-base">How many cartridges are you filling?</label>
					<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">Enter the number of cartridges planned for this run (1-24).</p>
				</div>
				<input
					id="cartridge-count-input"
					type="number"
					min="1"
					max="24"
					class="tron-input text-center text-2xl font-bold"
					style="max-width: 200px; min-height: 56px;"
					bind:value={plannedCartridgeCount}
					onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); confirmCartridgeCount(); } }}
				/>
				<button
					type="button"
					onclick={confirmCartridgeCount}
					disabled={plannedCartridgeCount < 1 || plannedCartridgeCount > 24}
					class="min-h-[44px] w-full rounded-lg border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-6 py-3 text-sm font-semibold text-[var(--color-tron-cyan)] transition-all hover:bg-[var(--color-tron-cyan)]/30 disabled:opacity-40 disabled:cursor-not-allowed"
				>
					Confirm {plannedCartridgeCount} Cartridge{plannedCartridgeCount !== 1 ? 's' : ''}
				</button>

				<div class="text-xs text-[var(--color-tron-text-secondary)]">
					Wax lot: <span class="font-mono text-[var(--color-tron-cyan)]">{selectedLot?.label ?? sourceLot}</span>
				</div>
			</div>
		</div>
	{/if}

	<!-- Step 3: Fill the 2 ml tube with the computed volume -->
	{#if step === 3}
		<div
			class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5"
		>
			<div class="flex items-start gap-3">
				<svg
					class="mt-0.5 h-6 w-6 shrink-0 text-[var(--color-tron-cyan)]"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
					stroke-width="1.5"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						d="M12 3v2m0 14v2m-9-9H1m22 0h-2M5.636 5.636l-1.414-1.414M19.778 19.778l-1.414-1.414M5.636 18.364l-1.414 1.414M19.778 4.222l-1.414 1.414M12 8a4 4 0 100 8 4 4 0 000-8z"
					/>
				</svg>
				<div>
					<p class="text-lg font-semibold text-[var(--color-tron-text)]">
						Fill the 2 ml tube with {fillVolumeUl.toLocaleString()} µL
					</p>
					<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
						Pipette <span class="font-semibold text-[var(--color-tron-cyan)]">{fillVolumeUl.toLocaleString()} µL</span> from the wax lot into the 2ml incubator tube.
					</p>
					<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
						{waxPerCartridgeUl} µL × {plannedCartridgeCount} cartridge{plannedCartridgeCount !== 1 ? 's' : ''} + {deadVolumeUl} µL dead volume
					</p>
				</div>
			</div>

			<div class="mt-4 space-y-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] p-3 text-xs text-[var(--color-tron-text-secondary)]">
				<div>Source: <span class="font-mono text-[var(--color-tron-cyan)]">{selectedLot?.label ?? sourceLot}</span> {#if selectedLot}({selectedLot.remainingVolumeUl.toLocaleString()} µL available){/if}</div>
				<div>Planned cartridges: <span class="font-mono text-[var(--color-tron-cyan)]">{plannedCartridgeCount}</span></div>
			</div>

			{#if insufficientVolume}
				<div class="mt-3 rounded-lg border border-red-500/50 bg-red-900/20 p-3">
					<p class="text-sm font-medium text-red-400">
						Selected lot only has {selectedLot?.remainingVolumeUl.toLocaleString()} µL remaining — this run needs {fillVolumeUl.toLocaleString()} µL. Pick another lot or reduce the cartridge count.
					</p>
				</div>
			{/if}

			<button
				type="button"
				onclick={confirmFill}
				class="mt-4 min-h-[44px] w-full rounded-lg border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-6 py-3 text-sm font-semibold text-[var(--color-tron-cyan)] transition-all hover:bg-[var(--color-tron-cyan)]/30"
			>
				Confirm Fill Complete
			</button>
		</div>
	{/if}
</div>
