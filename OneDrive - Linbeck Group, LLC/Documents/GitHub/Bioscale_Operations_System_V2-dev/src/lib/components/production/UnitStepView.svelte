<script lang="ts">
	import ScanInput from '$lib/components/assembly/ScanInput.svelte';

	interface PartRequirement {
		id: string;
		partNumber: string;
		quantity: number;
		notes: string | null;
		partDefinitionId: string | null;
		partName: string | null;
	}

	interface ToolRequirement {
		id: string;
		toolName: string | null;
		notes: string | null;
	}

	interface Step {
		id: string;
		stepNumber: number;
		title: string | null;
		content: string | null;
		imageData: string | null;
		imageContentType: string | null;
		requiresScan: boolean;
		scanPrompt: string | null;
		partDefinitionId: string | null;
		partQuantity: number | null;
		partRequirements: PartRequirement[];
		toolRequirements: ToolRequirement[];
	}

	interface Unit {
		id: string;
		udi: string;
		status: 'pending' | 'in_progress' | 'completed';
	}

	interface Props {
		unit: Unit;
		steps: Step[];
		completedStepIds: Set<string>;
		onScan: (barcode: string, stepId: string, partDefinitionId: string) => void;
	}

	let { unit, steps, completedStepIds, onScan }: Props = $props();

	let currentStepIndex = $derived.by(() => {
		const idx = steps.findIndex((s) => !completedStepIds.has(s.id));
		return idx === -1 ? steps.length - 1 : idx;
	});

	let viewingStepIndex = $state(0);

	// Sync viewingStepIndex to currentStepIndex when steps complete
	$effect(() => {
		viewingStepIndex = currentStepIndex;
	});

	let viewingStep = $derived(steps[viewingStepIndex]);
	let isViewingCurrent = $derived(viewingStepIndex === currentStepIndex);
	let isStepCompleted = $derived(viewingStep ? completedStepIds.has(viewingStep.id) : false);
	let allCompleted = $derived(steps.every((s) => completedStepIds.has(s.id)));

	function goToPrev() {
		if (viewingStepIndex > 0) viewingStepIndex--;
	}

	function goToNext() {
		if (viewingStepIndex < steps.length - 1) viewingStepIndex++;
	}

	function handleScan(barcode: string) {
		if (!viewingStep) return;
		const partReq = viewingStep.partRequirements[0];
		const partDefId = partReq?.partDefinitionId ?? viewingStep.partDefinitionId ?? '';
		onScan(barcode, viewingStep.id, partDefId);
	}
</script>

<div class="unit-step-view">
	<!-- UDI Header -->
	<div class="udi-header">
		<span class="udi-label">{unit.udi}</span>
		{#if allCompleted}
			<span class="unit-badge completed">All Steps Complete</span>
		{:else if unit.status === 'in_progress'}
			<span class="unit-badge active">In Progress</span>
		{:else}
			<span class="unit-badge pending">Pending</span>
		{/if}
	</div>

	{#if viewingStep}
		<!-- Current Step Display -->
		<div class="step-display" class:is-completed={isStepCompleted}>
			<div class="step-header">
				<span class="step-badge" class:completed={isStepCompleted}>
					{#if isStepCompleted}
						&#x2713;
					{:else}
						{viewingStep.stepNumber}
					{/if}
				</span>
				<h3 class="step-title">
					{viewingStep.title || `Step ${viewingStep.stepNumber}`}
				</h3>
				<span class="step-counter">
					{viewingStepIndex + 1} / {steps.length}
				</span>
			</div>

			<!-- Step Content -->
			{#if viewingStep.content}
				<div class="step-content">
					<p>{viewingStep.content}</p>
				</div>
			{/if}

			<!-- Reference Image -->
			{#if viewingStep.imageData && viewingStep.imageContentType}
				<div class="step-image">
					<img
						src="data:{viewingStep.imageContentType};base64,{viewingStep.imageData}"
						alt="Step {viewingStep.stepNumber} reference"
					/>
				</div>
			{/if}

			<!-- Part Requirements -->
			{#if viewingStep.partRequirements.length > 0}
				<div class="part-requirements">
					<h4 class="section-label">Required Parts</h4>
					<div class="part-chips">
						{#each viewingStep.partRequirements as partReq (partReq.id)}
							<span class="part-chip">
								<span class="part-number">{partReq.partNumber}</span>
								<span class="part-qty">&times; {partReq.quantity}</span>
								{#if partReq.partName}
									<span class="part-name">{partReq.partName}</span>
								{/if}
							</span>
						{/each}
					</div>
				</div>
			{/if}

			<!-- Tool Requirements -->
			{#if viewingStep.toolRequirements.length > 0}
				<div class="tool-requirements">
					<h4 class="section-label">Required Tools</h4>
					<div class="part-chips">
						{#each viewingStep.toolRequirements as toolReq (toolReq.id)}
							<span class="tool-chip">{toolReq.toolName ?? 'Unknown Tool'}</span>
						{/each}
					</div>
				</div>
			{/if}

			<!-- Scan Prompt -->
			{#if viewingStep.requiresScan && viewingStep.scanPrompt && !isStepCompleted}
				<div class="scan-prompt">
					<svg class="scan-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"
						/>
					</svg>
					<span>{viewingStep.scanPrompt}</span>
				</div>
			{/if}

			<!-- Scan Input (only for current uncompleted step) -->
			{#if isViewingCurrent && !isStepCompleted && unit.status === 'in_progress'}
				<div class="scan-input-wrap">
					<ScanInput
						label={viewingStep.requiresScan ? 'Scan to Complete Step' : 'Scan Part Barcode'}
						placeholder="Scan barcode..."
						onScan={handleScan}
					/>
				</div>
			{/if}

			<!-- Completed indicator -->
			{#if isStepCompleted}
				<div class="completed-indicator">
					<svg class="check-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M5 13l4 4L19 7"
						/>
					</svg>
					<span>Step Completed</span>
				</div>
			{/if}
		</div>

		<!-- Step Navigation -->
		<div class="step-nav">
			<button class="nav-btn" onclick={goToPrev} disabled={viewingStepIndex === 0}>
				<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" class="nav-icon">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M15 19l-7-7 7-7"
					/>
				</svg>
				Previous
			</button>
			<button class="nav-btn" onclick={goToNext} disabled={viewingStepIndex === steps.length - 1}>
				Next
				<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" class="nav-icon">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
				</svg>
			</button>
		</div>
	{/if}

	<!-- Step List -->
	<div class="step-list">
		<h4 class="section-label">All Steps</h4>
		<div class="step-items">
			{#each steps as step, index (step.id)}
				{@const completed = completedStepIds.has(step.id)}
				{@const isCurrent = index === currentStepIndex}
				{@const isViewing = index === viewingStepIndex}
				<button
					class="step-item"
					class:completed
					class:current={isCurrent}
					class:viewing={isViewing}
					onclick={() => (viewingStepIndex = index)}
				>
					<span class="step-item-badge" class:completed class:current={isCurrent}>
						{#if completed}
							<svg class="step-check" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="3"
									d="M5 13l4 4L19 7"
								/>
							</svg>
						{:else}
							{step.stepNumber}
						{/if}
					</span>
					<span class="step-item-title">
						{step.title || `Step ${step.stepNumber}`}
					</span>
					{#if step.requiresScan}
						<svg class="scan-indicator" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"
							/>
						</svg>
					{/if}
				</button>
			{/each}
		</div>
	</div>
</div>

<style>
	.unit-step-view {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.udi-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		flex-wrap: wrap;
	}

	.udi-label {
		font-family: monospace;
		font-size: 1.25rem;
		font-weight: 700;
		color: var(--color-tron-cyan);
		letter-spacing: 0.05em;
	}

	.unit-badge {
		display: inline-flex;
		align-items: center;
		padding: 0.25rem 0.75rem;
		border-radius: 9999px;
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.unit-badge.active {
		border: 1px solid var(--color-tron-cyan);
		color: var(--color-tron-cyan);
		animation: tron-pulse 2s ease-in-out infinite;
	}

	.unit-badge.completed {
		border: 1px solid var(--color-tron-green);
		color: var(--color-tron-green);
	}

	.unit-badge.pending {
		border: 1px solid var(--color-tron-text-secondary);
		color: var(--color-tron-text-secondary);
	}

	/* Step Display */
	.step-display {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding: 1.25rem;
		border: 1px solid var(--color-tron-cyan);
		border-radius: 0.5rem;
		background-color: var(--color-tron-bg-card);
	}

	.step-display.is-completed {
		border-color: var(--color-tron-green);
	}

	.step-header {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.step-badge {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: 9999px;
		font-size: 0.875rem;
		font-weight: 700;
		flex-shrink: 0;
		background-color: var(--color-tron-cyan);
		color: var(--color-tron-bg-primary);
	}

	.step-badge.completed {
		background-color: var(--color-tron-green);
	}

	.step-title {
		flex: 1;
		margin: 0;
		font-size: 1.125rem;
		font-weight: 600;
		color: var(--color-tron-text-primary);
	}

	.step-counter {
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--color-tron-cyan);
		background-color: rgba(0, 212, 255, 0.1);
		padding: 0.25rem 0.625rem;
		border-radius: 9999px;
		white-space: nowrap;
	}

	.step-content {
		padding: 1rem;
		border-radius: 0.5rem;
		background-color: var(--color-tron-bg-tertiary);
	}

	.step-content p {
		margin: 0;
		font-size: 0.9375rem;
		line-height: 1.6;
		color: var(--color-tron-text-secondary);
		white-space: pre-wrap;
	}

	.step-image {
		border-radius: 0.5rem;
		overflow: hidden;
		border: 1px solid var(--color-tron-border);
	}

	.step-image img {
		display: block;
		width: 100%;
		max-height: 300px;
		object-fit: contain;
		background-color: var(--color-tron-bg-tertiary);
	}

	.section-label {
		margin: 0 0 0.5rem;
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--color-tron-text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.part-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.part-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.375rem 0.625rem;
		border-radius: 0.375rem;
		background-color: rgba(0, 212, 255, 0.1);
		font-size: 0.8125rem;
	}

	.part-number {
		font-family: monospace;
		font-weight: 600;
		color: var(--color-tron-cyan);
	}

	.part-qty {
		color: var(--color-tron-text-secondary);
	}

	.part-name {
		color: var(--color-tron-text-secondary);
		font-size: 0.75rem;
	}

	.tool-chip {
		display: inline-flex;
		padding: 0.375rem 0.625rem;
		border-radius: 0.375rem;
		background-color: rgba(251, 191, 36, 0.1);
		font-size: 0.8125rem;
		color: #fbbf24;
	}

	.scan-prompt {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 1rem;
		border-radius: 0.5rem;
		border: 1px solid rgba(0, 255, 136, 0.3);
		background-color: rgba(0, 255, 136, 0.05);
		color: var(--color-tron-green);
		font-weight: 500;
	}

	.scan-icon {
		width: 1.5rem;
		height: 1.5rem;
		flex-shrink: 0;
	}

	.scan-input-wrap {
		padding-top: 0.5rem;
	}

	.completed-indicator {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem;
		border-radius: 0.5rem;
		background-color: rgba(0, 255, 136, 0.1);
		color: var(--color-tron-green);
		font-weight: 600;
		font-size: 0.875rem;
	}

	.check-icon {
		width: 1.25rem;
		height: 1.25rem;
	}

	/* Step Navigation */
	.step-nav {
		display: flex;
		gap: 0.75rem;
	}

	.nav-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.375rem;
		flex: 1;
		min-height: 44px;
		padding: 0.625rem 1rem;
		border: 1px solid var(--color-tron-border);
		border-radius: 0.5rem;
		background-color: var(--color-tron-bg-tertiary);
		color: var(--color-tron-text-primary);
		font-weight: 500;
		font-size: 0.875rem;
		cursor: pointer;
		transition:
			border-color 0.15s,
			background-color 0.15s;
	}

	.nav-btn:hover:not(:disabled) {
		border-color: var(--color-tron-cyan);
		background-color: var(--color-tron-bg-card);
	}

	.nav-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.nav-icon {
		width: 1rem;
		height: 1rem;
	}

	/* Step List */
	.step-list {
		padding: 1rem;
		border: 1px solid var(--color-tron-border);
		border-radius: 0.5rem;
		background-color: var(--color-tron-bg-secondary);
	}

	.step-items {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	.step-item {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-height: 44px;
		padding: 0.5rem 0.75rem;
		border: 1px solid transparent;
		border-radius: 0.375rem;
		background-color: var(--color-tron-bg-tertiary);
		color: var(--color-tron-text-primary);
		cursor: pointer;
		text-align: left;
		transition:
			border-color 0.15s,
			background-color 0.15s;
	}

	.step-item:hover {
		border-color: var(--color-tron-border);
	}

	.step-item.viewing {
		border-color: var(--color-tron-cyan);
		background-color: var(--color-tron-bg-card);
	}

	.step-item.completed {
		opacity: 0.8;
	}

	.step-item-badge {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 9999px;
		font-size: 0.75rem;
		font-weight: 700;
		flex-shrink: 0;
		background-color: var(--color-tron-bg-secondary);
		color: var(--color-tron-text-secondary);
	}

	.step-item-badge.current {
		background-color: var(--color-tron-cyan);
		color: var(--color-tron-bg-primary);
	}

	.step-item-badge.completed {
		background-color: var(--color-tron-green);
		color: var(--color-tron-bg-primary);
	}

	.step-check {
		width: 0.875rem;
		height: 0.875rem;
	}

	.step-item-title {
		flex: 1;
		font-size: 0.875rem;
		font-weight: 500;
	}

	.step-item.completed .step-item-title {
		color: var(--color-tron-green);
	}

	.step-item.current .step-item-title {
		color: var(--color-tron-cyan);
	}

	.scan-indicator {
		width: 1rem;
		height: 1rem;
		flex-shrink: 0;
		color: var(--color-tron-text-secondary);
	}

	.step-item.completed .scan-indicator {
		color: var(--color-tron-green);
	}
</style>
