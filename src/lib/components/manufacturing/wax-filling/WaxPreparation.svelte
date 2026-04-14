<script lang="ts">
	import { generateTestBarcode } from '$lib/utils/test-barcode';

	interface Props {
		onComplete: (data: { sourceLot: string; tubeId: string; plannedCartridgeCount: number }) => void;
		readonly?: boolean;
	}

	let { onComplete, readonly: isReadonly = false }: Props = $props();

	// Step 1: Scan 15ml Wax Tube
	// Step 2: Cartridge count
	// Step 3: Scan 2ml Tube Lot Barcode
	// Step 4: Fill with 800 microliters (confirm)
	// Step 5: Confirm 2ml of wax placed in A3 (final — right before deck loading)
	let step = $state<1 | 2 | 3 | 4 | 5>(1);
	let sourceLot = $state('');
	let plannedCartridgeCount = $state(24);
	let tubeInput = $state('');
	let tubeError = $state('');
	let tubeSuccess = $state('');
	let lotInput = $state('');
	let lotError = $state('');
	let lotInputEl: HTMLInputElement | undefined = $state();
	let tubeInputEl: HTMLInputElement | undefined = $state();
	let lotPendingValue = $state('');
	let tubePendingValue = $state('');
	let waxBatchInfo = $state<{ lotNumber: string; remainingVolumeUl: number } | null>(null);
	let tubeLotInfo = $state<{ lotNumber: string; partNumber: string; partName: string; quantity: number } | null>(null);
	let validating = $state(false);

	const FILL_VOLUME_UL = 800;

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
			setTimeout(
				() => {
					osc.stop();
					ctx.close();
				},
				success ? 100 : 300
			);
		} catch {
			/* Audio not supported */
		}
	}

	async function handleLotKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && lotInput.trim()) {
			e.preventDefault();
			const scanned = lotInput.trim();
			lotInput = '';
			lotError = '';
			validating = true;
			try {
				const res = await fetch(`/api/wax-batch/validate?barcode=${encodeURIComponent(scanned)}`);
				const body = await res.json();
				if (!res.ok || body.error) {
					lotError = body.error ?? 'Wax batch validation failed';
					playBeep(false);
					return;
				}
				if ((body.batch?.remainingVolumeUl ?? 0) < FILL_VOLUME_UL) {
					lotError = `Batch ${body.batch.lotNumber} only has ${body.batch.remainingVolumeUl} μL remaining (need ${FILL_VOLUME_UL}).`;
					playBeep(false);
					return;
				}
				waxBatchInfo = {
					lotNumber: body.batch.lotNumber,
					remainingVolumeUl: body.batch.remainingVolumeUl
				};
				lotPendingValue = scanned;
				playBeep(true);
			} catch (err) {
				lotError = 'Network error validating wax batch';
				playBeep(false);
			} finally {
				validating = false;
			}
		}
	}

	function confirmLot() {
		sourceLot = lotPendingValue;
		lotPendingValue = '';
		step = 2;
	}

	function rescanLot() {
		lotPendingValue = '';
		waxBatchInfo = null;
		lotError = '';
		setTimeout(() => lotInputEl?.focus(), 50);
	}

	function confirmCartridgeCount() {
		if (plannedCartridgeCount < 1 || plannedCartridgeCount > 24) return;
		step = 3;
	}

	async function handleTubeKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && tubeInput.trim()) {
			e.preventDefault();
			const scanned = tubeInput.trim();
			tubeInput = '';
			tubeError = '';
			tubeSuccess = '';
			validating = true;
			try {
				const res = await fetch(`/api/receiving-lot/validate?barcode=${encodeURIComponent(scanned)}`);
				const body = await res.json();
				if (!res.ok || body.error) {
					tubeError = body.error ?? '2ml tube lot validation failed';
					playBeep(false);
					return;
				}
				tubeLotInfo = {
					lotNumber: body.lot.lotNumber ?? body.lot.lotId,
					partNumber: body.lot.part?.partNumber ?? '',
					partName: body.lot.part?.name ?? '',
					quantity: body.lot.quantity
				};
				tubePendingValue = scanned;
				playBeep(true);
			} catch (err) {
				tubeError = 'Network error validating tube lot';
				playBeep(false);
			} finally {
				validating = false;
			}
		}
	}

	function confirmTube() {
		step = 4;
	}

	function rescanTube() {
		tubePendingValue = '';
		tubeLotInfo = null;
		tubeError = '';
		setTimeout(() => tubeInputEl?.focus(), 50);
	}

	function confirmFill() {
		step = 5;
	}

	function confirmWaxPlaced() {
		// Final step: complete the prep — deductions happen when the run completes
		onComplete({ sourceLot, tubeId: tubePendingValue, plannedCartridgeCount });
	}

	function handleLotBlur() {
		if (step === 1 && !lotPendingValue) setTimeout(() => lotInputEl?.focus(), 100);
	}

	function handleTubeBlur() {
		if (step === 3 && !tubePendingValue) setTimeout(() => tubeInputEl?.focus(), 100);
	}

	$effect(() => {
		if (step === 1 && lotInputEl && !lotPendingValue) lotInputEl.focus();
	});

	$effect(() => {
		if (step === 3 && tubeInputEl && !tubePendingValue) tubeInputEl.focus();
	});
</script>

<div class="space-y-5">
	<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Wax Preparation</h2>
	<p class="text-sm text-[var(--color-tron-text-secondary)]">
		Prepare wax source, 2ml incubator tube, and fill it before deck loading.
	</p>

	{#if isReadonly}
		<p class="rounded border border-[var(--color-tron-yellow)]/30 bg-[var(--color-tron-yellow)]/5 px-3 py-2 text-xs text-[var(--color-tron-yellow)]">Read-only — viewing past stage</p>
	{/if}

	<!-- Step indicators (5 steps) -->
	<div class="flex items-center gap-2">
		{#each [1, 2, 3, 4, 5] as s (s)}
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
				{#if s < 5}
					<div class="h-px w-6 {step > s ? 'bg-green-500' : 'bg-[var(--color-tron-border)]'}"></div>
				{/if}
			</div>
		{/each}
	</div>

	<!-- Step 1: Scan 15ml Wax Tube -->
	{#if step === 1}
		<div
			class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5"
		>
			{#if !lotPendingValue}
				<div class="flex items-center gap-3">
					<div
						class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)]"
					>
						<svg
							class="h-5 w-5 text-[var(--color-tron-cyan)]"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
							stroke-width="2"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"
							/>
						</svg>
					</div>
					<div class="flex-1">
						<label for="wax-lot-input" class="tron-label">Scan 15ml Wax Tube</label>
						<input
							bind:this={lotInputEl}
							id="wax-lot-input"
							type="text"
							class="tron-input {lotError ? 'tron-input-error' : ''}"
							placeholder="Scan 15ml wax tube barcode..."
							bind:value={lotInput}
							onkeydown={handleLotKeydown}
							onblur={handleLotBlur}
							autocomplete="off"
							disabled={validating}
						/>
					</div>
				</div>
				{#if lotError}
					<div class="mt-3 rounded-lg border border-red-500/50 bg-red-900/20 p-3">
						<p class="text-sm font-medium text-red-400">{lotError}</p>
					</div>
				{/if}
			{:else}
				<div class="space-y-3">
					<p class="text-sm text-[var(--color-tron-text-secondary)]">Scanned 15ml wax tube:</p>
					<p class="font-mono text-lg font-semibold text-[var(--color-tron-cyan)]">{lotPendingValue}</p>
					{#if waxBatchInfo}
						<div class="space-y-1 text-xs text-[var(--color-tron-text-secondary)]">
							<div>Lot: <span class="font-mono text-[var(--color-tron-cyan)]">{waxBatchInfo.lotNumber}</span></div>
							<div>Remaining: <span class="font-mono text-[var(--color-tron-cyan)]">{waxBatchInfo.remainingVolumeUl.toLocaleString()} μL</span></div>
						</div>
					{/if}
					<div class="flex gap-3">
						<button
							type="button"
							onclick={rescanLot}
							class="min-h-[44px] rounded-lg border border-[var(--color-tron-border)] px-4 py-3 text-sm text-[var(--color-tron-text-secondary)] transition-all hover:border-[var(--color-tron-cyan)]/30"
						>
							Re-scan
						</button>
						<button
							type="button"
							onclick={confirmLot}
							class="min-h-[44px] flex-1 rounded-lg border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-6 py-3 text-sm font-semibold text-[var(--color-tron-cyan)] transition-all hover:bg-[var(--color-tron-cyan)]/30"
						>
							Continue
						</button>
					</div>
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
					15ml wax tube: <span class="font-mono text-[var(--color-tron-cyan)]">{sourceLot}</span>
				</div>
			</div>
		</div>
	{/if}

	<!-- Step 3: Scan 2ml Tube Lot Barcode -->
	{#if step === 3}
		<div
			class="space-y-4 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5"
		>
			{#if !tubePendingValue}
				<div class="flex items-center gap-3">
					<div
						class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)]"
					>
						<svg
							class="h-5 w-5 text-[var(--color-tron-cyan)]"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
							stroke-width="2"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"
							/>
						</svg>
					</div>
					<div class="flex-1">
						<label for="tube-input" class="tron-label">Scan 2ml Tube Lot Barcode</label>
						<input
							bind:this={tubeInputEl}
							id="tube-input"
							type="text"
							class="tron-input {tubeError ? 'tron-input-error' : ''}"
							placeholder="Scan 2ml tube lot barcode..."
							bind:value={tubeInput}
							onkeydown={handleTubeKeydown}
							onblur={handleTubeBlur}
							autocomplete="off"
							disabled={validating}
						/>
					</div>
				</div>
				{#if tubeError}
					<div class="rounded-lg border border-red-500/50 bg-red-900/20 p-3">
						<p class="text-sm font-medium text-red-400">{tubeError}</p>
					</div>
				{/if}
				{#if tubeSuccess}
					<div class="rounded-lg border border-green-500/50 bg-green-900/20 p-3">
						<p class="text-sm font-medium text-green-400">{tubeSuccess}</p>
					</div>
				{/if}
			{:else}
				<div class="space-y-3">
					<p class="text-sm text-[var(--color-tron-text-secondary)]">Scanned 2ml tube lot:</p>
					<p class="font-mono text-lg font-semibold text-[var(--color-tron-cyan)]">{tubePendingValue}</p>
					{#if tubeLotInfo}
						<div class="space-y-1 text-xs text-[var(--color-tron-text-secondary)]">
							{#if tubeLotInfo.partNumber}
								<div>Part: <span class="font-mono text-[var(--color-tron-cyan)]">{tubeLotInfo.partNumber}</span> <span>{tubeLotInfo.partName}</span></div>
							{/if}
							<div>Lot: <span class="font-mono text-[var(--color-tron-cyan)]">{tubeLotInfo.lotNumber}</span></div>
							<div>Quantity available: <span class="font-mono text-[var(--color-tron-cyan)]">{tubeLotInfo.quantity}</span></div>
						</div>
					{/if}
					<div class="flex gap-3">
						<button
							type="button"
							onclick={rescanTube}
							class="min-h-[44px] rounded-lg border border-[var(--color-tron-border)] px-4 py-3 text-sm text-[var(--color-tron-text-secondary)] transition-all hover:border-[var(--color-tron-cyan)]/30"
						>
							Re-scan
						</button>
						<button
							type="button"
							onclick={confirmTube}
							class="min-h-[44px] flex-1 rounded-lg border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-6 py-3 text-sm font-semibold text-[var(--color-tron-cyan)] transition-all hover:bg-[var(--color-tron-cyan)]/30"
						>
							Continue
						</button>
					</div>
				</div>
			{/if}

			<!-- Reference info -->
			<div class="space-y-1 text-xs text-[var(--color-tron-text-secondary)]">
				<div>15ml wax tube: <span class="font-mono text-[var(--color-tron-cyan)]">{sourceLot}</span></div>
				<div>Planned cartridges: <span class="font-mono text-[var(--color-tron-cyan)]">{plannedCartridgeCount}</span></div>
			</div>
		</div>
	{/if}

	<!-- Step 4: Fill with 800 microliters -->
	{#if step === 4}
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
						Fill with 800 microliters
					</p>
					<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
						Pipette <span class="font-semibold text-[var(--color-tron-cyan)]">800 μL</span> from the 15ml wax tube into the 2ml incubator tube.
					</p>
				</div>
			</div>

			<div class="mt-4 space-y-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] p-3 text-xs text-[var(--color-tron-text-secondary)]">
				<div>Source: <span class="font-mono text-[var(--color-tron-cyan)]">{sourceLot}</span> {#if waxBatchInfo}({waxBatchInfo.remainingVolumeUl.toLocaleString()} μL available){/if}</div>
				<div>Destination: <span class="font-mono text-[var(--color-tron-cyan)]">{tubePendingValue}</span></div>
			</div>

			<button
				type="button"
				onclick={confirmFill}
				class="mt-4 min-h-[44px] w-full rounded-lg border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-6 py-3 text-sm font-semibold text-[var(--color-tron-cyan)] transition-all hover:bg-[var(--color-tron-cyan)]/30"
			>
				Confirm Fill Complete
			</button>
		</div>
	{/if}

	<!-- Step 5: Confirm 2ml of wax placed in A3 (right before deck loading) -->
	{#if step === 5}
		<div
			class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5"
		>
			<div class="flex items-start gap-3">
				<svg
					class="mt-0.5 h-6 w-6 shrink-0 text-amber-400"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
					stroke-width="1.5"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
					/>
				</svg>
				<div>
					<p class="font-medium text-[var(--color-tron-text)]">
						Is 2ml of wax placed in A3 of the incubator?
					</p>
					<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
						Confirm the filled 2ml tube is loaded before proceeding to deck loading.
					</p>
				</div>
			</div>
			<button
				type="button"
				onclick={confirmWaxPlaced}
				class="mt-4 min-h-[44px] w-full rounded-lg border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-6 py-3 text-sm font-semibold text-[var(--color-tron-cyan)] transition-all hover:bg-[var(--color-tron-cyan)]/30"
			>
				Yes, Wax Is Placed
			</button>
		</div>
	{/if}
</div>
