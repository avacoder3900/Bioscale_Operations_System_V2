<script lang="ts">
	import EquipmentDiagram from '$lib/components/manufacturing/EquipmentDiagram.svelte';

	interface Props {
		incubatorTempC: number;
		heaterTempC: number;
		onComplete: () => void;
		readonly?: boolean;
	}

	let { incubatorTempC = 70, heaterTempC = 50, onComplete, readonly: isReadonly = false }: Props = $props();

	let checks = $state([false, false, false, false]);

	let allChecked = $derived(checks.every(Boolean));

	const items = $derived([
		{
			label: `Incubator at ${incubatorTempC}\u00B0C`,
			icon: 'M12 2v6m0 12v2m-7-7H3m18 0h-2M5.6 5.6l1.4 1.4m10 10l1.4 1.4M5.6 18.4l1.4-1.4m10-10l1.4-1.4'
		},
		{
			label: `Heater at ${heaterTempC}\u00B0C`,
			icon: 'M12 2v6m0 12v2m-7-7H3m18 0h-2M5.6 5.6l1.4 1.4m10 10l1.4 1.4M5.6 18.4l1.4-1.4m10-10l1.4-1.4'
		},
		{
			label: 'Robot powered on',
			icon: 'M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6m-6 4h6'
		},
		{
			label: 'Deck placed in oven',
			icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4'
		}
	]);
</script>

<div class="space-y-5">
	<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Setup Confirmation</h2>
	<p class="text-sm text-[var(--color-tron-text-secondary)]">
		Verify all setup conditions before proceeding.
	</p>

	<div class="space-y-3">
		{#each items as item, i (item.label)}
			<button
				type="button"
				onclick={() => {
					checks[i] = !checks[i];
				}}
				class="flex min-h-[44px] w-full items-center gap-4 rounded-lg border px-4 py-3 text-left transition-all {checks[
					i
				]
					? 'border-green-500/50 bg-green-900/20'
					: 'border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] hover:border-[var(--color-tron-cyan)]/30'}"
			>
				<div
					class="flex h-6 w-6 shrink-0 items-center justify-center rounded border-2 transition-colors {checks[
						i
					]
						? 'border-green-500 bg-green-500'
						: 'border-[var(--color-tron-text-secondary)]'}"
				>
					{#if checks[i]}
						<svg
							class="h-4 w-4 text-white"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
							stroke-width="3"
						>
							<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
						</svg>
					{/if}
				</div>
				<svg
					class="h-5 w-5 shrink-0 {checks[i]
						? 'text-green-400'
						: 'text-[var(--color-tron-text-secondary)]'}"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
					stroke-width="1.5"
				>
					<path stroke-linecap="round" stroke-linejoin="round" d={item.icon} />
				</svg>
				<span
					class="text-sm font-medium {checks[i]
						? 'text-green-300'
						: 'text-[var(--color-tron-text)]'}"
				>
					{item.label}
				</span>
			</button>
		{/each}
	</div>

	<!-- Deck → Oven placement diagram -->
	<EquipmentDiagram type="deck" destination="oven" />

	<button
		type="button"
		disabled={!allChecked || isReadonly}
		onclick={onComplete}
		class="min-h-[44px] w-full rounded-lg border px-6 py-3 text-sm font-semibold transition-all {allChecked && !isReadonly
			? 'border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/30'
			: 'cursor-not-allowed border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] text-[var(--color-tron-text-secondary)] opacity-50'}"
	>
		{allChecked ? 'Confirm Setup' : `${checks.filter(Boolean).length} / 4 checks complete`}
	</button>
</div>
