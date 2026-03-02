<script lang="ts">
	interface Unit {
		id: string;
		unitIndex: number;
		udi: string;
		status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
	}

	interface Props {
		units: Unit[];
		selectedUnitId: string;
		onSelect: (unitId: string) => void;
	}

	let { units, selectedUnitId, onSelect }: Props = $props();
</script>

<div class="unit-tab-bar" role="tablist">
	{#each units as unit (unit.id)}
		<button
			class="unit-tab"
			class:selected={unit.id === selectedUnitId}
			class:pending={unit.status === 'pending'}
			class:in-progress={unit.status === 'in_progress'}
			class:completed={unit.status === 'completed'}
			class:cancelled={unit.status === 'cancelled'}
			role="tab"
			aria-selected={unit.id === selectedUnitId}
			onclick={() => onSelect(unit.id)}
		>
			<span class="unit-index">U{unit.unitIndex}</span>
			<span class="unit-udi">{unit.udi.split('-').slice(-1)[0]}</span>
			{#if unit.status === 'completed'}
				<span class="status-icon completed-icon">&#x2713;</span>
			{:else if unit.status === 'cancelled'}
				<span class="status-icon cancelled-icon">&#x2717;</span>
			{/if}
		</button>
	{/each}
</div>

<style>
	.unit-tab-bar {
		display: flex;
		gap: 0.5rem;
		overflow-x: auto;
		padding: 0.5rem;
		background-color: var(--color-tron-bg-secondary);
		border: 1px solid var(--color-tron-border);
		border-radius: 0.5rem;
		-webkit-overflow-scrolling: touch;
	}

	.unit-tab {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.125rem;
		min-height: 44px;
		min-width: 64px;
		padding: 0.375rem 0.75rem;
		border: 1px solid var(--color-tron-border);
		border-radius: 0.375rem;
		background-color: var(--color-tron-bg-tertiary);
		color: var(--color-tron-text-secondary);
		cursor: pointer;
		flex-shrink: 0;
		position: relative;
		transition:
			border-color 0.15s,
			background-color 0.15s;
	}

	.unit-tab:hover {
		border-color: var(--color-tron-cyan);
	}

	.unit-tab.selected {
		border-color: var(--color-tron-cyan);
		box-shadow: 0 0 8px rgba(0, 212, 255, 0.3);
		background-color: var(--color-tron-bg-card);
	}

	.unit-tab.pending {
		color: var(--color-tron-text-secondary);
	}

	.unit-tab.in-progress {
		color: var(--color-tron-cyan);
		animation: tron-pulse 2s ease-in-out infinite;
	}

	.unit-tab.completed {
		color: var(--color-tron-green);
	}

	.unit-tab.cancelled {
		color: var(--color-tron-red);
		opacity: 0.6;
	}

	.unit-index {
		font-weight: 700;
		font-size: 0.875rem;
		line-height: 1;
	}

	.unit-udi {
		font-family: monospace;
		font-size: 0.625rem;
		opacity: 0.7;
		line-height: 1;
	}

	.status-icon {
		position: absolute;
		top: 2px;
		right: 4px;
		font-size: 0.625rem;
	}

	.completed-icon {
		color: var(--color-tron-green);
	}

	.cancelled-icon {
		color: var(--color-tron-red);
	}
</style>
