<script lang="ts">
	interface AssayType {
		id: string;
		name: string;
		skuCode: string | null;
		isActive: boolean;
		reagents?: { wellPosition: number; reagentName: string }[];
	}

	interface Props {
		assayTypes: AssayType[];
		reagentNames?: { wellPosition: number; reagentName: string }[];
		selectedAssayTypeId: string;
		onSelectAssayType: (id: string) => void;
		isResearch?: boolean;
		onSetResearch?: (value: boolean) => void;
		onComplete: () => void;
		readonly?: boolean;
	}

	let {
		assayTypes,
		reagentNames = [],
		selectedAssayTypeId,
		onSelectAssayType,
		isResearch = false,
		onSetResearch = () => {},
		onComplete,
		readonly: isReadonly = false
	}: Props = $props();

	// Use reagents from the selected assay type if reagentNames is empty.
	// Research mode has no assay, so no reagents to show.
	const activeReagents = $derived(() => {
		if (isResearch) return [];
		if (reagentNames.length > 0) return reagentNames;
		const selected = assayTypes.find((a) => a.id === selectedAssayTypeId);
		return selected?.reagents ?? [];
	});

	let confirmed = $state(false);

	// Assay-required gate is lifted when Research is selected.
	let allChecked = $derived(confirmed && (isResearch || !!selectedAssayTypeId) && !isReadonly);

	const items = [
		'Robot powered on and calibrated',
		'Deck is clean and ready',
		'2ml tube rack prepared',
		'Reagent source tubes available',
		'PPE worn'
	];
</script>

<div class="space-y-5">
	<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Setup Confirmation</h2>
	<p class="text-sm text-[var(--color-tron-text-secondary)]">
		Select run type and verify setup conditions before proceeding.
	</p>

	<!-- Run type: Production (assay required) vs Research (no assay) -->
	<div class="space-y-2">
		<span class="text-sm font-medium text-[var(--color-tron-text-secondary)]">Run Type</span>
		<div class="grid grid-cols-2 gap-2">
			<button
				type="button"
				disabled={isReadonly}
				onclick={() => onSetResearch(false)}
				class="min-h-[44px] rounded-lg border px-4 py-2 text-sm font-medium transition-all disabled:opacity-50 {!isResearch
					? 'border-[var(--color-tron-cyan)]/60 bg-[var(--color-tron-cyan)]/15 text-[var(--color-tron-cyan)]'
					: 'border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)]/30'}"
			>
				Production (Assay)
			</button>
			<button
				type="button"
				disabled={isReadonly}
				onclick={() => onSetResearch(true)}
				class="min-h-[44px] rounded-lg border px-4 py-2 text-sm font-medium transition-all disabled:opacity-50 {isResearch
					? 'border-[var(--color-tron-orange)]/60 bg-[var(--color-tron-orange)]/15 text-[var(--color-tron-orange)]'
					: 'border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-orange)]/30'}"
			>
				Research
			</button>
		</div>
		{#if isResearch}
			<p class="text-xs text-[var(--color-tron-orange)]/90">
				Research run — no assay will be assigned. Cartridges will flow through the line with assay fields left blank.
			</p>
		{/if}
	</div>

	<div class="space-y-2">
		<label for="assay-type" class="text-sm font-medium text-[var(--color-tron-text-secondary)]">
			Assay Type (SKU)
		</label>
		<select
			id="assay-type"
			value={isResearch ? '' : selectedAssayTypeId}
			onchange={(e) => onSelectAssayType(e.currentTarget.value)}
			disabled={isReadonly || isResearch}
			class="min-h-[44px] w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none disabled:opacity-50"
		>
			<option value="">{isResearch ? 'N/A — research run' : 'Select assay type...'}</option>
			{#each assayTypes.filter((a) => a.isActive) as at (at.id)}
				<option value={at.id}>{at.name} ({at.skuCode})</option>
			{/each}
		</select>
	</div>

	{#if !isResearch && selectedAssayTypeId && activeReagents().length > 0}
		<div
			class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3"
		>
			<p class="mb-2 text-xs font-medium text-[var(--color-tron-text-secondary)]">
				Reagent wells for this assay:
			</p>
			<div class="grid grid-cols-3 gap-2">
				{#each activeReagents() as rn (rn.wellPosition)}
					<div class="text-xs text-[var(--color-tron-text)]">
						<span class="text-[var(--color-tron-cyan)]">Well {rn.wellPosition}:</span>
						{rn.reagentName}
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Checklist (read-only display) -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 space-y-2">
		{#each items as item}
			<div class="flex items-center gap-3 text-sm text-[var(--color-tron-text)]">
				<span class="text-[var(--color-tron-text-secondary)]">•</span>
				{item}
			</div>
		{/each}
	</div>

	<!-- Single confirm checkbox -->
	<button
		type="button"
		onclick={() => { confirmed = !confirmed; }}
		class="flex min-h-[44px] w-full items-center gap-4 rounded-lg border px-4 py-3 text-left transition-all {confirmed
			? 'border-green-500/50 bg-green-900/20'
			: 'border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] hover:border-[var(--color-tron-cyan)]/30'}"
	>
		<div
			class="flex h-6 w-6 shrink-0 items-center justify-center rounded border-2 transition-colors {confirmed
				? 'border-green-500 bg-green-500'
				: 'border-[var(--color-tron-text-secondary)]'}"
		>
			{#if confirmed}
				<svg class="h-4 w-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3">
					<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
				</svg>
			{/if}
		</div>
		<span class="text-sm font-medium {confirmed ? 'text-green-300' : 'text-[var(--color-tron-text)]'}">
			I confirm all setup conditions above are met
		</span>
	</button>

	<button
		type="button"
		disabled={!allChecked || isReadonly}
		onclick={onComplete}
		class="min-h-[44px] w-full rounded-lg border px-6 py-3 text-sm font-semibold transition-all {allChecked && !isReadonly
			? 'border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/30'
			: 'cursor-not-allowed border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] text-[var(--color-tron-text-secondary)] opacity-50'}"
	>
		{allChecked
			? 'Confirm Setup'
			: isResearch
				? 'Check the box above to continue'
				: 'Select assay type and check the box above to continue'}
	</button>
</div>
