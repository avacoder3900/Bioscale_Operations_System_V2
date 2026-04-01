<script lang="ts">
	// ⚠️ MERGE NOTE: Jacob is building the full Reagent Batch tracking system on a separate branch.
	// This component's API call (`/api/manufacturing/reagent-batch/{barcode}`) and the BatchData
	// interface below are STUBS that must be updated to match Jacob's models/routes when merging.
	// DO NOT overwrite Jacob's reagent batch models, API routes, or schema definitions.
	// This component is the UI consumer only — Jacob's branch owns the data layer.

	interface TubeLocation {
		position: number;
		reagentName: string;
		volumeUl: number;
		lotId: string | null;
	}

	interface BatchData {
		batchId: string;
		batchBarcode: string;
		assayTypeName: string;
		operatorName: string;
		prepDate: string;
		expiryDate: string | null;
		cartridgeCount: number;
		tubes: TubeLocation[];
		notes: string | null;
	}

	interface Props {
		onComplete: (batchBarcode: string) => void;
		readonly?: boolean;
	}

	let { onComplete, readonly: isReadonly = false }: Props = $props();

	let barcodeInput = $state('');
	let scanInputEl: HTMLInputElement | undefined = $state();
	let scanning = $state(false);
	let scanError = $state('');
	let batchData = $state<BatchData | null>(null);
	let confirmed = $state(false);

	async function lookupBatch() {
		if (!barcodeInput.trim()) return;
		scanning = true;
		scanError = '';
		batchData = null;

		try {
			const res = await fetch(`/api/manufacturing/reagent-batch/${encodeURIComponent(barcodeInput.trim())}`);
			if (!res.ok) {
				const err = await res.json().catch(() => ({ error: 'Batch not found' }));
				scanError = err.error || `Batch not found (${res.status})`;
				return;
			}
			batchData = await res.json();
		} catch (e) {
			scanError = 'Failed to look up batch. Check connection.';
		} finally {
			scanning = false;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			lookupBatch();
		}
	}

	function confirmBatch() {
		if (!batchData) return;
		confirmed = true;
		onComplete(batchData.batchBarcode);
	}

	function resetScan() {
		barcodeInput = '';
		batchData = null;
		scanError = '';
		confirmed = false;
		scanInputEl?.focus();
	}

	// Tube position colors for visual distinction
	const positionColors = [
		'border-blue-500/50 bg-blue-900/20',
		'border-emerald-500/50 bg-emerald-900/20',
		'border-purple-500/50 bg-purple-900/20',
		'border-amber-500/50 bg-amber-900/20',
		'border-rose-500/50 bg-rose-900/20',
		'border-cyan-500/50 bg-cyan-900/20',
	];
	const positionTextColors = [
		'text-blue-300',
		'text-emerald-300',
		'text-purple-300',
		'text-amber-300',
		'text-rose-300',
		'text-cyan-300',
	];
</script>

<div class="space-y-5">
	<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Reagent Batch Verification</h2>
	<p class="text-sm text-[var(--color-tron-text-secondary)]">
		Scan the Reagent Batch barcode to load and verify reagent information before starting the run.
	</p>

	<!-- Barcode Scan Input -->
	{#if !batchData}
		<div class="space-y-3">
			<div class="flex gap-3">
				<div class="flex-1">
					<label for="batch-barcode" class="mb-1 block text-xs font-medium text-[var(--color-tron-text-secondary)]">
						Reagent Batch Barcode
					</label>
					<input
						id="batch-barcode"
						type="text"
						bind:value={barcodeInput}
						bind:this={scanInputEl}
						onkeydown={handleKeydown}
						disabled={scanning || isReadonly}
						placeholder="Scan or type batch barcode..."
						autocomplete="off"
						class="min-h-[44px] w-full rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-4 py-3 text-sm text-[var(--color-tron-text)] placeholder-[var(--color-tron-text-secondary)]/50 transition-colors focus:border-[var(--color-tron-cyan)] focus:outline-none"
					/>
				</div>
				<div class="flex items-end">
					<button
						type="button"
						onclick={lookupBatch}
						disabled={scanning || !barcodeInput.trim() || isReadonly}
						class="min-h-[44px] rounded-lg border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-6 py-3 text-sm font-semibold text-[var(--color-tron-cyan)] transition-all hover:bg-[var(--color-tron-cyan)]/30 disabled:opacity-50 disabled:cursor-not-allowed"
					>
						{scanning ? 'Looking up...' : 'Look Up'}
					</button>
				</div>
			</div>

			{#if scanError}
				<div class="rounded-lg border border-red-500/30 bg-red-900/20 px-4 py-3 text-sm text-red-300">
					{scanError}
				</div>
			{/if}
		</div>
	{:else}
		<!-- Batch Found — Show Details -->
		<div class="space-y-4">
			<!-- Header with batch ID and rescan option -->
			<div class="flex items-center justify-between rounded-lg border border-green-500/30 bg-green-900/10 px-4 py-3">
				<div class="flex items-center gap-3">
					<svg class="h-6 w-6 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
					</svg>
					<div>
						<p class="text-sm font-semibold text-green-400">Batch Found</p>
						<p class="font-mono text-xs text-green-300/70">{batchData.batchBarcode}</p>
					</div>
				</div>
				{#if !confirmed}
					<button
						type="button"
						onclick={resetScan}
						class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)] transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]"
					>
						Rescan
					</button>
				{/if}
			</div>

			<!-- Tube Rack Diagram — 6 positions, left to right -->
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
				<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Tube Rack Layout</h3>
				<div class="grid grid-cols-6 gap-2">
					{#each Array(6) as _, i}
						{@const tube = batchData.tubes.find(t => t.position === i + 1)}
						<div class="flex flex-col items-center gap-1.5 rounded-lg border p-3 {tube ? positionColors[i] : 'border-[var(--color-tron-border)]/30 bg-[var(--color-tron-bg)]/50'}">
							<!-- Tube visual -->
							<div class="flex h-16 w-8 flex-col items-center justify-end rounded-b-full border-2 {tube ? 'border-current ' + positionTextColors[i] : 'border-[var(--color-tron-text-secondary)]/30'}">
								{#if tube}
									<div class="w-full rounded-b-full {positionColors[i]}" style="height: {Math.min(90, Math.max(20, (tube.volumeUl / 2000) * 100))}%"></div>
								{/if}
							</div>
							<!-- Position number -->
							<span class="text-xs font-bold {tube ? positionTextColors[i] : 'text-[var(--color-tron-text-secondary)]/50'}">{i + 1}</span>
							<!-- Reagent name -->
							{#if tube}
								<span class="text-center text-[10px] font-medium {positionTextColors[i]} leading-tight">{tube.reagentName}</span>
								<span class="text-[9px] text-[var(--color-tron-text-secondary)]">{tube.volumeUl} µL</span>
							{:else}
								<span class="text-[10px] text-[var(--color-tron-text-secondary)]/50">Empty</span>
							{/if}
						</div>
					{/each}
				</div>
			</div>

			<!-- Batch Details -->
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
				<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Batch Details</h3>
				<div class="grid gap-3 sm:grid-cols-2">
					<div class="flex justify-between text-sm">
						<span class="text-[var(--color-tron-text-secondary)]">Assay Type</span>
						<span class="font-medium text-[var(--color-tron-text)]">{batchData.assayTypeName}</span>
					</div>
					<div class="flex justify-between text-sm">
						<span class="text-[var(--color-tron-text-secondary)]">Prepared By</span>
						<span class="font-medium text-[var(--color-tron-text)]">{batchData.operatorName}</span>
					</div>
					<div class="flex justify-between text-sm">
						<span class="text-[var(--color-tron-text-secondary)]">Prep Date</span>
						<span class="font-medium text-[var(--color-tron-text)]">{new Date(batchData.prepDate).toLocaleDateString()}</span>
					</div>
					{#if batchData.expiryDate}
						<div class="flex justify-between text-sm">
							<span class="text-[var(--color-tron-text-secondary)]">Expiry</span>
							<span class="font-medium text-[var(--color-tron-text)]">{new Date(batchData.expiryDate).toLocaleDateString()}</span>
						</div>
					{/if}
					<div class="flex justify-between text-sm sm:col-span-2">
						<span class="text-[var(--color-tron-text-secondary)]">Cartridges in Batch</span>
						<span class="text-base font-bold text-[var(--color-tron-cyan)]">{batchData.cartridgeCount}</span>
					</div>
				</div>
				{#if batchData.notes}
					<div class="mt-3 rounded border border-[var(--color-tron-border)]/50 bg-[var(--color-tron-bg)] px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">
						{batchData.notes}
					</div>
				{/if}
			</div>

			<!-- Tube Detail Table -->
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
				<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Reagent Details</h3>
				<div class="overflow-x-auto">
					<table class="w-full text-left text-xs">
						<thead>
							<tr class="border-b border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]">
								<th class="px-3 py-2">Pos</th>
								<th class="px-3 py-2">Reagent</th>
								<th class="px-3 py-2">Volume (µL)</th>
								<th class="px-3 py-2">Lot ID</th>
							</tr>
						</thead>
						<tbody>
							{#each batchData.tubes.sort((a, b) => a.position - b.position) as tube}
								<tr class="border-b border-[var(--color-tron-border)]/30">
									<td class="px-3 py-2 font-bold {positionTextColors[tube.position - 1]}">{tube.position}</td>
									<td class="px-3 py-2 text-[var(--color-tron-text)]">{tube.reagentName}</td>
									<td class="px-3 py-2 text-[var(--color-tron-text)]">{tube.volumeUl}</td>
									<td class="px-3 py-2 font-mono text-[var(--color-tron-text-secondary)]">{tube.lotId ?? '—'}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</div>

			<!-- Confirm Button -->
			{#if !confirmed && !isReadonly}
				<button
					type="button"
					onclick={confirmBatch}
					class="min-h-[44px] w-full rounded-lg border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-6 py-3 text-sm font-semibold text-[var(--color-tron-cyan)] transition-all hover:bg-[var(--color-tron-cyan)]/30"
				>
					Confirm Reagent Batch — Proceed to Run
				</button>
			{/if}
		</div>
	{/if}
</div>
