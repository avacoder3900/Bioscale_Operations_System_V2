<script lang="ts">
	import EquipmentDiagram from '$lib/components/manufacturing/EquipmentDiagram.svelte';

	interface Props {
		incubatorTempC: number;
		heaterTempC: number;
		onComplete: () => void;
		readonly?: boolean;
	}

	let { incubatorTempC = 70, heaterTempC = 50, onComplete, readonly: isReadonly = false }: Props = $props();

	let confirmed = $state(false);

	const items = $derived([
		`Incubator at ${incubatorTempC}\u00B0C`,
		`Heater at ${heaterTempC}\u00B0C`,
		'Robot powered on',
		'Deck placed in oven'
	]);
</script>

<div class="space-y-5">
	<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Setup Confirmation</h2>
	<p class="text-sm text-[var(--color-tron-text-secondary)]">
		Verify all setup conditions are met before proceeding.
	</p>

	<!-- Checklist (read-only display) -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 space-y-2">
		{#each items as item}
			<div class="flex items-center gap-3 text-sm text-[var(--color-tron-text)]">
				<span class="text-[var(--color-tron-text-secondary)]">•</span>
				{item}
			</div>
		{/each}
	</div>

	<!-- Deck → Oven placement diagram -->
	<EquipmentDiagram type="deck" destination="oven" />

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
		disabled={!confirmed || isReadonly}
		onclick={onComplete}
		class="min-h-[44px] w-full rounded-lg border px-6 py-3 text-sm font-semibold transition-all {confirmed && !isReadonly
			? 'border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/30'
			: 'cursor-not-allowed border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] text-[var(--color-tron-text-secondary)] opacity-50'}"
	>
		{confirmed ? 'Confirm Setup' : 'Check the box above to continue'}
	</button>
</div>
