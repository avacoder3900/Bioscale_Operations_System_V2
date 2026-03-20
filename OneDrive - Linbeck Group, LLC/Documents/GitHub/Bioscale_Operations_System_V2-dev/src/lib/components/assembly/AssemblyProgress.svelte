<script lang="ts">
	interface Step {
		name: string;
		completed?: boolean;
	}

	interface Props {
		currentStep: number;
		totalSteps: number;
		steps?: Step[];
	}

	let { currentStep, totalSteps, steps = [] }: Props = $props();

	let percentage = $derived(totalSteps > 0 ? Math.round((currentStep / totalSteps) * 100) : 0);
</script>

<div class="space-y-4">
	<div class="flex items-center justify-between text-sm">
		<span class="tron-text-muted">Progress</span>
		<span class="tron-text-primary font-medium">{currentStep} of {totalSteps} ({percentage}%)</span>
	</div>

	<div class="tron-progress">
		<div class="tron-progress-bar" style="width: {percentage}%"></div>
	</div>

	{#if steps.length > 0}
		<div class="flex items-center justify-between gap-2 overflow-x-auto py-2">
			{#each steps as step, index}
				{@const isCompleted = index < currentStep}
				{@const isCurrent = index === currentStep}
				<div class="flex min-w-[60px] flex-col items-center">
					<div
						class="flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium transition-all
						{isCompleted ? 'bg-[var(--color-tron-green)] text-[var(--color-tron-bg-primary)]' : ''}
						{isCurrent
							? 'animate-tron-pulse bg-[var(--color-tron-cyan)] text-[var(--color-tron-bg-primary)]'
							: ''}
						{!isCompleted && !isCurrent
							? 'border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] text-[var(--color-tron-text-secondary)]'
							: ''}"
					>
						{#if isCompleted}
							<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="3"
									d="M5 13l4 4L19 7"
								/>
							</svg>
						{:else}
							{index + 1}
						{/if}
					</div>
					<span
						class="mt-1 max-w-[80px] truncate text-center text-xs {isCurrent
							? 'tron-text-primary font-medium'
							: 'tron-text-muted'}"
					>
						{step.name}
					</span>
				</div>
			{/each}
		</div>
	{/if}
</div>
