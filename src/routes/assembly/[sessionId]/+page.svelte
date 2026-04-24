<!-- Unfrozen per PRD-SPU-MFG-UNIFIED §9 Q1 — sequential lock + admin edit requires UI-layer changes scoped to this file. -->
<script lang="ts">
	import { enhance } from '$app/forms';
	import { TronCard, TronButton } from '$lib/components/ui';
	import ScanInput from '$lib/components/assembly/ScanInput.svelte';
	import AssemblyProgress from '$lib/components/assembly/AssemblyProgress.svelte';
	import PartCard from '$lib/components/assembly/PartCard.svelte';

	interface FieldDefinition {
		id: string;
		fieldName: string;
		fieldLabel: string;
		fieldType: string;
		isRequired: boolean;
		validationPattern: string | null;
		options: unknown;
		barcodeFieldMapping: string | null;
		sortOrder: number;
		currentValue?: string | null;
		captureId?: string | null;
		isLocked?: boolean;
		editableByAdmin?: boolean;
	}

	let { data, form } = $props();

	// Custom field capture state (PRD-WINSTX)
	let customFieldValues = $state<Record<string, string>>({});
	let customFieldSubmitting = $state<string | null>(null);
	let customFieldBomLinked = $state<Record<string, boolean>>({});

	// PRD-INVWI: Track inventory changes after scan
	let inventoryChanges = $state<Record<string, { previousQuantity: number; newQuantity: number }>>(
		{}
	);

	let formElement: HTMLFormElement | undefined = $state();

	// Work instruction mode: use work instruction steps if available
	let hasWorkInstructions = $derived(data.workInstructionSteps.length > 0);

	// For work instruction mode
	let currentWiStepIndex = $derived(() => {
		if (!hasWorkInstructions) return 0;
		// Find first incomplete step
		const completedStepIds = new Set(data.completedStepRecords.map((r) => r.workInstructionStepId));
		const index = data.workInstructionSteps.findIndex((s) => !completedStepIds.has(s.id));
		return index === -1 ? data.workInstructionSteps.length : index;
	});
	let currentWiStep = $derived(
		hasWorkInstructions ? data.workInstructionSteps[currentWiStepIndex()] : null
	);

	// For parts-only mode (fallback)
	let currentPartIndex = $derived(data.session.currentStepIndex);
	let currentPart = $derived(data.parts[currentPartIndex]);

	// Progress steps
	let steps = $derived(
		hasWorkInstructions
			? data.workInstructionSteps.map((s) => ({ name: s.title || `Step ${s.stepNumber}` }))
			: data.parts.map((p) => ({ name: p.name }))
	);
	let currentStepForProgress = $derived(
		hasWorkInstructions ? currentWiStepIndex() : currentPartIndex
	);
	let totalSteps = $derived(
		hasWorkInstructions ? data.workInstructionSteps.length : data.parts.length
	);

	let elapsedSeconds = $state(0);

	// Track elapsed time
	$effect(() => {
		const startTime = new Date(data.session.startedAt).getTime();
		const interval = setInterval(() => {
			elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
		}, 1000);
		return () => clearInterval(interval);
	});

	// SPU-MFG-03: field input refs keyed by field.id, and admin edit dialog state.
	let fieldInputRefs = $state<Record<string, HTMLInputElement | HTMLSelectElement | null>>({});
	let editingFieldId = $state<string | null>(null);
	let editNewValue = $state<Record<string, string>>({});
	let editReason = $state<Record<string, string>>({});

	// SPU-MFG-03: auto-focus the first unlocked+unfilled field on mount and after updates.
	$effect(() => {
		const focusStepIdx = (data.session as any)?.focusStepIndex ?? 0;
		const focusFieldIdx = (data.session as any)?.focusFieldIndex ?? 0;
		const steps = data.workInstructionSteps ?? [];
		const step = steps[focusStepIdx];
		if (!step) return;
		const fields = step.fieldDefinitions ?? [];
		const target = fields[focusFieldIdx];
		if (!target) return;
		const el = fieldInputRefs[target.id];
		if (el && typeof el.focus === 'function') {
			// Defer to next microtask to ensure DOM mount is complete.
			queueMicrotask(() => el.focus());
		}
	});

	function formatTime(seconds: number): string {
		const mins = Math.floor(seconds / 60);
		const secs = seconds % 60;
		return `${mins}:${secs.toString().padStart(2, '0')}`;
	}

	function isPartScanned(partId: string): boolean {
		return data.scannedParts.some((sp) => sp.partDefinitionId === partId);
	}

	function getPartLotNumber(partId: string): string | undefined {
		return data.scannedParts.find((sp) => sp.partDefinitionId === partId)?.lotNumber ?? undefined;
	}

	function isWiStepCompleted(stepId: string): boolean {
		return data.completedStepRecords.some((r) => r.workInstructionStepId === stepId);
	}

	function getWiStepScanData(
		stepId: string
	): { lotNumber: string | null; partNumber: string | null } | null {
		const record = data.completedStepRecords.find((r) => r.workInstructionStepId === stepId);
		return record
			? { lotNumber: record.scannedLotNumber, partNumber: record.scannedPartNumber }
			: null;
	}

	// Get the part definition for a part number in work instruction
	function getPartDefinitionForNumber(partNumber: string) {
		return (
			data.parts.find(
				(p) => p.partNumber.toLowerCase() === partNumber.toLowerCase().replace('pt-', '')
			) ?? data.parts[0]
		);
	}

	function handleScan(barcode: string) {
		if (!formElement) return;

		const barcodeInput = formElement.querySelector('input[name="barcode"]') as HTMLInputElement;
		const partInput = formElement.querySelector(
			'input[name="partDefinitionId"]'
		) as HTMLInputElement;
		const wiStepInput = formElement.querySelector(
			'input[name="workInstructionStepId"]'
		) as HTMLInputElement;

		if (barcodeInput && partInput) {
			barcodeInput.value = barcode;

			if (hasWorkInstructions && currentWiStep) {
				// Work instruction mode
				const firstPartReq = currentWiStep.partRequirements[0];
				const partDef = firstPartReq
					? getPartDefinitionForNumber(firstPartReq.partNumber)
					: data.parts[0];
				partInput.value = partDef?.id ?? '';
				if (wiStepInput) {
					wiStepInput.value = currentWiStep.id;
				}
			} else if (currentPart) {
				// Parts-only mode
				partInput.value = currentPart.id;
			}

			formElement.requestSubmit();
		}
	}

	// Custom Field Functions (PRD-WINSTX)
	function getCustomFieldsForStep(stepId: string): FieldDefinition[] {
		const step = data.workInstructionSteps.find((s) => s.id === stepId);
		return step?.fieldDefinitions ?? [];
	}

	function isCustomFieldCaptured(fieldDefId: string): boolean {
		return data.capturedFieldRecords.some((r) => r.stepFieldDefinitionId === fieldDefId);
	}

	function getCapturedFieldValue(fieldDefId: string): string | null {
		const record = data.capturedFieldRecords.find((r) => r.stepFieldDefinitionId === fieldDefId);
		return record?.fieldValue ?? null;
	}

	function isFieldBomLinked(fieldDefId: string): boolean {
		const record = data.capturedFieldRecords.find((r) => r.stepFieldDefinitionId === fieldDefId);
		return !!record?.bomItemId;
	}

	function getFieldTypeIcon(fieldType: string): string {
		switch (fieldType) {
			case 'barcode_scan':
				return 'M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z';
			case 'manual_entry':
				return 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z';
			case 'date_picker':
				return 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z';
			case 'dropdown':
				return 'M19 9l-7 7-7-7';
			default:
				return 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z';
		}
	}

	// Handle barcode scan for a custom field
	function handleCustomFieldScan(
		fieldDef: FieldDefinition,
		barcode: string,
		assemblyStepRecordId: string
	) {
		customFieldSubmitting = fieldDef.id;
		customFieldValues[fieldDef.id] = barcode;
	}

	// Check if all required custom fields for current step are captured
	let currentStepFieldsComplete = $derived(() => {
		if (!currentWiStep) return true;
		const fields = getCustomFieldsForStep(currentWiStep.id);
		const requiredFields = fields.filter((f) => f.isRequired);
		return requiredFields.every((f) => isCustomFieldCaptured(f.id));
	});

	// Get the assembly step record ID for the current step (needed for captureField)
	function getCurrentAssemblyStepRecordId(): string | null {
		if (!currentWiStep) return null;
		const record = data.completedStepRecords.find(
			(r) => r.workInstructionStepId === currentWiStep?.id
		);
		// If step not complete, we need to check if there's a pending record
		// For now, return null if step not started
		return record ? currentWiStep.id : null;
	}

	// PRD-INVWI: Get inventory change for a part (if scanned with inventory deduction)
	function getInventoryChange(
		partId: string
	): { previousQuantity: number; newQuantity: number } | null {
		return inventoryChanges[partId] ?? null;
	}

	// PRD-INVWI: Get quantity to deduct for current part (based on work instruction step)
	function getQuantityToDeduct(partId: string): number {
		if (hasWorkInstructions && currentWiStep) {
			const partReq = currentWiStep.partRequirements.find(
				(r) => getPartDefinitionForNumber(r.partNumber)?.id === partId
			);
			return partReq?.quantity ?? 1;
		}
		return 1;
	}

	// PRD-INVWI: Handle scan form response
	function handleScanResult(result: {
		type: string;
		data?: {
			inventoryDeduction?: { previousQuantity: number; newQuantity: number };
			partDefinitionId?: string;
		};
	}) {
		if (result.type === 'success' && result.data?.inventoryDeduction) {
			const partId = currentPart?.id ?? '';
			if (partId) {
				inventoryChanges[partId] = {
					previousQuantity: result.data.inventoryDeduction.previousQuantity!,
					newQuantity: result.data.inventoryDeduction.newQuantity!
				};
			}
		}
	}
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<h2 class="tron-text-primary text-xl font-bold">Assembly in Progress</h2>
			<p class="tron-text-muted font-mono text-sm">{data.spu.udi}</p>
			{#if data.workInstruction}
				<p class="mt-1 text-xs text-[var(--color-tron-cyan)]">
					Work Instruction: {data.workInstruction.documentNumber}
				</p>
			{/if}
		</div>
		<div class="flex items-center gap-4">
			<div class="text-right">
				<div class="tron-text-primary font-mono text-2xl">{formatTime(elapsedSeconds)}</div>
				<div class="tron-text-muted text-xs">Elapsed Time</div>
			</div>
			<form method="POST" action="?/pause" use:enhance>
				<TronButton type="submit">Pause</TronButton>
			</form>
		</div>
	</div>

	<TronCard>
		<AssemblyProgress currentStep={currentStepForProgress} {totalSteps} {steps} />
	</TronCard>

	<!-- Work Instruction Mode -->
	{#if hasWorkInstructions && currentWiStep}
		<TronCard class="border-[var(--color-tron-cyan)]">
			<div class="mb-4 flex items-center justify-between">
				<h3 class="tron-text-primary text-lg font-medium">
					Step {currentWiStep.stepNumber}: {currentWiStep.title || 'Work Instruction Step'}
				</h3>
				<span
					class="rounded-full bg-[var(--color-tron-cyan)]/20 px-3 py-1 text-xs font-medium text-[var(--color-tron-cyan)]"
				>
					{currentWiStepIndex() + 1} of {data.workInstructionSteps.length}
				</span>
			</div>

			<!-- Step Content -->
			{#if currentWiStep.content}
				<div
					class="mb-4 rounded-lg bg-[var(--color-tron-bg-tertiary)] p-4 text-sm leading-relaxed whitespace-pre-wrap"
				>
					<p class="tron-text-secondary">{currentWiStep.content}</p>
				</div>
			{/if}

			<!-- Required Parts for this step -->
			{#if currentWiStep.partRequirements.length > 0}
				<div class="mb-4">
					<h4 class="tron-text-muted mb-2 text-sm font-medium">Required Parts</h4>
					<div class="flex flex-wrap gap-2">
						{#each currentWiStep.partRequirements as partReq (partReq.id)}
							<span
								class="rounded bg-[var(--color-tron-cyan)]/10 px-2 py-1 font-mono text-sm text-[var(--color-tron-cyan)]"
							>
								{partReq.partNumber} × {partReq.quantity}
							</span>
						{/each}
					</div>
				</div>
			{/if}

			<!-- Scan Prompt -->
			{#if currentWiStep.requiresScan && currentWiStep.scanPrompt}
				<div
					class="mb-4 flex items-center gap-3 rounded-lg border border-[var(--color-tron-green)]/30 bg-[var(--color-tron-green)]/10 p-4"
				>
					<svg
						class="h-6 w-6 shrink-0 text-[var(--color-tron-green)]"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"
						/>
					</svg>
					<span class="font-medium text-[var(--color-tron-green)]">{currentWiStep.scanPrompt}</span>
				</div>
			{/if}

			<!-- Custom Fields (PRD-WINSTX) -->
			{@const customFields = getCustomFieldsForStep(currentWiStep.id)}
			{#if customFields.length > 0}
				<div class="mb-4 space-y-4">
					<h4 class="tron-text-muted flex items-center gap-2 text-sm font-medium">
						<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"
							/>
						</svg>
						Data Capture Fields
					</h4>
					{#each customFields as field (field.id)}
						{@const isCaptured = isCustomFieldCaptured(field.id)}
						{@const capturedValue = getCapturedFieldValue(field.id)}
						{@const bomLinked = isFieldBomLinked(field.id)}
						<div
							class="rounded-lg border p-4 transition-all {isCaptured
								? 'border-[var(--color-tron-green)]/50 bg-[var(--color-tron-green)]/5'
								: 'border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)]'}"
						>
							<div class="mb-2 flex items-center justify-between">
								<div class="flex items-center gap-2">
									<svg
										class="h-5 w-5 text-[var(--color-tron-cyan)]"
										fill="none"
										viewBox="0 0 24 24"
										stroke="currentColor"
									>
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d={getFieldTypeIcon(field.fieldType)}
										/>
									</svg>
									<span class="tron-text-primary font-medium">{field.fieldLabel}</span>
									{#if field.isRequired}
										<span class="text-xs text-[var(--color-tron-red)]">*</span>
									{/if}
								</div>
								{#if isCaptured}
									<div class="flex items-center gap-2">
										{#if bomLinked}
											<span
												class="rounded bg-[var(--color-tron-cyan)]/20 px-2 py-0.5 text-xs text-[var(--color-tron-cyan)]"
											>
												BOM Linked
											</span>
										{/if}
										<svg
											class="h-5 w-5 text-[var(--color-tron-green)]"
											fill="none"
											viewBox="0 0 24 24"
											stroke="currentColor"
										>
											<path
												stroke-linecap="round"
												stroke-linejoin="round"
												stroke-width="2"
												d="M5 13l4 4L19 7"
											/>
										</svg>
									</div>
								{/if}
							</div>

							{#if isCaptured && capturedValue}
								<!-- Show captured value -->
								<div class="flex items-center gap-2">
									<div class="flex-1 rounded bg-[var(--color-tron-bg-secondary)] p-2">
										<p class="font-mono text-sm text-[var(--color-tron-green)]">{capturedValue}</p>
									</div>
									{#if field.editableByAdmin}
										<button
											type="button"
											class="rounded border border-[var(--color-tron-cyan)] px-2 py-1 text-xs text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10"
											onclick={() => {
												editingFieldId = editingFieldId === field.id ? null : field.id;
												if (editingFieldId === field.id) {
													editNewValue[field.id] = capturedValue ?? '';
													editReason[field.id] = '';
												}
											}}
											aria-label="Edit captured field (admin)"
										>
											Edit
										</button>
									{/if}
								</div>
								{#if field.editableByAdmin && editingFieldId === field.id}
									<form
										method="POST"
										action="?/editField"
										use:enhance
										class="mt-2 space-y-2 rounded border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-bg-tertiary)] p-3"
									>
										<input type="hidden" name="fieldRecordId" value={field.captureId ?? ''} />
										<input type="hidden" name="stepFieldDefinitionId" value={field.id} />
										<div>
											<label class="tron-text-muted mb-1 block text-xs" for="edit-new-{field.id}"
												>New Value</label
											>
											<input
												id="edit-new-{field.id}"
												type="text"
												name="newValue"
												class="tron-input w-full"
												bind:value={editNewValue[field.id]}
												required
											/>
										</div>
										<div>
											<label class="tron-text-muted mb-1 block text-xs" for="edit-reason-{field.id}"
												>Reason</label
											>
											<textarea
												id="edit-reason-{field.id}"
												name="reason"
												class="tron-input w-full"
												rows="2"
												bind:value={editReason[field.id]}
												required
											></textarea>
										</div>
										<div class="flex justify-end gap-2">
											<button
												type="button"
												class="rounded border border-[var(--color-tron-border)] px-3 py-1 text-xs"
												onclick={() => (editingFieldId = null)}
											>
												Cancel
											</button>
											<button type="submit" class="tron-btn-primary text-xs">Save</button>
										</div>
										{#if form?.error}
											<p class="text-xs text-[var(--color-tron-red)]">{form.error}</p>
										{/if}
									</form>
								{/if}
							{:else}
								<!-- Input for capturing -->
								<form
									method="POST"
									action="?/captureField"
									use:enhance={() => {
										customFieldSubmitting = field.id;
										return async ({ result, update }) => {
											customFieldSubmitting = null;
											if (result.type === 'success' && result.data?.bomItemLinked) {
												customFieldBomLinked[field.id] = true;
											}
											await update();
										};
									}}
								>
									<input
										type="hidden"
										name="assemblyStepRecordId"
										value={currentWiStep?.id ?? ''}
									/>
									<input type="hidden" name="stepFieldDefinitionId" value={field.id} />
									<input
										type="hidden"
										name="isBarcodeScan"
										value={field.fieldType === 'barcode_scan' ? 'true' : 'false'}
									/>

									{#if field.fieldType === 'barcode_scan'}
										<!-- Barcode scan input -->
										<div class="flex gap-2">
											<input
												type="text"
												name="rawValue"
												placeholder="Scan barcode or enter manually..."
												class="tron-input flex-1 {field.isLocked
													? 'cursor-not-allowed opacity-50'
													: ''}"
												bind:value={customFieldValues[field.id]}
												bind:this={fieldInputRefs[field.id]}
												disabled={field.isLocked}
												required={field.isRequired}
											/>
											<button
												type="submit"
												class="tron-btn-primary"
												disabled={customFieldSubmitting === field.id || field.isLocked}
											>
												{customFieldSubmitting === field.id ? 'Saving...' : 'Capture'}
											</button>
										</div>
										{#if field.barcodeFieldMapping}
											<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
												Extracts: {field.barcodeFieldMapping === 'lot'
													? 'Lot Number'
													: field.barcodeFieldMapping === 'serial'
														? 'Serial Number'
														: field.barcodeFieldMapping === 'expiry'
															? 'Expiry Date'
															: field.barcodeFieldMapping === 'gtin'
																? 'GTIN'
																: 'Part Number'}
											</p>
										{/if}
									{:else if field.fieldType === 'manual_entry'}
										<!-- Text input -->
										<div class="flex gap-2">
											<input
												type="text"
												name="rawValue"
												placeholder="Enter value..."
												class="tron-input flex-1 {field.isLocked
													? 'cursor-not-allowed opacity-50'
													: ''}"
												bind:value={customFieldValues[field.id]}
												bind:this={fieldInputRefs[field.id]}
												disabled={field.isLocked}
												required={field.isRequired}
											/>
											<button
												type="submit"
												class="tron-btn-primary"
												disabled={customFieldSubmitting === field.id || field.isLocked}
											>
												{customFieldSubmitting === field.id ? 'Saving...' : 'Save'}
											</button>
										</div>
									{:else if field.fieldType === 'date_picker'}
										<!-- Date input -->
										<div class="flex gap-2">
											<input
												type="date"
												name="rawValue"
												class="tron-input flex-1 {field.isLocked
													? 'cursor-not-allowed opacity-50'
													: ''}"
												bind:value={customFieldValues[field.id]}
												bind:this={fieldInputRefs[field.id]}
												disabled={field.isLocked}
												required={field.isRequired}
											/>
											<button
												type="submit"
												class="tron-btn-primary"
												disabled={customFieldSubmitting === field.id || field.isLocked}
											>
												{customFieldSubmitting === field.id ? 'Saving...' : 'Save'}
											</button>
										</div>
									{:else if field.fieldType === 'dropdown'}
										<!-- Dropdown select -->
										{@const options = Array.isArray(field.options) ? field.options : []}
										<div class="flex gap-2">
											<select
												name="rawValue"
												class="tron-select flex-1 {field.isLocked
													? 'cursor-not-allowed opacity-50'
													: ''}"
												bind:value={customFieldValues[field.id]}
												bind:this={fieldInputRefs[field.id]}
												disabled={field.isLocked}
												required={field.isRequired}
											>
												<option value="">Select...</option>
												{#each options as option}
													<option value={String(option)}>{option}</option>
												{/each}
											</select>
											<button
												type="submit"
												class="tron-btn-primary"
												disabled={customFieldSubmitting === field.id || field.isLocked}
											>
												{customFieldSubmitting === field.id ? 'Saving...' : 'Save'}
											</button>
										</div>
									{/if}
								</form>
							{/if}
						</div>
					{/each}
				</div>
			{/if}

			<!-- Scan Input -->
			<form
				bind:this={formElement}
				method="POST"
				action="?/scanPart"
				use:enhance={() => {
					return async ({ result, update }) => {
						if (result.type === 'success') {
							const data = result.data as
								| { inventoryDeduction?: { previousQuantity: number; newQuantity: number } }
								| undefined;
							if (data?.inventoryDeduction) {
								const firstPartReq = currentWiStep?.partRequirements[0];
								const partDef = firstPartReq
									? getPartDefinitionForNumber(firstPartReq.partNumber)
									: null;
								if (partDef) {
									inventoryChanges[partDef.id] = {
										previousQuantity: data.inventoryDeduction.previousQuantity,
										newQuantity: data.inventoryDeduction.newQuantity
									};
								}
							}
						}
						await update();
					};
				}}
			>
				<input type="hidden" name="barcode" />
				<input type="hidden" name="partDefinitionId" />
				<input type="hidden" name="workInstructionStepId" />
				<ScanInput
					label={currentWiStep.requiresScan ? 'Scan to Complete Step' : 'Scan Part Barcode'}
					placeholder="Scan barcode..."
					onScan={handleScan}
				/>
			</form>

			{#if form?.error}
				<div
					class="mt-4 rounded border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-3"
				>
					<p class="text-sm text-[var(--color-tron-red)]">{form.error}</p>
				</div>
			{/if}
		</TronCard>

		<!-- Work Instruction Steps List -->
		<TronCard>
			<h3 class="tron-text-primary mb-4 text-lg font-medium">Work Instruction Steps</h3>
			<div class="space-y-3">
				{#each data.workInstructionSteps as wiStep, index (wiStep.id)}
					{@const isCompleted = isWiStepCompleted(wiStep.id)}
					{@const isCurrent = index === currentWiStepIndex()}
					{@const scanData = getWiStepScanData(wiStep.id)}
					<div
						class="rounded-lg border p-3 transition-colors {isCurrent
							? 'border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/5'
							: isCompleted
								? 'border-[var(--color-tron-green)]/50 bg-[var(--color-tron-green)]/5'
								: 'border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)]'}"
					>
						<div class="flex items-start gap-3">
							<div
								class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold {isCurrent
									? 'bg-[var(--color-tron-cyan)] text-[var(--color-tron-bg-primary)]'
									: isCompleted
										? 'bg-[var(--color-tron-green)] text-[var(--color-tron-bg-primary)]'
										: 'bg-[var(--color-tron-bg-secondary)] text-[var(--color-tron-text-secondary)]'}"
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
									{wiStep.stepNumber}
								{/if}
							</div>
							<div class="min-w-0 flex-1">
								<p
									class="font-medium {isCurrent
										? 'text-[var(--color-tron-cyan)]'
										: isCompleted
											? 'text-[var(--color-tron-green)]'
											: 'tron-text-primary'}"
								>
									{wiStep.title || `Step ${wiStep.stepNumber}`}
								</p>
								{#if wiStep.partRequirements.length > 0}
									<div class="mt-1 flex flex-wrap gap-1">
										{#each wiStep.partRequirements as partReq (partReq.id)}
											<span class="text-xs text-[var(--color-tron-text-secondary)]">
												{partReq.partNumber}
											</span>
										{/each}
									</div>
								{/if}
								{#if isCompleted && scanData?.lotNumber}
									<p class="mt-1 font-mono text-xs text-[var(--color-tron-green)]">
										Lot: {scanData.lotNumber}
									</p>
								{/if}
							</div>
							{#if wiStep.requiresScan}
								<svg
									class="h-4 w-4 shrink-0 {isCompleted
										? 'text-[var(--color-tron-green)]'
										: 'text-[var(--color-tron-text-secondary)]'}"
									fill="none"
									viewBox="0 0 24 24"
									stroke="currentColor"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"
									/>
								</svg>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		</TronCard>

		<!-- Parts-only mode (fallback when no work instruction) -->
	{:else if currentPart}
		<TronCard class="border-[var(--color-tron-cyan)]">
			<h3 class="tron-text-primary mb-4 text-lg font-medium">Current Part</h3>
			<PartCard
				partNumber={currentPart.partNumber}
				name={currentPart.name}
				category={currentPart.category ?? undefined}
				isCurrent={true}
				instruction="Scan the part barcode or lot number label"
				bomData={currentPart.bomData}
				inventoryCount={currentPart.inventoryCount}
				hasInventoryTracking={currentPart.hasInventoryTracking}
				quantityToDeduct={getQuantityToDeduct(currentPart.id)}
				inventoryChange={getInventoryChange(currentPart.id)}
			/>

			<form
				bind:this={formElement}
				method="POST"
				action="?/scanPart"
				use:enhance={() => {
					return async ({ result, update }) => {
						if (result.type === 'success') {
							const data = result.data as
								| { inventoryDeduction?: { previousQuantity: number; newQuantity: number } }
								| undefined;
							if (data?.inventoryDeduction && currentPart) {
								inventoryChanges[currentPart.id] = {
									previousQuantity: data.inventoryDeduction.previousQuantity,
									newQuantity: data.inventoryDeduction.newQuantity
								};
							}
						}
						await update();
					};
				}}
				class="mt-6"
			>
				<input type="hidden" name="barcode" />
				<input type="hidden" name="partDefinitionId" />
				<input type="hidden" name="workInstructionStepId" />
				<ScanInput label="Scan Part Barcode" placeholder="Scan barcode..." onScan={handleScan} />
			</form>

			{#if form?.error}
				<div
					class="mt-4 rounded border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-3"
				>
					<p class="text-sm text-[var(--color-tron-red)]">{form.error}</p>
				</div>
			{/if}
		</TronCard>

		<TronCard>
			<h3 class="tron-text-primary mb-4 text-lg font-medium">Parts List</h3>
			<div class="space-y-3">
				{#each data.parts as part, index (part.id)}
					<PartCard
						partNumber={part.partNumber}
						name={part.name}
						category={part.category ?? undefined}
						isCurrent={index === currentPartIndex}
						isScanned={isPartScanned(part.id)}
						lotNumber={getPartLotNumber(part.id)}
						bomData={part.bomData}
						inventoryCount={part.inventoryCount}
						hasInventoryTracking={part.hasInventoryTracking}
						quantityToDeduct={index === currentPartIndex ? getQuantityToDeduct(part.id) : 0}
						inventoryChange={getInventoryChange(part.id)}
					/>
				{/each}
			</div>
		</TronCard>
	{/if}

	<!-- PRD-INVWI: Inventory Transactions Section -->
	{#if data.inventoryTransactions && data.inventoryTransactions.length > 0}
		<TronCard>
			<div class="mb-4 flex items-center justify-between">
				<h3 class="tron-text-primary text-lg font-medium">Inventory Transactions</h3>
				<span class="rounded-full bg-[var(--color-tron-bg-tertiary)] px-2 py-1 text-xs">
					{data.inventoryTransactions.length} transactions
				</span>
			</div>
			<div class="space-y-3">
				{#each data.inventoryTransactions as txn (txn.id)}
					<div
						class="rounded-lg border p-3 {txn.retractedAt
							? 'border-[var(--color-tron-orange)]/50 bg-[var(--color-tron-orange)]/5'
							: 'border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)]'}"
					>
						<div class="flex items-start justify-between gap-4">
							<div class="min-w-0 flex-1">
								<div class="mb-1 flex items-center gap-2">
									<span class="font-mono text-sm text-[var(--color-tron-cyan)]"
										>{txn.partNumber}</span
									>
									<span class="tron-text-primary text-sm">{txn.partName}</span>
									{#if txn.retractedAt}
										<span
											class="rounded bg-[var(--color-tron-orange)]/20 px-2 py-0.5 text-xs text-[var(--color-tron-orange)]"
										>
											Retracted
										</span>
									{/if}
								</div>
								<div class="flex flex-wrap items-center gap-3 text-xs">
									<span class="flex items-center gap-1">
										<span class="tron-text-muted">Qty:</span>
										<span
											class={txn.quantity < 0
												? 'text-[var(--color-tron-red)]'
												: 'text-[var(--color-tron-green)]'}
										>
											{txn.quantity > 0 ? '+' : ''}{txn.quantity}
										</span>
									</span>
									<span class="tron-text-muted">
										{txn.previousQuantity} → {txn.newQuantity}
									</span>
									<span class="tron-text-muted">
										by {txn.performedByName ?? 'Unknown'}
									</span>
									<span class="tron-text-muted">
										{new Date(txn.performedAt).toLocaleString()}
									</span>
								</div>
								{#if txn.retractedAt && txn.retractionReason}
									<p class="mt-2 text-xs text-[var(--color-tron-orange)] italic">
										Retraction reason: {txn.retractionReason}
									</p>
								{/if}
							</div>
							{#if data.canRetract && !txn.retractedAt && txn.transactionType === 'deduction'}
								<form method="POST" action="?/retractInventory" use:enhance>
									<input type="hidden" name="transactionId" value={txn.id} />
									<input
										type="text"
										name="reason"
										placeholder="Reason..."
										required
										class="mr-2 w-32 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] px-2 py-1 text-xs"
									/>
									<button
										type="submit"
										class="rounded bg-[var(--color-tron-orange)]/20 px-2 py-1 text-xs text-[var(--color-tron-orange)] hover:bg-[var(--color-tron-orange)]/30"
									>
										Retract
									</button>
								</form>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		</TronCard>
	{/if}
</div>
