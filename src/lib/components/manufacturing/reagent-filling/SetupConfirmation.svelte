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
		onComplete: () => void;
		readonly?: boolean;
	}

	let { assayTypes, reagentNames = [], selectedAssayTypeId, onSelectAssayType, onComplete, readonly: isReadonly = false }: Props =
		$props();

	// Use reagents from the selected assay type if reagentNames is empty
	const activeReagents = $derived(() => {
		if (reagentNames.length > 0) return reagentNames;
		const selected = assayTypes.find((a) => a.id === selectedAssayTypeId);
		return selected?.reagents ?? [];
	});

	let checks = $state([false, false, false, false, false]);

	let allChecked = $derived(checks.every(Boolean) && !!selectedAssayTypeId && !isReadonly);

	const items = [
		{ label: 'Robot powered on and calibrated', icon: 'M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6m-6 4h6' },
		{ label: 'Deck is clean and ready', icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4' },
		{ label: '2ml tube rack prepared', icon: 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10' },
		{ label: 'Reagent source tubes available', icon: 'M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z' },
		{ label: 'PPE worn', icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z' }
	];
</script>

<div class="space-y-5">
	<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Setup Confirmation</h2>
	<p class="text-sm text-[var(--color-tron-text-secondary)]">
		Select assay type and verify setup conditions before proceeding.
	</p>

	<div class="space-y-2">
		<label for="assay-type" class="text-sm font-medium text-[var(--color-tron-text-secondary)]">
			Assay Type (SKU)
		</label>
		<select
			id="assay-type"
			value={selectedAssayTypeId}
			onchange={(e) => onSelectAssayType(e.currentTarget.value)}
			disabled={isReadonly}
			class="min-h-[44px] w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none disabled:opacity-50"
		>
			<option value="">Select assay type...</option>
			{#each assayTypes.filter((a) => a.isActive) as at (at.id)}
				<option value={at.id}>{at.name} ({at.skuCode})</option>
			{/each}
		</select>
	</div>

	{#if selectedAssayTypeId && activeReagents().length > 0}
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

	<div class="space-y-3">
		{#each items as item, i (item.label)}
			<button
				type="button"
				onclick={() => { checks[i] = !checks[i]; }}
				class="flex min-h-[44px] w-full items-center gap-4 rounded-lg border px-4 py-3 text-left transition-all {checks[i]
					? 'border-green-500/50 bg-green-900/20'
					: 'border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] hover:border-[var(--color-tron-cyan)]/30'}"
			>
				<div
					class="flex h-6 w-6 shrink-0 items-center justify-center rounded border-2 transition-colors {checks[i]
						? 'border-green-500 bg-green-500'
						: 'border-[var(--color-tron-text-secondary)]'}"
				>
					{#if checks[i]}
						<svg class="h-4 w-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3">
							<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
						</svg>
					{/if}
				</div>
				<svg
					class="h-5 w-5 shrink-0 {checks[i] ? 'text-green-400' : 'text-[var(--color-tron-text-secondary)]'}"
					fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"
				>
					<path stroke-linecap="round" stroke-linejoin="round" d={item.icon} />
				</svg>
				<span class="text-sm font-medium {checks[i] ? 'text-green-300' : 'text-[var(--color-tron-text)]'}">
					{item.label}
				</span>
			</button>
		{/each}
	</div>

	<button
		type="button"
		disabled={!allChecked || isReadonly}
		onclick={onComplete}
		class="min-h-[44px] w-full rounded-lg border px-6 py-3 text-sm font-semibold transition-all {allChecked && !isReadonly
			? 'border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/30'
			: 'cursor-not-allowed border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] text-[var(--color-tron-text-secondary)] opacity-50'}"
	>
		{allChecked ? 'Confirm Setup' : `${checks.filter(Boolean).length} / 5 checks complete`}
	</button>
</div>
