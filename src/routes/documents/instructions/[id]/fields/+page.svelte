<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';

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
	}

	interface Step {
		id: string;
		stepNumber: number;
		title: string | null;
		content: string | null;
		requiresScan: boolean;
		fields: FieldDefinition[];
	}

	interface Props {
		data: {
			workInstruction: {
				id: string;
				documentNumber: string;
				title: string;
				status: string;
				creatorName: string | null;
			};
			currentVersion: {
				id: string;
				version: number;
			} | null;
			steps: Step[];
		};
	}

	let { data }: Props = $props();

	let selectedStepId = $state<string | null>(null);
	let showAddField = $state(false);
	let editingFieldId = $state<string | null>(null);

	// Form state for adding/editing fields
	let fieldForm = $state({
		fieldName: '',
		fieldLabel: '',
		fieldType: 'barcode_scan' as string,
		isRequired: true,
		validationPattern: '',
		barcodeFieldMapping: 'lot' as string,
		options: ''
	});

	const fieldTypes = [
		{ value: 'barcode_scan', label: 'Barcode Scan', description: 'Scan external barcode on part' },
		{ value: 'manual_entry', label: 'Manual Entry', description: 'Free text input' },
		{ value: 'date_picker', label: 'Date Picker', description: 'Date selection' },
		{ value: 'dropdown', label: 'Dropdown', description: 'Select from predefined options' }
	];

	const barcodeFieldMappings = [
		{ value: 'lot', label: 'Lot Number', description: 'GS1 AI (10)' },
		{ value: 'serial', label: 'Serial Number', description: 'GS1 AI (21)' },
		{ value: 'expiry', label: 'Expiry Date', description: 'GS1 AI (17)' },
		{ value: 'gtin', label: 'GTIN', description: 'GS1 AI (01)' },
		{ value: 'part_number', label: 'Part Number', description: 'Extracted from GTIN' }
	];

	function selectStep(stepId: string) {
		selectedStepId = selectedStepId === stepId ? null : stepId;
		showAddField = false;
		editingFieldId = null;
		resetFieldForm();
	}

	function startAddField() {
		showAddField = true;
		editingFieldId = null;
		resetFieldForm();
	}

	function startEditField(field: FieldDefinition) {
		editingFieldId = field.id;
		showAddField = false;
		fieldForm = {
			fieldName: field.fieldName,
			fieldLabel: field.fieldLabel,
			fieldType: field.fieldType,
			isRequired: field.isRequired,
			validationPattern: field.validationPattern || '',
			barcodeFieldMapping: field.barcodeFieldMapping || 'lot',
			options: field.options ? JSON.stringify(field.options) : ''
		};
	}

	function resetFieldForm() {
		fieldForm = {
			fieldName: '',
			fieldLabel: '',
			fieldType: 'barcode_scan',
			isRequired: true,
			validationPattern: '',
			barcodeFieldMapping: 'lot',
			options: ''
		};
	}

	function cancelEdit() {
		showAddField = false;
		editingFieldId = null;
		resetFieldForm();
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

	const selectedStep = $derived(data.steps.find((s) => s.id === selectedStepId));
</script>

<svelte:head>
	<title>Configure Fields | {data.workInstruction.documentNumber}</title>
</svelte:head>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-start justify-between">
		<div>
			<div class="flex items-center gap-3">
				<a
					href={resolve(`/documents/instructions/${data.workInstruction.id}`)}
					class="tron-text-muted hover:text-[var(--color-tron-cyan)]"
					aria-label="Back to work instruction"
				>
					<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M15 19l-7-7 7-7"
						/>
					</svg>
				</a>
				<h1 class="tron-heading text-2xl font-bold">Configure Custom Fields</h1>
			</div>
			<p class="tron-text-primary mt-2">{data.workInstruction.documentNumber} - {data.workInstruction.title}</p>
			<p class="tron-text-muted mt-1 text-sm">
				Define barcode scan and data entry fields for each assembly step
			</p>
		</div>
	</div>

	{#if !data.currentVersion}
		<div class="tron-card p-8 text-center">
			<p class="tron-text-muted">No version available. Upload a document first.</p>
		</div>
	{:else if data.steps.length === 0}
		<div class="tron-card p-8 text-center">
			<p class="tron-text-muted">No steps found in this work instruction.</p>
		</div>
	{:else}
		<div class="grid grid-cols-3 gap-6">
			<!-- Steps List -->
			<div class="space-y-3">
				<h2 class="tron-heading font-semibold">Steps</h2>
				{#each data.steps as step (step.id)}
					<button
						onclick={() => selectStep(step.id)}
						class="w-full rounded-lg border p-4 text-left transition-all {selectedStepId === step.id
							? 'border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/10'
							: 'border-[var(--color-tron-border)] bg-[var(--color-tron-bg-card)] hover:border-[var(--color-tron-cyan)]/50'}"
					>
						<div class="flex items-center justify-between">
							<div class="flex items-center gap-3">
								<div
									class="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--color-tron-cyan)]/20 text-sm font-bold text-[var(--color-tron-cyan)]"
								>
									{step.stepNumber}
								</div>
								<div>
									<p class="tron-text-primary font-medium">
										{step.title || `Step ${step.stepNumber}`}
									</p>
									<p class="tron-text-muted text-sm">
										{step.fields.length} field{step.fields.length !== 1 ? 's' : ''} configured
									</p>
								</div>
							</div>
							<svg
								class="h-5 w-5 text-[var(--color-tron-text-secondary)] {selectedStepId === step.id ? 'rotate-90' : ''}"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
							</svg>
						</div>
					</button>
				{/each}
			</div>

			<!-- Field Configuration Panel -->
			<div class="col-span-2">
				{#if !selectedStep}
					<div class="tron-card flex h-full items-center justify-center p-8">
						<p class="tron-text-muted">Select a step to configure its fields</p>
					</div>
				{:else}
					<div class="tron-card p-6">
						<div class="mb-6 flex items-center justify-between">
							<div>
								<h2 class="tron-heading text-lg font-semibold">
									Step {selectedStep.stepNumber}: {selectedStep.title || 'Untitled'}
								</h2>
								{#if selectedStep.content}
									<p class="tron-text-muted mt-1 text-sm line-clamp-2">{selectedStep.content}</p>
								{/if}
							</div>
							<button onclick={startAddField} class="tron-btn-primary flex items-center gap-2">
								<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
								</svg>
								Add Field
							</button>
						</div>

						<!-- Existing Fields -->
						{#if selectedStep.fields.length > 0}
							<div class="mb-6 space-y-3">
								<h3 class="tron-text-muted text-sm font-medium">Configured Fields</h3>
								{#each selectedStep.fields as field (field.id)}
									<div
										class="flex items-center justify-between rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] p-4"
									>
										<div class="flex items-center gap-4">
											<div class="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--color-tron-cyan)]/20">
												<svg class="h-5 w-5 text-[var(--color-tron-cyan)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
													<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d={getFieldTypeIcon(field.fieldType)} />
												</svg>
											</div>
											<div>
												<p class="tron-text-primary font-medium">{field.fieldLabel}</p>
												<div class="mt-1 flex items-center gap-2">
													<span class="rounded bg-[var(--color-tron-bg-secondary)] px-2 py-0.5 text-xs text-[var(--color-tron-cyan)]">
														{fieldTypes.find(t => t.value === field.fieldType)?.label || field.fieldType}
													</span>
													{#if field.isRequired}
														<span class="text-xs text-[var(--color-tron-red)]">Required</span>
													{/if}
													{#if field.fieldType === 'barcode_scan' && field.barcodeFieldMapping}
														<span class="text-xs text-[var(--color-tron-green)]">
															Extracts: {barcodeFieldMappings.find(m => m.value === field.barcodeFieldMapping)?.label || field.barcodeFieldMapping}
														</span>
													{/if}
												</div>
											</div>
										</div>
										<div class="flex items-center gap-2">
											<button
												onclick={() => startEditField(field)}
												class="tron-btn-ghost p-2"
												aria-label="Edit field"
											>
												<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
													<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
												</svg>
											</button>
											<form method="POST" action="?/deleteField" use:enhance>
												<input type="hidden" name="fieldId" value={field.id} />
												<button
													type="submit"
													class="tron-btn-ghost p-2 text-[var(--color-tron-red)] hover:bg-[var(--color-tron-red)]/10"
													aria-label="Delete field"
												>
													<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
														<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
													</svg>
												</button>
											</form>
										</div>
									</div>
								{/each}
							</div>
						{/if}

						<!-- Add/Edit Field Form -->
						{#if showAddField || editingFieldId}
							<div class="rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/5 p-4">
								<h3 class="tron-heading mb-4 font-medium">
									{editingFieldId ? 'Edit Field' : 'Add New Field'}
								</h3>
								<form
									method="POST"
									action={editingFieldId ? '?/updateField' : '?/addField'}
									use:enhance={() => {
										return async ({ result, update }) => {
											if (result.type === 'success') {
												cancelEdit();
											}
											await update();
										};
									}}
									class="space-y-4"
								>
									<input type="hidden" name="stepId" value={selectedStepId} />
									{#if editingFieldId}
										<input type="hidden" name="fieldId" value={editingFieldId} />
									{/if}

									<div class="grid grid-cols-2 gap-4">
										<div>
											<label class="tron-label mb-1 block">Field Name (internal)</label>
											<input
												type="text"
												name="fieldName"
												bind:value={fieldForm.fieldName}
												placeholder="e.g., lot_number"
												class="tron-input w-full"
												required
												disabled={!!editingFieldId}
											/>
										</div>
										<div>
											<label class="tron-label mb-1 block">Field Label (display)</label>
											<input
												type="text"
												name="fieldLabel"
												bind:value={fieldForm.fieldLabel}
												placeholder="e.g., Lot Number"
												class="tron-input w-full"
												required
											/>
										</div>
									</div>

									<div>
										<label class="tron-label mb-1 block">Field Type</label>
										<select
											name="fieldType"
											bind:value={fieldForm.fieldType}
											class="tron-select w-full"
										>
											{#each fieldTypes as type}
												<option value={type.value}>{type.label} - {type.description}</option>
											{/each}
										</select>
									</div>

									{#if fieldForm.fieldType === 'barcode_scan'}
										<div>
											<label class="tron-label mb-1 block">Extract Field From Barcode</label>
											<select
												name="barcodeFieldMapping"
												bind:value={fieldForm.barcodeFieldMapping}
												class="tron-select w-full"
											>
												{#each barcodeFieldMappings as mapping}
													<option value={mapping.value}>{mapping.label} ({mapping.description})</option>
												{/each}
											</select>
											<p class="tron-text-muted mt-1 text-xs">
												Scanned GS1/QR code will be parsed to extract this field
											</p>
										</div>
									{/if}

									{#if fieldForm.fieldType === 'dropdown'}
										<div>
											<label class="tron-label mb-1 block">Options (JSON array)</label>
											<input
												type="text"
												name="options"
												bind:value={fieldForm.options}
												placeholder='["Option 1", "Option 2", "Option 3"]'
												class="tron-input w-full"
											/>
										</div>
									{/if}

									<div>
										<label class="tron-label mb-1 block">Validation Pattern (regex, optional)</label>
										<input
											type="text"
											name="validationPattern"
											bind:value={fieldForm.validationPattern}
											placeholder="e.g., ^[A-Z0-9]{10}$"
											class="tron-input w-full"
										/>
									</div>

									<div class="flex items-center gap-2">
										<input
											type="checkbox"
											id="isRequired"
											name="isRequired"
											bind:checked={fieldForm.isRequired}
											value="true"
											class="h-4 w-4 rounded border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)]"
										/>
										<label for="isRequired" class="tron-text-primary text-sm">Required field</label>
									</div>

									<div class="flex justify-end gap-3">
										<button type="button" onclick={cancelEdit} class="tron-btn-ghost">
											Cancel
										</button>
										<button type="submit" class="tron-btn-primary">
											{editingFieldId ? 'Update Field' : 'Add Field'}
										</button>
									</div>
								</form>
							</div>
						{/if}

						{#if !showAddField && !editingFieldId && selectedStep.fields.length === 0}
							<div class="rounded-lg border-2 border-dashed border-[var(--color-tron-border)] p-8 text-center">
								<svg
									class="mx-auto h-12 w-12 text-[var(--color-tron-text-secondary)]"
									fill="none"
									viewBox="0 0 24 24"
									stroke="currentColor"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"
									/>
								</svg>
								<p class="tron-text-muted mt-4">No fields configured for this step</p>
								<p class="tron-text-muted mt-1 text-sm">
									Add barcode scan fields to capture data during assembly
								</p>
							</div>
						{/if}
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>
