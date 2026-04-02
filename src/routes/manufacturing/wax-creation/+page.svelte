<script lang="ts">
	import { enhance } from '$app/forms';

	interface Props {
		data: { lotNumber: string };
	}
	let { data }: Props = $props();

	let currentStep = $state(1);
	const totalSteps = 6;

	// Step 1
	let lotBarcode = $state('');
	let nanodecaneVisuallyMelted = $state(false);

	// Step 2
	let scaleTared = $state(false);

	// Step 3
	let nanodecaneWeight = $state<number | null>(null);

	// Step 4
	let actualWaxWeight = $state<number | null>(null);
	const targetWaxWeight = $derived(
		nanodecaneWeight ? parseFloat(((nanodecaneWeight / 0.97) * 0.03).toFixed(2)) : 0
	);
	const totalBatchWeight = $derived(
		nanodecaneWeight && actualWaxWeight ? nanodecaneWeight + actualWaxWeight : 0
	);
	const waxTolerance = $derived(() => {
		if (!targetWaxWeight || !actualWaxWeight) return null;
		const diff = Math.abs(actualWaxWeight - targetWaxWeight) / targetWaxWeight;
		return diff <= 0.05 ? 'pass' : 'fail';
	});

	// Step 5
	let waxDissolvedAndMixed = $state(false);

	// Step 6
	const expectedTotalMl = $derived(totalBatchWeight ? parseFloat((totalBatchWeight / 0.73).toFixed(1)) : 0);
	const expectedTubes = $derived(expectedTotalMl ? Math.floor(expectedTotalMl / 12) : 0);
	let fullTubeCount = $state<number | null>(null);
	let partialTubeMl = $state<number | null>(null);
	let fridgeBarcode = $state('');
	let tubesLabeledAndStored = $state(false);

	let completed = $state(false);
	let saving = $state(false);
	let saved = $state(false);

	function canProceed(step: number): boolean {
		switch (step) {
			case 1: return nanodecaneVisuallyMelted && lotBarcode.trim() !== '';
			case 2: return scaleTared;
			case 3: return nanodecaneWeight !== null && nanodecaneWeight > 0;
			case 4: return actualWaxWeight !== null && actualWaxWeight > 0 && waxTolerance() === 'pass';
			case 5: return waxDissolvedAndMixed;
			case 6: return fullTubeCount !== null && fullTubeCount > 0 && fridgeBarcode.trim() !== '' && tubesLabeledAndStored;
			default: return false;
		}
	}

	function nextStep() {
		if (currentStep < totalSteps && canProceed(currentStep)) {
			currentStep++;
		}
	}

	function finishBatch() {
		completed = true;
	}
</script>

<div class="mx-auto max-w-3xl">
	<!-- Header -->
	<div class="mb-6">
		<div class="flex items-center justify-between">
			<h1 class="text-xl font-bold text-[var(--color-tron-cyan)]">Wax Creation — 3% Microcrystalline Wax</h1>
			<div class="flex items-center gap-2">
				<span class="rounded border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-cyan)]/10 px-3 py-1 text-sm font-mono font-bold text-[var(--color-tron-cyan)]">
					{data.lotNumber}
				</span>
				{#if lotBarcode}
					<span class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-1 text-sm font-mono text-[var(--color-tron-text-secondary)]">
						{lotBarcode}
					</span>
				{/if}
			</div>
		</div>
		<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
			Step-by-step work instruction for creating 3% microcrystalline wax mixture
		</p>
	</div>

	<!-- Progress Bar -->
	<div class="mb-6 flex items-center gap-1">
		{#each Array(totalSteps) as _, i}
			{@const step = i + 1}
			<div class="flex flex-1 items-center gap-1">
				<div
					class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold transition-colors
						{step < currentStep
							? 'bg-[var(--color-tron-cyan)] text-black'
							: step === currentStep
								? 'border-2 border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
								: 'border border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]'}"
				>
					{#if step < currentStep}
						&#10003;
					{:else}
						{step}
					{/if}
				</div>
				{#if i < totalSteps - 1}
					<div class="h-0.5 flex-1 rounded {step < currentStep ? 'bg-[var(--color-tron-cyan)]' : 'bg-[var(--color-tron-border)]'}"></div>
				{/if}
			</div>
		{/each}
	</div>

	<!-- Raw Materials Reference -->
	{#if !completed}
		<div class="mb-4 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
			<h3 class="text-xs font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Raw Materials</h3>
			<div class="mt-2 grid grid-cols-2 gap-3 text-sm">
				<div>
					<span class="text-[var(--color-tron-text)]">n-Decane (nanodecane)</span>
					<span class="block text-xs text-[var(--color-tron-text-secondary)]">100g bottle — Sigma-Aldrich ($113)</span>
				</div>
				<div>
					<span class="text-[var(--color-tron-text)]">Soft Microcrystalline Wax</span>
					<span class="block text-xs text-[var(--color-tron-text-secondary)]">1 lb — Carmel ($17.17)</span>
				</div>
			</div>
		</div>
	{/if}

	<!-- Steps -->
	{#if !completed}
		<!-- Step 1: Heat Nanodecane -->
		{#if currentStep === 1}
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5">
				<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Step 1: Heat Nanodecane</h2>

				<div class="mt-4">
					<label class="block text-sm text-[var(--color-tron-text)]">
						Scan lot barcode label
						<input
							type="text"
							bind:value={lotBarcode}
							class="mt-1 block w-64 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
							placeholder="Scan barcode sticker for tubes"
						/>
					</label>
					<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">This barcode will be physically attached to all tubes in this batch</p>
				</div>

				<ol class="mt-4 list-inside list-decimal space-y-2 text-sm text-[var(--color-tron-text-secondary)]">
					<li>Set hot plate to <span class="font-semibold text-[var(--color-tron-cyan)]">70°C</span></li>
					<li>Place bottle of nanodecane on hot plate</li>
					<li>Wait <span class="font-semibold text-[var(--color-tron-cyan)]">45 minutes</span></li>
				</ol>
				<label class="mt-4 flex items-center gap-2 text-sm text-[var(--color-tron-text)]">
					<input type="checkbox" bind:checked={nanodecaneVisuallyMelted} class="accent-[var(--color-tron-cyan)]" />
					Nanodecane visually melted
				</label>
				<button
					onclick={nextStep}
					disabled={!canProceed(1)}
					class="mt-4 rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-semibold text-black transition-opacity disabled:opacity-30"
				>
					Next &rarr;
				</button>
			</div>
		{/if}

		<!-- Step 2: Tare Scale -->
		{#if currentStep === 2}
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5">
				<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Step 2: Tare Scale</h2>
				<ol class="mt-3 list-inside list-decimal space-y-2 text-sm text-[var(--color-tron-text-secondary)]">
					<li>Place a clean <span class="font-semibold text-[var(--color-tron-cyan)]">100ml glass bottle</span> on the weigh scale</li>
					<li>Tare the scale to zero</li>
				</ol>
				<label class="mt-4 flex items-center gap-2 text-sm text-[var(--color-tron-text)]">
					<input type="checkbox" bind:checked={scaleTared} class="accent-[var(--color-tron-cyan)]" />
					Scale tared with empty bottle
				</label>
				<button
					onclick={nextStep}
					disabled={!canProceed(2)}
					class="mt-4 rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-semibold text-black transition-opacity disabled:opacity-30"
				>
					Next &rarr;
				</button>
			</div>
		{/if}

		<!-- Step 3: Pour & Weigh Nanodecane -->
		{#if currentStep === 3}
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5">
				<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Step 3: Pour & Weigh Nanodecane</h2>
				<p class="mt-3 text-sm text-[var(--color-tron-text-secondary)]">
					Pour all nanodecane into the tared glass bottle and record the weight.
				</p>
				<div class="mt-4">
					<label class="block text-sm text-[var(--color-tron-text)]">
						Nanodecane weight (g)
						<input
							type="number"
							step="0.01"
							min="0"
							bind:value={nanodecaneWeight}
							class="mt-1 block w-48 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
							placeholder="e.g. 97.5"
						/>
					</label>
					{#if nanodecaneWeight && nanodecaneWeight > 0}
						<p class="mt-2 text-sm text-[var(--color-tron-cyan)]">Recorded: {nanodecaneWeight}g nanodecane</p>
					{/if}
				</div>
				<button
					onclick={nextStep}
					disabled={!canProceed(3)}
					class="mt-4 rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-semibold text-black transition-opacity disabled:opacity-30"
				>
					Next &rarr;
				</button>
			</div>
		{/if}

		<!-- Step 4: Calculate & Add Microcrystalline Wax -->
		{#if currentStep === 4}
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5">
				<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Step 4: Calculate & Add Microcrystalline Wax</h2>

				<div class="mt-3 rounded border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/5 p-3">
					<p class="text-sm text-[var(--color-tron-text)]">
						Based on <span class="font-semibold text-[var(--color-tron-cyan)]">{nanodecaneWeight}g</span> nanodecane:
					</p>
					<p class="mt-1 text-lg font-bold text-[var(--color-tron-cyan)]">
						Add {targetWaxWeight}g of Soft Microcrystalline Wax
					</p>
					<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
						Formula: ({nanodecaneWeight} / 0.97) &times; 0.03 = {targetWaxWeight}g &mdash;
						Total expected batch: {(nanodecaneWeight! + targetWaxWeight).toFixed(2)}g
					</p>
				</div>

				<div class="mt-4">
					<label class="block text-sm text-[var(--color-tron-text)]">
						Actual wax weight added (g)
						<input
							type="number"
							step="0.01"
							min="0"
							bind:value={actualWaxWeight}
							class="mt-1 block w-48 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
							placeholder="e.g. 3.01"
						/>
					</label>
					{#if actualWaxWeight && actualWaxWeight > 0}
						{@const tolerance = waxTolerance()}
						<div class="mt-2 flex items-center gap-2 text-sm">
							<span class="text-[var(--color-tron-text-secondary)]">
								Target: {targetWaxWeight}g &mdash; Actual: {actualWaxWeight}g
								({((actualWaxWeight - targetWaxWeight) / targetWaxWeight * 100).toFixed(1)}%)
							</span>
							{#if tolerance === 'pass'}
								<span class="rounded bg-green-500/20 px-2 py-0.5 text-xs font-semibold text-green-400">PASS (&pm;5%)</span>
							{:else}
								<span class="rounded bg-red-500/20 px-2 py-0.5 text-xs font-semibold text-red-400">OUT OF TOLERANCE (&pm;5%)</span>
							{/if}
						</div>
					{/if}
				</div>

				<button
					onclick={nextStep}
					disabled={!canProceed(4)}
					class="mt-4 rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-semibold text-black transition-opacity disabled:opacity-30"
				>
					Next &rarr;
				</button>
			</div>
		{/if}

		<!-- Step 5: Heat & Mix -->
		{#if currentStep === 5}
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5">
				<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Step 5: Heat & Mix</h2>
				<ol class="mt-3 list-inside list-decimal space-y-2 text-sm text-[var(--color-tron-text-secondary)]">
					<li>Place bottle on hot plate at <span class="font-semibold text-[var(--color-tron-cyan)]">110°C</span></li>
					<li>Wait <span class="font-semibold text-[var(--color-tron-cyan)]">45 minutes</span></li>
				</ol>
				<label class="mt-4 flex items-center gap-2 text-sm text-[var(--color-tron-text)]">
					<input type="checkbox" bind:checked={waxDissolvedAndMixed} class="accent-[var(--color-tron-cyan)]" />
					Wax fully dissolved and mixed
				</label>
				<button
					onclick={nextStep}
					disabled={!canProceed(5)}
					class="mt-4 rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-semibold text-black transition-opacity disabled:opacity-30"
				>
					Next &rarr;
				</button>
			</div>
		{/if}

		<!-- Step 6: Aliquot & Store -->
		{#if currentStep === 6}
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5">
				<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Step 6: Aliquot & Store</h2>
				<ol class="mt-3 list-inside list-decimal space-y-2 text-sm text-[var(--color-tron-text-secondary)]">
					<li>Pipette <span class="font-semibold text-[var(--color-tron-cyan)]">12ml</span> into 15ml tubes</li>
					<li>Label tubes <span class="font-semibold text-[var(--color-tron-cyan)]">"3% Wax"</span> with today's date</li>
					<li>Store in fridge</li>
				</ol>

				<div class="mt-3 rounded border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/5 p-3">
					<p class="text-sm text-[var(--color-tron-text)]">
						Total batch: <span class="font-semibold text-[var(--color-tron-cyan)]">{totalBatchWeight.toFixed(2)}g</span>
						&rarr; ~{expectedTotalMl}ml (density ~0.73 g/ml)
					</p>
					<p class="mt-1 text-lg font-bold text-[var(--color-tron-cyan)]">
						Expected yield: ~{expectedTubes} tubes
					</p>
				</div>

				<div class="mt-4 grid grid-cols-2 gap-4">
					<label class="block text-sm text-[var(--color-tron-text)]">
						Number of full 12ml tubes created
						<input
							type="number"
							step="1"
							min="0"
							bind:value={fullTubeCount}
							class="mt-1 block w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
							placeholder="e.g. 11"
						/>
					</label>
					<label class="block text-sm text-[var(--color-tron-text)]">
						ml in the final (partial) tube
						<input
							type="number"
							step="0.1"
							min="0"
							max="12"
							bind:value={partialTubeMl}
							class="mt-1 block w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
							placeholder="e.g. 4.5 (0 if none)"
						/>
					</label>
				</div>

				<div class="mt-4">
					<label class="block text-sm text-[var(--color-tron-text)]">
						Fridge barcode
						<input
							type="text"
							bind:value={fridgeBarcode}
							class="mt-1 block w-64 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
							placeholder="Scan or enter fridge barcode"
						/>
					</label>
				</div>

				<label class="mt-4 flex items-center gap-2 text-sm text-[var(--color-tron-text)]">
					<input type="checkbox" bind:checked={tubesLabeledAndStored} class="accent-[var(--color-tron-cyan)]" />
					Tubes labeled and stored in fridge
				</label>

				<button
					onclick={finishBatch}
					disabled={!canProceed(6)}
					class="mt-4 rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-semibold text-black transition-opacity disabled:opacity-30"
				>
					Complete Batch
				</button>
			</div>
		{/if}
	{:else}
		<!-- Summary -->
		<div class="rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-surface)] p-5">
			<div class="flex items-center justify-between">
				<h2 class="text-lg font-semibold text-[var(--color-tron-cyan)]">Batch Complete</h2>
				<span class="font-mono text-sm font-bold text-[var(--color-tron-cyan)]">{data.lotNumber}</span>
			</div>
			<div class="mt-4 space-y-2 text-sm text-[var(--color-tron-text)]">
				<div class="grid grid-cols-2 gap-x-4 gap-y-2">
					<span class="text-[var(--color-tron-text-secondary)]">Lot number</span>
					<span>{data.lotNumber}</span>
					<span class="text-[var(--color-tron-text-secondary)]">Lot barcode</span>
					<span>{lotBarcode}</span>
					<span class="text-[var(--color-tron-text-secondary)]">Nanodecane weight</span>
					<span>{nanodecaneWeight}g</span>
					<span class="text-[var(--color-tron-text-secondary)]">Target wax weight</span>
					<span>{targetWaxWeight}g</span>
					<span class="text-[var(--color-tron-text-secondary)]">Actual wax weight</span>
					<span>{actualWaxWeight}g</span>
					<span class="text-[var(--color-tron-text-secondary)]">Total batch weight</span>
					<span>{totalBatchWeight.toFixed(2)}g</span>
					<span class="text-[var(--color-tron-text-secondary)]">Expected tubes</span>
					<span>{expectedTubes}</span>
					<span class="text-[var(--color-tron-text-secondary)]">Full tubes (12ml)</span>
					<span>{fullTubeCount}</span>
					<span class="text-[var(--color-tron-text-secondary)]">Partial tube</span>
					<span>{partialTubeMl ? `${partialTubeMl}ml` : 'None'}</span>
					<span class="text-[var(--color-tron-text-secondary)]">Fridge barcode</span>
					<span>{fridgeBarcode}</span>
				</div>
			</div>

			{#if saved}
				<div class="mt-4 rounded border border-green-500/30 bg-green-500/10 p-3 text-sm font-semibold text-green-400">
					Batch saved successfully!
				</div>
			{:else}
			<form method="POST" action="?/save" use:enhance={() => {
				saving = true;
				return async ({ result }) => {
					saving = false;
					if (result.type === 'success') {
						saved = true;
					}
				};
			}}>
				<input type="hidden" name="lotNumber" value={data.lotNumber} />
				<input type="hidden" name="lotBarcode" value={lotBarcode} />
				<input type="hidden" name="nanodecaneWeight" value={nanodecaneWeight} />
				<input type="hidden" name="actualWaxWeight" value={actualWaxWeight} />
				<input type="hidden" name="targetWaxWeight" value={targetWaxWeight} />
				<input type="hidden" name="fullTubeCount" value={fullTubeCount} />
				<input type="hidden" name="partialTubeMl" value={partialTubeMl ?? 0} />
				<input type="hidden" name="fridgeBarcode" value={fridgeBarcode} />
				<input type="hidden" name="expectedTubes" value={expectedTubes} />
				<button
					type="submit"
					disabled={saving}
					class="mt-4 rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-semibold text-black transition-opacity disabled:opacity-30"
				>
					{saving ? 'Saving...' : 'Save Batch Record'}
				</button>
			</form>
			{/if}
		</div>
	{/if}
</div>
