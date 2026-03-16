<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';
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
	}

	let { reagentDefinitions, onComplete, readonly: isReadonly = false }: Props = $props();

	let tubes = new SvelteMap<number, { sourceLotId: string; transferTubeId: string }>();
	let currentWell = $state<number | null>(null);
	let scanStep = $state<'lot' | 'tube'>('lot');
	let scanInput = $state('');
	let scanInputEl: HTMLInputElement | undefined = $state();
	let scanError = $state('');
	let submitting = $state(false);
	let scanPendingValue = $state('');
	let scanPendingStep = $state<'lot' | 'tube'>('lot');

	const activeWells = $derived(
		reagentDefinitions.filter((d) => d.isActive).sort((a, b) => a.wellPosition - b.wellPosition)
	);

	let allScanned = $derived(
		activeWells.length > 0 &&
			activeWells.every((w) => {
				const t = tubes.get(w.wellPosition);
				return t?.sourceLotId && t?.transferTubeId;
			})
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

	function startScanning(wellPosition: number) {
		currentWell = wellPosition;
		scanStep = 'lot';
		scanInput = '';
		scanError = '';
		setTimeout(() => scanInputEl?.focus(), 50);
	}

	function handleScan() {
		const value = scanInput.trim();
		if (!value || currentWell === null) return;

		// Check for duplicate barcodes
		for (const [, t] of tubes) {
			if (t.sourceLotId === value || t.transferTubeId === value) {
				scanError = 'Duplicate barcode detected';
				playBeep(false);
				return;
			}
		}

		scanPendingValue = value;
		scanPendingStep = scanStep;
		scanInput = '';
		scanError = '';
		playBeep(true);
	}

	function confirmScan() {
		if (!scanPendingValue || currentWell === null) return;
		const value = scanPendingValue;
		scanPendingValue = '';

		if (scanPendingStep === 'lot') {
			const existing = tubes.get(currentWell);
			tubes.set(currentWell, { sourceLotId: value, transferTubeId: existing?.transferTubeId ?? '' });
			scanStep = 'tube';
			setTimeout(() => scanInputEl?.focus(), 50);
		} else {
			const existing = tubes.get(currentWell);
			if (!existing?.sourceLotId) return;
			tubes.set(currentWell, { ...existing, transferTubeId: value });

			// Advance to next unscanned well
			const nextWell = activeWells.find((w) => !tubes.has(w.wellPosition) || !tubes.get(w.wellPosition)?.transferTubeId);
			if (nextWell) {
				startScanning(nextWell.wellPosition);
			} else {
				currentWell = null;
			}
		}
	}

	function rescanPending() {
		scanPendingValue = '';
		setTimeout(() => scanInputEl?.focus(), 50);
	}

	function handleSubmit() {
		if (submitting) return;
		const result: TubeRecord[] = [];
		for (const well of activeWells) {
			const t = tubes.get(well.wellPosition);
			if (!t?.sourceLotId || !t?.transferTubeId) {
				scanError = `Well ${well.wellPosition} (${well.reagentName}) is missing a barcode scan`;
				return;
			}
			result.push({ wellPosition: well.wellPosition, sourceLotId: t.sourceLotId, transferTubeId: t.transferTubeId });
		}
		submitting = true;
		onComplete(result);
	}
</script>

<div class="space-y-5">
	<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Reagent Preparation</h2>
	<p class="text-sm text-[var(--color-tron-text-secondary)]">
		Scan source lot and incubator tube barcodes for each reagent well.
	</p>

	{#if isReadonly}
		<p class="rounded border border-[var(--color-tron-yellow)]/30 bg-[var(--color-tron-yellow)]/5 px-3 py-2 text-xs text-[var(--color-tron-yellow)]">Read-only — viewing past stage</p>
	{/if}

	<div class="space-y-3">
		{#each activeWells as well (well.wellPosition)}
			{@const tubeData = tubes.get(well.wellPosition)}
			{@const isComplete = tubeData?.sourceLotId && tubeData?.transferTubeId}
			{@const isActive = currentWell === well.wellPosition}
			<div
				class="rounded-lg border px-4 py-3 transition-all {isComplete
					? 'border-green-500/50 bg-green-900/20'
					: isActive
						? 'border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10'
						: 'border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]'}"
			>
				<div class="flex items-center justify-between">
					<div class="flex items-center gap-3">
						<span class="flex h-8 w-8 items-center justify-center rounded-full border text-xs font-bold {isComplete
							? 'border-green-500 bg-green-500 text-white'
							: 'border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'}"
						>
							{isComplete ? '\u2713' : well.wellPosition}
						</span>
						<div>
							<span class="text-sm font-medium text-[var(--color-tron-text)]">{well.reagentName}</span>
							<span class="ml-2 text-xs text-[var(--color-tron-text-secondary)]">Well {well.wellPosition}</span>
						</div>
					</div>
					{#if !isComplete && !isActive}
						<button
							type="button"
							onclick={() => startScanning(well.wellPosition)}
							class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/30 px-3 py-1.5 text-xs font-medium text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10"
						>
							Scan
						</button>
					{/if}
				</div>

				{#if isComplete}
					<div class="mt-2 flex gap-4 text-xs text-green-300">
						<span>Lot: {tubeData.sourceLotId}</span>
						<span>Tube: {tubeData.transferTubeId}</span>
					</div>
				{/if}

				{#if isActive}
					<div class="mt-3 space-y-2">
						{#if !scanPendingValue}
							<p class="text-xs font-medium text-[var(--color-tron-cyan)]">
								{scanStep === 'lot' ? 'Scan source lot barcode' : 'Scan 2ml incubator tube barcode'}
							</p>
							<div class="flex gap-2">
								<input
									bind:this={scanInputEl}
									bind:value={scanInput}
									onkeydown={(e) => { if (e.key === 'Enter') handleScan(); }}
									placeholder={scanStep === 'lot' ? 'Source lot barcode...' : 'Incubator tube barcode...'}
									class="min-h-[44px] flex-1 rounded border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
								/>
								<button type="button" onclick={() => { scanInput = generateTestBarcode(scanStep === 'lot' ? 'RLOT' : 'RTUB'); handleScan(); }}
									class="min-h-[44px] rounded border border-[var(--color-tron-border)] px-3 py-2 text-xs text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-orange)] hover:text-[var(--color-tron-orange)]"
								>
									Test
								</button>
							</div>
							{#if scanError}
								<p class="text-xs text-red-400">{scanError}</p>
							{/if}
						{:else}
							<p class="text-xs text-[var(--color-tron-text-secondary)]">
								Scanned {scanPendingStep === 'lot' ? 'source lot' : 'incubator tube'}:
							</p>
							<p class="font-mono text-sm font-semibold text-[var(--color-tron-cyan)]">{scanPendingValue}</p>
							<div class="flex gap-2">
								<button
									type="button"
									onclick={rescanPending}
									class="min-h-[44px] rounded border border-[var(--color-tron-border)] px-3 py-2 text-xs text-[var(--color-tron-text-secondary)] transition-all hover:border-[var(--color-tron-cyan)]/30"
								>
									Re-scan
								</button>
								<button
									type="button"
									onclick={confirmScan}
									class="min-h-[44px] flex-1 rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-2 text-sm font-semibold text-[var(--color-tron-cyan)] transition-all hover:bg-[var(--color-tron-cyan)]/30"
								>
									Continue
								</button>
							</div>
						{/if}
						{#if tubeData?.sourceLotId && !scanPendingValue}
							<p class="text-xs text-[var(--color-tron-text-secondary)]">Lot: {tubeData.sourceLotId}</p>
						{/if}
					</div>
				{/if}
			</div>
		{/each}
	</div>

	<button
		type="button"
		disabled={!allScanned || submitting}
		onclick={handleSubmit}
		class="min-h-[44px] w-full rounded-lg border px-6 py-3 text-sm font-semibold transition-all {allScanned && !submitting
			? 'border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/30'
			: 'cursor-not-allowed border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] text-[var(--color-tron-text-secondary)] opacity-50'}"
	>
		{submitting ? 'Confirming...' : allScanned ? 'Confirm Reagent Preparation' : `${tubes.size} / ${activeWells.length} reagents scanned`}
	</button>
</div>
