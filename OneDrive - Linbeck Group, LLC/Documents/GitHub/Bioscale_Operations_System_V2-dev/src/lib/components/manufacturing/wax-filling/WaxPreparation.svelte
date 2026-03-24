<script lang="ts">
	import { generateTestBarcode } from '$lib/utils/test-barcode';

	interface Props {
		onComplete: (data: { sourceLot: string; tubeId: string; plannedCartridgeCount: number }) => void;
		readonly?: boolean;
	}

	let { onComplete, readonly: isReadonly = false }: Props = $props();

	let step = $state<1 | 2 | 3 | 4>(1);
	let sourceLot = $state('');
	let plannedCartridgeCount = $state(24);
	let tubeInput = $state('');
	let tubeError = $state('');
	let tubeSuccess = $state('');
	let lotInput = $state('');
	let lotInputEl: HTMLInputElement | undefined = $state();
	let tubeInputEl: HTMLInputElement | undefined = $state();
	let lotPendingValue = $state('');
	let tubePendingValue = $state('');

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

	function confirmWaxPlaced() {
		step = 2;
	}

	function handleLotKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && lotInput.trim()) {
			e.preventDefault();
			lotPendingValue = lotInput.trim();
			lotInput = '';
			playBeep(true);
		}
	}

	function confirmLot() {
		sourceLot = lotPendingValue;
		lotPendingValue = '';
		step = 3;
	}

	function rescanLot() {
		lotPendingValue = '';
		setTimeout(() => lotInputEl?.focus(), 50);
	}

	function confirmCartridgeCount() {
		if (plannedCartridgeCount < 1 || plannedCartridgeCount > 24) return;
		step = 4;
	}

	function handleTubeKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && tubeInput.trim()) {
			e.preventDefault();
			tubePendingValue = tubeInput.trim();
			tubeError = '';
			tubeSuccess = '';
			tubeInput = '';
			playBeep(true);
		}
	}

	function confirmTube() {
		onComplete({ sourceLot, tubeId: tubePendingValue, plannedCartridgeCount });
	}

	function rescanTube() {
		tubePendingValue = '';
		setTimeout(() => tubeInputEl?.focus(), 50);
	}

	function handleLotBlur() {
		if (step === 2 && !lotPendingValue) setTimeout(() => lotInputEl?.focus(), 100);
	}

	function handleTubeBlur() {
		if (step === 4 && !tubePendingValue) setTimeout(() => tubeInputEl?.focus(), 100);
	}

	$effect(() => {
		if (step === 2 && lotInputEl && !lotPendingValue) lotInputEl.focus();
	});

	$effect(() => {
		if (step === 4 && tubeInputEl && !tubePendingValue) tubeInputEl.focus();
	});
</script>

<div class="space-y-5">
	<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Wax Preparation</h2>
	<p class="text-sm text-[var(--color-tron-text-secondary)]">
		Prepare wax source and incubator tube for the run.
	</p>

	{#if isReadonly}
		<p class="rounded border border-[var(--color-tron-yellow)]/30 bg-[var(--color-tron-yellow)]/5 px-3 py-2 text-xs text-[var(--color-tron-yellow)]">Read-only — viewing past stage</p>
	{/if}

	<!-- Step indicators (4 steps) -->
	<div class="flex items-center gap-2">
		{#each [1, 2, 3, 4] as s (s)}
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
				{#if s < 4}
					<div class="h-px w-6 {step > s ? 'bg-green-500' : 'bg-[var(--color-tron-border)]'}"></div>
				{/if}
			</div>
		{/each}
	</div>

	<!-- Step 1: Wax confirmation -->
	{#if step === 1}
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
						Confirm the wax is loaded before proceeding.
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

	<!-- Step 2: Source wax lot scan -->
	{#if step === 2}
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
						<label for="wax-lot-input" class="tron-label">Scan Source Wax Lot</label>
						<input
							bind:this={lotInputEl}
							id="wax-lot-input"
							type="text"
							class="tron-input"
							placeholder="Scan wax lot barcode..."
							bind:value={lotInput}
							onkeydown={handleLotKeydown}
							onblur={handleLotBlur}
							autocomplete="off"
						/>
					</div>
				</div>
				<button
					type="button"
					onclick={async () => {
					const res = await fetch('/api/dev/test-data?type=oven-lot');
					if (res.ok) {
						const data = await res.json();
						lotInput = data.lotId;
						handleLotKeydown(new KeyboardEvent('keydown', { key: 'Enter' }));
					} else {
						alert('No test lots. Run POST /api/dev/seed-test-inventory first.');
					}
				}}
					class="mt-2 rounded border border-[var(--color-tron-border)] px-3 py-2 text-xs text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-orange)] hover:text-[var(--color-tron-orange)]"
				>
					Test
				</button>
			{:else}
				<div class="space-y-3">
					<p class="text-sm text-[var(--color-tron-text-secondary)]">Scanned source wax lot:</p>
					<p class="font-mono text-lg font-semibold text-[var(--color-tron-cyan)]">{lotPendingValue}</p>
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

	<!-- Step 3: Planned cartridge count -->
	{#if step === 3}
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
					Source lot: <span class="font-mono text-[var(--color-tron-cyan)]">{sourceLot}</span>
				</div>
			</div>
		</div>
	{/if}

	<!-- Step 4: Incubator tube scan -->
	{#if step === 4}
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
						<label for="tube-input" class="tron-label">Scan Incubator Tube</label>
						<input
							bind:this={tubeInputEl}
							id="tube-input"
							type="text"
							class="tron-input {tubeError ? 'tron-input-error' : ''}"
							placeholder="Scan incubator tube barcode..."
							bind:value={tubeInput}
							onkeydown={handleTubeKeydown}
							onblur={handleTubeBlur}
							autocomplete="off"
						/>
					</div>
				</div>
				<button
					type="button"
					onclick={() => { tubeInput = generateTestBarcode('ITUB'); handleTubeKeydown(new KeyboardEvent('keydown', { key: 'Enter' })); }}
					class="mt-2 rounded border border-[var(--color-tron-border)] px-3 py-2 text-xs text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-orange)] hover:text-[var(--color-tron-orange)]"
				>
					Test
				</button>
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
					<p class="text-sm text-[var(--color-tron-text-secondary)]">Scanned incubator tube:</p>
					<p class="font-mono text-lg font-semibold text-[var(--color-tron-cyan)]">{tubePendingValue}</p>
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
				<div>Source lot: <span class="font-mono text-[var(--color-tron-cyan)]">{sourceLot}</span></div>
				<div>Planned cartridges: <span class="font-mono text-[var(--color-tron-cyan)]">{plannedCartridgeCount}</span></div>
			</div>
		</div>
	{/if}
</div>
