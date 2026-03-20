<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/stores';
	import { SvelteMap } from 'svelte/reactivity';
	import RunProgressHeader from '$lib/components/production/RunProgressHeader.svelte';
	import UnitTabBar from '$lib/components/production/UnitTabBar.svelte';
	import UnitStepView from '$lib/components/production/UnitStepView.svelte';

	let { data, form } = $props();

	const initialUnitId = data.units[0]?.id ?? '';
	let selectedUnitId = $state(initialUnitId);
	let selectedUnit = $derived(data.units.find((u) => u.id === selectedUnitId));

	// Build completed step IDs per unit from session records
	let completedStepsByUnit = $derived.by(() => {
		const map = new SvelteMap<string, Set<string>>();
		for (const unit of data.units) {
			if (unit.assemblySessionId) {
				const records = data.completedStepsBySession[unit.assemblySessionId] ?? [];
				map.set(unit.id, new Set(records.map((r) => r.workInstructionStepId)));
			} else {
				map.set(unit.id, new Set());
			}
		}
		return map;
	});

	let currentCompletedStepIds = $derived(
		completedStepsByUnit.get(selectedUnitId) ?? new Set<string>()
	);

	let allUnitsCompleted = $derived(data.units.every((u) => u.status === 'completed'));
	let runStatus = $derived(
		data.run.status as 'approved' | 'in_progress' | 'paused' | 'completed' | 'cancelled'
	);

	// E-signature state
	let showCompletion = $state(false);
	let signPassword = $state('');
	let signing = $state(false);

	let runCompleted = $derived(!!(form?.completed && form.redirectTo));

	// Cancel run state
	let showCancelConfirm = $state(false);
	let cancelPassword = $state('');
	let cancelReason = $state('');
	let cancelling = $state(false);
	let runCancelled = $derived(!!(form?.cancelled && form.redirectTo));

	// Auto-open cancel modal if navigated with ?cancel=true
	$effect(() => {
		if ($page.url.searchParams.get('cancel') === 'true') {
			showCancelConfirm = true;
		}
	});

	// Auto-start unit when selected (if pending)
	let startingUnit = $state(false);
	let scanFormElement: HTMLFormElement | undefined = $state();

	function handleUnitSelect(unitId: string) {
		selectedUnitId = unitId;
		const unit = data.units.find((u) => u.id === unitId);
		if (unit && unit.status === 'pending' && !startingUnit) {
			startingUnit = true;
		}
	}

	function handleScan(barcode: string, stepId: string, partDefinitionId: string) {
		if (!scanFormElement || !selectedUnit) return;
		const barcodeInput = scanFormElement.querySelector('input[name="barcode"]') as HTMLInputElement;
		const partDefInput = scanFormElement.querySelector(
			'input[name="partDefinitionId"]'
		) as HTMLInputElement;
		const stepInput = scanFormElement.querySelector(
			'input[name="workInstructionStepId"]'
		) as HTMLInputElement;
		const unitInput = scanFormElement.querySelector('input[name="unitId"]') as HTMLInputElement;
		if (barcodeInput) barcodeInput.value = barcode;
		if (partDefInput) partDefInput.value = partDefinitionId;
		if (stepInput) stepInput.value = stepId;
		if (unitInput) unitInput.value = selectedUnit.id;
		scanFormElement.requestSubmit();
	}
</script>

<div class="operator-view">
	<!-- Run Progress Header -->
	<RunProgressHeader
		runNumber={data.run.runNumber}
		workInstructionTitle={data.workInstructionTitle}
		leadBuilder={data.leadBuilderName}
		status={runStatus}
		progress={data.progress}
		startedAt={data.run.startedAt}
	/>

	<!-- Unit Tab Bar -->
	<UnitTabBar
		units={data.units.map((u) => ({
			id: u.id,
			unitIndex: u.unitIndex,
			udi: u.udi,
			status: u.status as 'pending' | 'in_progress' | 'completed' | 'cancelled'
		}))}
		{selectedUnitId}
		onSelect={handleUnitSelect}
	/>

	<!-- Auto-start unit form (hidden) -->
	{#if startingUnit && selectedUnit?.status === 'pending'}
		<form
			method="POST"
			action="?/startUnit"
			use:enhance={() => {
				return async ({ update }) => {
					startingUnit = false;
					await update();
				};
			}}
		>
			<input type="hidden" name="unitId" value={selectedUnitId} />
			<button type="submit" class="auto-start-btn"> Starting unit... </button>
		</form>
	{/if}

	<!-- Main Step View -->
	{#if selectedUnit}
		{#if selectedUnit.status === 'pending' && !startingUnit}
			<div class="pending-prompt tron-card">
				<p class="pending-text">Select this unit to begin assembly</p>
				<form
					method="POST"
					action="?/startUnit"
					use:enhance={() => {
						startingUnit = true;
						return async ({ update }) => {
							startingUnit = false;
							await update();
						};
					}}
				>
					<input type="hidden" name="unitId" value={selectedUnitId} />
					<button type="submit" class="start-unit-btn">
						Start Unit {selectedUnit.unitIndex}
					</button>
				</form>
			</div>
		{:else}
			<UnitStepView
				unit={{
					id: selectedUnit.id,
					udi: selectedUnit.udi,
					status: selectedUnit.status as 'pending' | 'in_progress' | 'completed'
				}}
				steps={data.steps}
				completedStepIds={currentCompletedStepIds}
				onScan={handleScan}
			/>

			<!-- Complete Unit button (when all steps done for this unit) -->
			{#if selectedUnit.status === 'in_progress' && currentCompletedStepIds.size >= data.steps.length}
				<form method="POST" action="?/completeUnit" use:enhance>
					<input type="hidden" name="unitId" value={selectedUnitId} />
					<button type="submit" class="complete-unit-btn">
						Complete Unit {selectedUnit.unitIndex}
					</button>
				</form>
			{/if}
		{/if}
	{/if}

	<!-- Hidden scan form -->
	<form
		bind:this={scanFormElement}
		method="POST"
		action="?/scanPart"
		use:enhance={() => {
			return async ({ update }) => {
				await update();
			};
		}}
		class="hidden-form"
	>
		<input type="hidden" name="barcode" value="" />
		<input type="hidden" name="partDefinitionId" value="" />
		<input type="hidden" name="workInstructionStepId" value="" />
		<input type="hidden" name="unitId" value="" />
	</form>

	<!-- Error Display -->
	{#if form?.error}
		<div class="error-banner">
			<p>{form.error}</p>
		</div>
	{/if}

	<!-- Run Controls (Pause / Resume) -->
	{#if runStatus === 'in_progress'}
		<form method="POST" action="?/pauseRun" use:enhance>
			<button type="submit" class="control-btn pause-btn"> Pause Run </button>
		</form>
	{:else if runStatus === 'paused'}
		<form method="POST" action="?/resumeRun" use:enhance>
			<button type="submit" class="control-btn resume-btn"> Resume Run </button>
		</form>
	{/if}

	<!-- Cancel Production Run -->
	{#if runStatus !== 'completed' && runStatus !== 'cancelled' && !runCompleted && !runCancelled}
		{#if !showCancelConfirm}
			<button class="cancel-run-btn" onclick={() => (showCancelConfirm = true)}>
				Cancel Production Run
			</button>
		{:else}
			<div class="tron-card cancellation-section">
				<h3 class="cancellation-title">Cancel Production Run</h3>
				<p class="cancellation-warning">
					This will cancel all units, retract inventory deductions, and reset SPUs to draft.
					This action cannot be undone.
				</p>

				<form
					method="POST"
					action="?/cancelRun"
					use:enhance={() => {
						cancelling = true;
						return async ({ update }) => {
							cancelling = false;
							await update();
						};
					}}
				>
					<label class="cancel-field-label" for="cancel-reason">
						Reason for cancellation
					</label>
					<textarea
						id="cancel-reason"
						name="reason"
						class="tron-input cancel-reason-input"
						placeholder="Explain why this run is being cancelled..."
						bind:value={cancelReason}
						required
						rows="2"
					></textarea>

					<label class="cancel-field-label" for="cancel-password">
						Enter password to confirm cancellation
					</label>
					<input
						id="cancel-password"
						type="password"
						name="password"
						class="tron-input cancel-password-input"
						placeholder="Password"
						bind:value={cancelPassword}
						required
					/>

					{#if form?.cancelError}
						<p class="cancel-error">{form.cancelError}</p>
					{/if}

					<div class="cancellation-actions">
						<button
							type="button"
							class="cancel-dismiss-btn"
							onclick={() => (showCancelConfirm = false)}
						>
							Go Back
						</button>
						<button
							type="submit"
							class="cancel-confirm-btn"
							disabled={cancelling || !cancelPassword || !cancelReason}
						>
							{cancelling ? 'Cancelling...' : 'Confirm Cancellation'}
						</button>
					</div>
				</form>
			</div>
		{/if}
	{/if}

	<!-- Cancelled Run Success State -->
	{#if runCancelled}
		<div class="tron-card cancellation-success">
			<div class="cancel-icon">&#x2717;</div>
			<h3 class="cancel-success-title">Production Run Cancelled</h3>
			<p class="cancel-success-subtitle">
				{data.run.runNumber} has been cancelled. Inventory deductions have been retracted.
			</p>
			<a href={form?.redirectTo} class="back-to-wi-btn"> View Work Instruction </a>
		</div>
	{/if}

	<!-- Completed Run Success State -->
	{#if runCompleted}
		<div class="tron-card completion-success">
			<div class="success-icon">&#x2713;</div>
			<h3 class="success-title">Production Run Completed</h3>
			<p class="success-subtitle">
				{data.run.runNumber} has been signed and completed successfully.
			</p>
			<div class="completion-summary">
				<div class="summary-row">
					<span class="summary-label">Run</span>
					<span class="summary-value mono">{data.run.runNumber}</span>
				</div>
				<div class="summary-row">
					<span class="summary-label">Work Instruction</span>
					<span class="summary-value">{data.workInstructionTitle}</span>
				</div>
				<div class="summary-row">
					<span class="summary-label">Quantity</span>
					<span class="summary-value">{data.run.quantity} units</span>
				</div>
				<div class="summary-row">
					<span class="summary-label">Lead Builder</span>
					<span class="summary-value">{data.leadBuilderName}</span>
				</div>
			</div>
			<a href={form?.redirectTo as string} class="back-to-wi-btn"> View Work Instruction </a>
		</div>
	{/if}

	<!-- Complete Production Run (when all units done) -->
	{#if allUnitsCompleted && runStatus !== 'completed' && !runCompleted}
		{#if !showCompletion}
			<button class="complete-run-btn" onclick={() => (showCompletion = true)}>
				Complete Production Run
			</button>
		{:else}
			<div class="tron-card completion-section">
				<h3 class="completion-title">Complete Production Run</h3>

				<div class="completion-summary">
					<div class="summary-row">
						<span class="summary-label">Run</span>
						<span class="summary-value mono">{data.run.runNumber}</span>
					</div>
					<div class="summary-row">
						<span class="summary-label">Work Instruction</span>
						<span class="summary-value">{data.workInstructionTitle}</span>
					</div>
					<div class="summary-row">
						<span class="summary-label">Quantity</span>
						<span class="summary-value">{data.run.quantity} units</span>
					</div>
					<div class="summary-row">
						<span class="summary-label">Lead Builder</span>
						<span class="summary-value">{data.leadBuilderName}</span>
					</div>
					{#if data.run.startedAt}
						<div class="summary-row">
							<span class="summary-label">Started</span>
							<span class="summary-value">{new Date(data.run.startedAt).toLocaleString()}</span>
						</div>
					{/if}
				</div>

				<div class="units-summary">
					<h4 class="section-label">Units</h4>
					{#each data.units as unit (unit.id)}
						<div class="unit-row">
							<span class="unit-udi mono">{unit.udi}</span>
							<span class="unit-timestamp">
								{#if unit.completedAt}
									{new Date(unit.completedAt).toLocaleTimeString()}
								{/if}
							</span>
							<span class="unit-check">&#x2713;</span>
						</div>
					{/each}
				</div>

				<form
					method="POST"
					action="?/signUnit"
					use:enhance={() => {
						signing = true;
						return async ({ update }) => {
							signing = false;
							await update();
						};
					}}
				>
					<label class="password-label" for="sign-password">
						Enter password to sign and complete
					</label>
					<input
						id="sign-password"
						type="password"
						name="password"
						class="tron-input password-input"
						placeholder="Password"
						bind:value={signPassword}
						required
					/>

					{#if form?.error && !form?.completed}
						<p class="sign-error">{form.error}</p>
					{/if}

					<div class="completion-actions">
						<button type="button" class="cancel-btn" onclick={() => (showCompletion = false)}>
							Cancel
						</button>
						<button type="submit" class="sign-btn" disabled={signing || !signPassword}>
							{signing ? 'Signing...' : 'Sign and Complete Run'}
						</button>
					</div>
				</form>
			</div>
		{/if}
	{/if}

	<!-- Back link -->
	<a href="/documents/instructions/{data.run.workInstructionId}" class="back-link">
		&larr; Back to Work Instruction
	</a>
</div>

<style>
	.operator-view {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		max-width: 960px;
		margin: 0 auto;
		padding: 1rem;
	}

	.hidden-form {
		display: none;
	}

	/* Pending prompt */
	.pending-prompt {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1rem;
		padding: 2rem;
		text-align: center;
	}

	.pending-text {
		font-size: 1rem;
		color: var(--color-tron-text-secondary);
	}

	.start-unit-btn {
		min-height: 44px;
		padding: 0.75rem 2rem;
		border: 1px solid var(--color-tron-cyan);
		border-radius: 0.5rem;
		background-color: rgba(0, 212, 255, 0.1);
		color: var(--color-tron-cyan);
		font-weight: 600;
		font-size: 1rem;
		cursor: pointer;
		transition: background-color 0.15s;
	}

	.start-unit-btn:hover {
		background-color: rgba(0, 212, 255, 0.2);
	}

	.auto-start-btn {
		min-height: 44px;
		padding: 0.75rem 2rem;
		border: 1px solid var(--color-tron-cyan);
		border-radius: 0.5rem;
		background-color: rgba(0, 212, 255, 0.1);
		color: var(--color-tron-cyan);
		font-weight: 600;
		font-size: 0.875rem;
		cursor: default;
		animation: tron-pulse 2s ease-in-out infinite;
	}

	/* Complete unit button */
	.complete-unit-btn {
		min-height: 44px;
		padding: 0.75rem 2rem;
		border: 1px solid var(--color-tron-green);
		border-radius: 0.5rem;
		background-color: rgba(0, 255, 136, 0.1);
		color: var(--color-tron-green);
		font-weight: 600;
		font-size: 1rem;
		cursor: pointer;
		width: 100%;
		transition: background-color 0.15s;
	}

	.complete-unit-btn:hover {
		background-color: rgba(0, 255, 136, 0.2);
	}

	/* Error banner */
	.error-banner {
		padding: 0.75rem 1rem;
		border: 1px solid var(--color-tron-red);
		border-radius: 0.5rem;
		background-color: rgba(255, 51, 102, 0.1);
		color: var(--color-tron-red);
		font-size: 0.875rem;
	}

	.error-banner p {
		margin: 0;
	}

	/* Run controls */
	.control-btn {
		min-height: 44px;
		padding: 0.75rem 2rem;
		border-radius: 0.5rem;
		font-weight: 600;
		font-size: 1rem;
		cursor: pointer;
		width: 100%;
		transition: background-color 0.15s;
	}

	.pause-btn {
		border: 1px solid var(--color-tron-orange);
		background-color: rgba(251, 191, 36, 0.1);
		color: var(--color-tron-orange);
	}

	.pause-btn:hover {
		background-color: rgba(251, 191, 36, 0.2);
	}

	.resume-btn {
		border: 1px solid var(--color-tron-cyan);
		background-color: rgba(0, 212, 255, 0.1);
		color: var(--color-tron-cyan);
	}

	.resume-btn:hover {
		background-color: rgba(0, 212, 255, 0.2);
	}

	/* Complete run button */
	.complete-run-btn {
		min-height: 44px;
		padding: 0.75rem 2rem;
		border: 2px solid var(--color-tron-green);
		border-radius: 0.5rem;
		background-color: rgba(0, 255, 136, 0.15);
		color: var(--color-tron-green);
		font-weight: 700;
		font-size: 1.125rem;
		cursor: pointer;
		width: 100%;
		transition: background-color 0.15s;
	}

	.complete-run-btn:hover {
		background-color: rgba(0, 255, 136, 0.25);
	}

	/* Completion section */
	.completion-section {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}

	.completion-title {
		margin: 0;
		font-size: 1.25rem;
		font-weight: 700;
		color: var(--color-tron-green);
	}

	.completion-summary {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.summary-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.375rem 0;
		border-bottom: 1px solid var(--color-tron-border);
	}

	.summary-label {
		font-size: 0.875rem;
		color: var(--color-tron-text-secondary);
	}

	.summary-value {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--color-tron-text-primary);
	}

	.summary-value.mono {
		font-family: monospace;
		color: var(--color-tron-cyan);
	}

	.units-summary {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	.section-label {
		margin: 0;
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--color-tron-text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.unit-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.375rem 0.5rem;
		border-radius: 0.25rem;
		background-color: var(--color-tron-bg-tertiary);
	}

	.unit-udi {
		font-size: 0.8125rem;
		color: var(--color-tron-text-primary);
	}

	.unit-udi.mono {
		font-family: monospace;
	}

	.unit-timestamp {
		font-size: 0.75rem;
		color: var(--color-tron-text-secondary);
		font-family: monospace;
	}

	.unit-check {
		color: var(--color-tron-green);
		font-weight: 700;
	}

	/* Password / signing */
	.password-label {
		display: block;
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--color-tron-text-secondary);
		margin-bottom: 0.5rem;
	}

	.password-input {
		width: 100%;
		margin-bottom: 0.75rem;
	}

	.sign-error {
		margin: 0 0 0.75rem;
		font-size: 0.875rem;
		color: var(--color-tron-red);
	}

	.completion-actions {
		display: flex;
		gap: 0.75rem;
	}

	.cancel-btn {
		flex: 1;
		min-height: 44px;
		padding: 0.75rem 1rem;
		border: 1px solid var(--color-tron-border);
		border-radius: 0.5rem;
		background-color: var(--color-tron-bg-tertiary);
		color: var(--color-tron-text-primary);
		font-weight: 500;
		cursor: pointer;
		transition: border-color 0.15s;
	}

	.cancel-btn:hover {
		border-color: var(--color-tron-text-secondary);
	}

	.sign-btn {
		flex: 2;
		min-height: 44px;
		padding: 0.75rem 1rem;
		border: 2px solid var(--color-tron-green);
		border-radius: 0.5rem;
		background-color: rgba(0, 255, 136, 0.15);
		color: var(--color-tron-green);
		font-weight: 700;
		font-size: 1rem;
		cursor: pointer;
		transition: background-color 0.15s;
	}

	.sign-btn:hover:not(:disabled) {
		background-color: rgba(0, 255, 136, 0.25);
	}

	.sign-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* Completion success state */
	.completion-success {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1rem;
		text-align: center;
		border-color: var(--color-tron-green);
	}

	.success-icon {
		width: 56px;
		height: 56px;
		border-radius: 50%;
		border: 2px solid var(--color-tron-green);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 1.75rem;
		color: var(--color-tron-green);
		font-weight: 700;
	}

	.success-title {
		margin: 0;
		font-size: 1.25rem;
		font-weight: 700;
		color: var(--color-tron-green);
	}

	.success-subtitle {
		margin: 0;
		font-size: 0.875rem;
		color: var(--color-tron-text-secondary);
	}

	.completion-success .completion-summary {
		width: 100%;
		text-align: left;
	}

	.back-to-wi-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 44px;
		padding: 0.75rem 2rem;
		border: 1px solid var(--color-tron-cyan);
		border-radius: 0.5rem;
		background-color: rgba(0, 212, 255, 0.1);
		color: var(--color-tron-cyan);
		font-weight: 600;
		font-size: 1rem;
		text-decoration: none;
		cursor: pointer;
		transition: background-color 0.15s;
	}

	.back-to-wi-btn:hover {
		background-color: rgba(0, 212, 255, 0.2);
	}

	/* Cancel run button */
	.cancel-run-btn {
		min-height: 44px;
		padding: 0.75rem 2rem;
		border: 1px solid var(--color-tron-red);
		border-radius: 0.5rem;
		background-color: rgba(255, 51, 102, 0.1);
		color: var(--color-tron-red);
		font-weight: 600;
		font-size: 1rem;
		cursor: pointer;
		width: 100%;
		transition: background-color 0.15s;
	}

	.cancel-run-btn:hover {
		background-color: rgba(255, 51, 102, 0.2);
	}

	/* Cancellation section */
	.cancellation-section {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		border-color: var(--color-tron-red);
	}

	.cancellation-title {
		margin: 0;
		font-size: 1.25rem;
		font-weight: 700;
		color: var(--color-tron-red);
	}

	.cancellation-warning {
		margin: 0;
		font-size: 0.875rem;
		color: var(--color-tron-text-secondary);
	}

	.cancel-field-label {
		display: block;
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--color-tron-text-secondary);
		margin-bottom: 0.375rem;
	}

	.cancel-reason-input {
		width: 100%;
		margin-bottom: 0.75rem;
		resize: vertical;
	}

	.cancel-password-input {
		width: 100%;
		margin-bottom: 0.75rem;
	}

	.cancel-error {
		margin: 0 0 0.75rem;
		font-size: 0.875rem;
		color: var(--color-tron-red);
	}

	.cancellation-actions {
		display: flex;
		gap: 0.75rem;
	}

	.cancel-dismiss-btn {
		flex: 1;
		min-height: 44px;
		padding: 0.75rem 1rem;
		border: 1px solid var(--color-tron-border);
		border-radius: 0.5rem;
		background-color: var(--color-tron-bg-tertiary);
		color: var(--color-tron-text-primary);
		font-weight: 500;
		cursor: pointer;
	}

	.cancel-confirm-btn {
		flex: 2;
		min-height: 44px;
		padding: 0.75rem 1rem;
		border: 2px solid var(--color-tron-red);
		border-radius: 0.5rem;
		background-color: rgba(255, 51, 102, 0.15);
		color: var(--color-tron-red);
		font-weight: 700;
		font-size: 1rem;
		cursor: pointer;
	}

	.cancel-confirm-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* Cancellation success */
	.cancellation-success {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1rem;
		text-align: center;
		border-color: var(--color-tron-red);
	}

	.cancel-icon {
		width: 56px;
		height: 56px;
		border-radius: 50%;
		border: 2px solid var(--color-tron-red);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 1.75rem;
		color: var(--color-tron-red);
		font-weight: 700;
	}

	.cancel-success-title {
		margin: 0;
		font-size: 1.25rem;
		font-weight: 700;
		color: var(--color-tron-red);
	}

	.cancel-success-subtitle {
		margin: 0;
		font-size: 0.875rem;
		color: var(--color-tron-text-secondary);
	}

	/* Back link */
	.back-link {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.5rem 0;
		font-size: 0.875rem;
		color: var(--color-tron-text-secondary);
		text-decoration: none;
		transition: color 0.15s;
	}

	.back-link:hover {
		color: var(--color-tron-cyan);
	}
</style>
