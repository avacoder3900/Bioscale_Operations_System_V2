<script lang="ts">
	import { enhance, deserialize } from '$app/forms';
	import type { PageData, ActionData } from './$types';
	import PartSelector from '$lib/components/receiving/PartSelector.svelte';
	import CocUpload from '$lib/components/receiving/CocUpload.svelte';
	import ToolCheckGate from '$lib/components/receiving/ToolCheckGate.svelte';
	import InspectionForm from '$lib/components/receiving/InspectionForm.svelte';
	import type { InspectionResult } from '$lib/components/receiving/InspectionForm.svelte';
	import IpInspectionLayout from '$lib/components/receiving/IpInspectionLayout.svelte';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	interface SelectedPart {
		id: string;
		partNumber: string;
		name: string;
		category: string | null;
		manufacturer: string | null;
		inspectionPathway: string;
		sampleSize: number;
		percentAccepted: number;
	}

	interface IpTool {
		tool_id: string;
		name: string;
	}

	let selectedPart = $state<SelectedPart | null>(null);
	let poReference = $state('');
	let supplier = $state('');
	let orderedQuantity = $state<number | null>(null);
	let cocUrl = $state<string | null>(null);
	let uploading = $state(false);
	let cocError = $state<string | null>(null);

	// Steps: 1=part+PO, 2=pathway (CoC upload / IP tool check), 3=IP inspection, 4=lot creation, 5=success
	let step = $state(1);

	// IP state
	let confirmedTools = $state<IpTool[]>([]);
	let inspectionResultData = $state<InspectionResult | null>(null);

	// Override state
	let overrideApproved = $state(false);
	let overrideReasonInput = $state('');
	let overridePassword = $state('');
	let overrideSubmitting = $state(false);
	let overrideError = $state('');

	// Rejection state
	let rejecting = $state(false);
	let rejectionReason = $state('');
	let rejectionNextSteps = $state('');

	// Lot creation fields
	let lotBarcode = $state('');
	let vendorLotNumber = $state('');
	let expirationDate = $state('');
	let lotCreating = $state(false);
	let createdLotIdManual = $state<string | undefined>(undefined);

	const createdLotId = $derived(createdLotIdManual ?? (form?.lotId as string | undefined));

	$effect(() => {
		if (form?.cocUrl) {
			cocUrl = form.cocUrl as string;
			step = 4;
		}
	});

	function handlePartSelect(part: SelectedPart) {
		selectedPart = part;
		confirmedTools = [];
		inspectionResultData = null;
	}

	const canContinue = $derived(selectedPart && orderedQuantity && orderedQuantity > 0);

	const ipRevision = $derived(selectedPart ? (data.ipRevisionMap[selectedPart.id] ?? null) : null);
	const ipTools = $derived<IpTool[]>(
		ipRevision?.formDefinition &&
			typeof ipRevision.formDefinition === 'object' &&
			!Array.isArray(ipRevision.formDefinition) &&
			Array.isArray((ipRevision.formDefinition as Record<string, unknown>).tools)
			? ((ipRevision.formDefinition as Record<string, unknown>).tools as IpTool[])
			: []
	);

	interface IpReference {
		label: string;
		url: string;
	}

	const ipReferences = $derived<IpReference[]>(
		ipRevision?.formDefinition &&
			typeof ipRevision.formDefinition === 'object' &&
			!Array.isArray(ipRevision.formDefinition) &&
			Array.isArray((ipRevision.formDefinition as Record<string, unknown>).references)
			? ((ipRevision.formDefinition as Record<string, unknown>).references as IpReference[])
			: []
	);

	interface IpStep {
		step_order: number;
		input_type: string;
		question_label: string;
		acceptable_answer?: string;
		nominal?: number;
		tolerance?: number;
		unit?: string;
		tool_id?: string;
		photo_url?: string;
	}

	const ipSteps = $derived<IpStep[]>(
		ipRevision?.formDefinition &&
			typeof ipRevision.formDefinition === 'object' &&
			!Array.isArray(ipRevision.formDefinition) &&
			Array.isArray((ipRevision.formDefinition as Record<string, unknown>).steps)
			? ((ipRevision.formDefinition as Record<string, unknown>).steps as IpStep[])
			: []
	);

	function handleToolsConfirmed() {
		confirmedTools = [...ipTools];
		if (ipSteps.length > 0) {
			step = 3; // Go to inspection form
		} else {
			step = 4; // Skip to lot creation if no steps defined
		}
	}

	function handleInspectionComplete(result: InspectionResult) {
		inspectionResultData = result;
		if (result.result === 'accepted') {
			step = 4;
		}
		// If failed, stay on step 3 — decision panel will render
	}

	async function handleCocUpload(file: File, manualLotNumber?: string) {
		if (!selectedPart) return;
		uploading = true;
		cocError = null;
		try {
			const fd = new FormData();
			fd.append('cocFile', file);
			fd.append('partId', selectedPart.id);
			if (manualLotNumber) fd.append('cocLotNumber', manualLotNumber);

			const response = await fetch('?/uploadCoc', {
				method: 'POST',
				headers: { 'x-sveltekit-action': 'true' },
				body: fd
			});
			const result = deserialize(await response.text());

			if (result.type === 'success') {
				const data = result.data as Record<string, unknown> | undefined;
				if (data?.cocUrl) {
					cocUrl = data.cocUrl as string;
					step = 4;
				} else {
					cocError = 'Upload succeeded but no URL returned';
				}
			} else if (result.type === 'failure') {
				const data = result.data as Record<string, unknown> | undefined;
				cocError = (data?.error as string) ?? 'Upload failed';
			} else {
				cocError = 'Upload failed';
			}
		} catch (err) {
			cocError = err instanceof Error ? err.message : 'Upload failed';
		} finally {
			uploading = false;
		}
	}

	// Step labels for indicator
	const isIp = $derived(selectedPart?.inspectionPathway === 'ip');
	const stepLabels = $derived(
		isIp
			? ['Part & PO', 'Tool Check', 'Inspection', 'Create Lot']
			: ['Part & PO', 'CoC Upload', 'Create Lot']
	);

	function stepNumber(s: number): number {
		// Map internal step to display step for indicator
		if (!isIp) {
			if (s <= 2) return s;
			if (s === 4) return 3; // lot creation
			return 4;
		}
		return s;
	}
</script>

<svelte:head>
	<title>New Receiving | Bioscale</title>
</svelte:head>

<div class="mx-auto p-6 {step === 3 && isIp && !inspectionResultData ? 'max-w-7xl' : 'max-w-4xl'}">
	<div class="mb-6">
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
		<a href="/receiving" class="tron-text-muted text-sm hover:underline">← Back to Receiving</a>
		<h1 class="tron-text mt-2 text-2xl font-bold">New Receiving</h1>
	</div>

	<!-- Step indicator -->
	<div class="mb-6 flex items-center gap-2 text-xs">
		{#each stepLabels as label, i (i)}
			{#if i > 0}<span class="tron-text-muted">→</span>{/if}
			<span
				class="rounded px-2 py-1 {stepNumber(step) >= i + 1
					? 'bg-cyan-500/20 text-cyan-400'
					: 'tron-text-muted'}"
			>
				{i + 1}. {label}
			</span>
		{/each}
	</div>

	{#if form?.error}
		<div class="mb-4 rounded bg-red-500/10 px-4 py-2 text-sm text-red-400">{form.error}</div>
	{/if}

	{#if step === 1}
		<!-- Step 1: Part Selection + PO Info -->
		<div class="space-y-4">
			<div class="tron-card p-4">
				<h2 class="tron-text mb-3 text-sm font-semibold tracking-wider uppercase">Select Part</h2>
				<PartSelector parts={data.parts} onselect={handlePartSelect} selected={selectedPart} />
			</div>

			{#if selectedPart}
				<div class="tron-card p-4">
					<h2 class="tron-text mb-3 text-sm font-semibold tracking-wider uppercase">
						Purchase Order Info
					</h2>
					<div class="grid gap-4 sm:grid-cols-3">
						<div>
							<label for="poRef" class="tron-text-muted mb-1 block text-xs">PO Reference</label>
							<input
								id="poRef"
								type="text"
								bind:value={poReference}
								placeholder="PO-12345"
								class="tron-input w-full px-3 py-2 text-sm"
							/>
						</div>
						<div>
							<label for="supplierInput" class="tron-text-muted mb-1 block text-xs">Supplier</label>
							<input
								id="supplierInput"
								type="text"
								bind:value={supplier}
								placeholder="Supplier name"
								class="tron-input w-full px-3 py-2 text-sm"
							/>
						</div>
						<div>
							<label for="qty" class="tron-text-muted mb-1 block text-xs">Ordered Quantity *</label>
							<input
								id="qty"
								type="number"
								bind:value={orderedQuantity}
								min="1"
								placeholder="0"
								class="tron-input w-full px-3 py-2 text-sm"
							/>
						</div>
					</div>
				</div>

				<div class="flex justify-end">
					<button
						type="button"
						disabled={!canContinue}
						onclick={() => (step = 2)}
						class="tron-button px-6 py-2 text-sm font-medium disabled:opacity-50"
					>
						Continue →
					</button>
				</div>
			{/if}
		</div>
	{:else if step === 2}
		<!-- Step 2: CoC Upload or IP Tool Check Gate -->
		<div class="space-y-4">
			<button
				type="button"
				onclick={() => (step = 1)}
				class="tron-text-muted text-sm hover:underline">← Back to Part & PO</button
			>

			{#if selectedPart?.inspectionPathway === 'coc'}
				<div class="tron-card p-4">
					<h2 class="tron-text mb-3 text-sm font-semibold tracking-wider uppercase">
						Certificate of Conformity
					</h2>
					<p class="tron-text-muted mb-4 text-sm">
						Upload the supplier's Certificate of Conformity for this part.
					</p>
					<CocUpload onupload={handleCocUpload} {uploading} error={cocError} />
				</div>
			{:else if !ipRevision}
				<div class="tron-card p-6">
					<p class="tron-text font-medium">No IP Revision Configured</p>
					<p class="tron-text-muted mt-2 text-sm">
						This part requires an Inspection Procedure, but no IP document has been uploaded yet.
						Upload an IP document and configure the form definition on the Part detail page.
					</p>
					<!-- eslint-disable svelte/no-navigation-without-resolve -->
					<a
						href="/parts/{selectedPart?.id}"
						class="mt-2 inline-block text-sm text-[var(--color-tron-cyan)] hover:underline"
						>Go to Part detail page →</a
					>
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
				</div>
			{:else if ipTools.length === 0}
				<div class="tron-card p-6">
					<p class="tron-text font-medium">No Tools Defined</p>
					<p class="tron-text-muted mt-2 text-sm">
						The current IP form definition has no tools specified. You may proceed directly.
					</p>
					<div class="mt-4 flex justify-end">
						<button
							type="button"
							onclick={handleToolsConfirmed}
							class="tron-button px-6 py-2 text-sm font-medium"
						>
							Continue →
						</button>
					</div>
				</div>
			{:else}
				<ToolCheckGate tools={ipTools} onconfirm={handleToolsConfirmed} />
			{/if}
		</div>
	{:else if step === 3}
		{#if inspectionResultData?.result === 'failed' && !overrideApproved}
			<!-- Decision panel for failed inspection -->
			<div class="space-y-4">
				<div class="rounded-lg border border-red-500/30 bg-red-500/10 p-6 text-center">
					<div class="mb-2 text-3xl font-bold text-red-400">FAILED</div>
					<div class="tron-text text-sm">
						{inspectionResultData.passRate.toFixed(1)}% pass rate (required: {inspectionResultData.percentRequired}%)
					</div>
				</div>

				<div class="grid gap-4 md:grid-cols-2">
					<div class="tron-card p-4">
						<h3 class="tron-text mb-3 text-sm font-semibold tracking-wider uppercase">
							Override & Accept
						</h3>
						<p class="tron-text-muted mb-4 text-sm">
							Requires admin authorization. An audit trail entry will be created.
						</p>

						{#if overrideError}
							<div class="mb-4 rounded bg-red-500/10 px-4 py-2 text-sm text-red-400">
								{overrideError}
							</div>
						{/if}

						<form
							method="POST"
							action="?/validateOverride"
							use:enhance={() => {
								overrideSubmitting = true;
								overrideError = '';
								return async ({ result }) => {
									overrideSubmitting = false;
									if (result.type === 'success') {
										overrideApproved = true;
										step = 4;
									} else if (result.type === 'failure') {
										const d = result.data as Record<string, string> | undefined;
										overrideError = d?.overrideError ?? 'Override validation failed';
									}
								};
							}}
						>
							<div class="space-y-3">
								<div>
									<label for="overrideReason" class="tron-text-muted mb-1 block text-xs">
										Reason for Override *
									</label>
									<textarea
										id="overrideReason"
										name="overrideReason"
										bind:value={overrideReasonInput}
										rows="3"
										minlength="10"
										required
										class="tron-input w-full px-3 py-2 text-sm"
										placeholder="Explain why this inspection failure is being overridden..."
									></textarea>
									<span
										class="text-xs {overrideReasonInput.length >= 10
											? 'text-green-400'
											: 'tron-text-muted'}"
									>
										{overrideReasonInput.length} characters
										{#if overrideReasonInput.length < 10}(need {10 - overrideReasonInput.length} more){/if}
									</span>
								</div>

								<div>
									<label for="adminPassword" class="tron-text-muted mb-1 block text-xs">
										Admin Password *
									</label>
									<input
										id="adminPassword"
										name="adminPassword"
										type="password"
										bind:value={overridePassword}
										required
										class="tron-input w-full px-3 py-2 text-sm"
										placeholder="Enter admin override password"
									/>
								</div>

								<button
									type="submit"
									disabled={overrideReasonInput.length < 10 ||
										!overridePassword ||
										overrideSubmitting}
									class="tron-button w-full px-4 py-2 text-sm font-medium disabled:opacity-50"
								>
									{overrideSubmitting ? 'Validating...' : 'Validate Override'}
								</button>
							</div>
						</form>
					</div>

					<div class="tron-card p-4">
						<h3 class="tron-text mb-3 text-sm font-semibold tracking-wider uppercase">
							Reject Lot
						</h3>
						<p class="tron-text-muted mb-4 text-sm">
							Reject this lot. It will be tracked as rejected inventory. Inventory will NOT be updated.
						</p>

						<div class="space-y-3">
							<div>
								<label for="rejectionReason" class="tron-text-muted mb-1 block text-xs">
									Reason for Rejection *
								</label>
								<textarea
									id="rejectionReason"
									bind:value={rejectionReason}
									rows="3"
									class="tron-input w-full px-3 py-2 text-sm"
									placeholder="Explain why this lot is being rejected..."
								></textarea>
								<span
									class="text-xs {rejectionReason.length >= 10
										? 'text-green-400'
										: 'tron-text-muted'}"
								>
									{rejectionReason.length} characters
									{#if rejectionReason.length < 10}(need {10 - rejectionReason.length} more){/if}
								</span>
							</div>

							<div>
								<label for="rejectionNextSteps" class="tron-text-muted mb-1 block text-xs">
									Next Steps *
								</label>
								<textarea
									id="rejectionNextSteps"
									bind:value={rejectionNextSteps}
									rows="2"
									class="tron-input w-full px-3 py-2 text-sm"
									placeholder="What should happen next? (e.g., return to supplier, quarantine...)"
								></textarea>
							</div>

							<button
								type="button"
								disabled={rejectionReason.length < 10 || !rejectionNextSteps.trim()}
								onclick={() => {
									rejecting = true;
									step = 4;
								}}
								class="w-full rounded border border-red-500 px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-500/10 disabled:opacity-50"
							>
								Proceed with Rejection
							</button>
						</div>
					</div>
				</div>
			</div>
		{:else}
			<!-- Step 3: IP Inspection Form with split-screen document view -->
			<div class="space-y-4">
				<button
					type="button"
					onclick={() => (step = 2)}
					class="tron-text-muted text-sm hover:underline">← Back to Tool Check</button
				>

				<h2 class="tron-text text-sm font-semibold tracking-wider uppercase">
					Inspection — {selectedPart?.partNumber}
				</h2>

				<IpInspectionLayout
					revisionNumber={ipRevision?.revisionNumber ?? 0}
					effectiveDate={ipRevision?.uploadedAt ? new Date(ipRevision.uploadedAt) : new Date()}
					renderedHtmlUrl={ipRevision?.renderedHtmlUrl ?? null}
					references={ipReferences}
					partId={selectedPart?.id ?? ''}
				>
					{#snippet formPanel()}
						<InspectionForm
							steps={ipSteps}
							sampleSize={selectedPart?.sampleSize ?? 1}
							percentAccepted={selectedPart?.percentAccepted ?? 100}
							oncomplete={handleInspectionComplete}
						/>
					{/snippet}
				</IpInspectionLayout>
			</div>
		{/if}
	{:else if step === 4}
		<!-- Step 4: Lot Creation (barcode scan + details) -->
		<div class="space-y-4">
			<button
				type="button"
				onclick={() => (step = isIp && ipSteps.length > 0 ? 3 : 2)}
				class="tron-text-muted text-sm hover:underline">← Back</button
			>

			<form
				method="POST"
				action="?/createLot"
				enctype="multipart/form-data"
				use:enhance={() => {
					lotCreating = true;
					return async ({ result, update }) => {
						lotCreating = false;
						if (result.type === 'success' && result.data?.lotCreated) {
							createdLotIdManual = result.data.lotId as string;
							step = 5;
						} else {
							await update();
						}
					};
				}}
			>
				<input type="hidden" name="partId" value={selectedPart?.id} />
				<input type="hidden" name="pathway" value={selectedPart?.inspectionPathway} />
				<input type="hidden" name="cocDocumentUrl" value={cocUrl ?? ''} />
				<input type="hidden" name="poReference" value={poReference} />
				<input type="hidden" name="supplier" value={supplier} />
				{#if ipRevision}
					<input type="hidden" name="ipRevisionId" value={ipRevision.id} />
				{/if}
				{#if confirmedTools.length > 0}
					<input type="hidden" name="confirmedTools" value={JSON.stringify(confirmedTools)} />
				{/if}
				{#if inspectionResultData}
					<input
						type="hidden"
						name="inspectionResults"
						value={JSON.stringify(inspectionResultData)}
					/>
				{/if}
				{#if overrideApproved}
					<input type="hidden" name="overrideApplied" value="true" />
					<input type="hidden" name="overrideReason" value={overrideReasonInput} />
				{/if}
				{#if rejecting}
					<input type="hidden" name="status" value="rejected" />
				{/if}

				<div class="tron-card space-y-4 p-4">
					<h2 class="tron-text text-sm font-semibold tracking-wider uppercase">
						{rejecting ? 'Create Rejected Lot' : 'Create Lot'}
					</h2>

					{#if rejecting}
						<div class="rounded bg-red-500/10 px-3 py-2 text-xs text-red-400">
							This lot will be REJECTED. Inventory will not be updated.
						</div>
					{/if}

					{#if overrideApproved}
						<div class="rounded bg-yellow-500/10 px-3 py-2 text-xs text-yellow-400">
							Override approved — lot will be created with override flag
						</div>
					{/if}

					{#if inspectionResultData}
						<div
							class="rounded px-3 py-2 text-xs {inspectionResultData.result === 'accepted'
								? 'bg-green-500/10 text-green-400'
								: 'bg-red-500/10 text-red-400'}"
						>
							Inspection: {inspectionResultData.result.toUpperCase()} — {inspectionResultData.passRate.toFixed(
								1
							)}% pass rate (required: {inspectionResultData.percentRequired}%)
						</div>
					{/if}

					<div class="grid gap-4 sm:grid-cols-2">
						<div>
							<label for="barcode" class="tron-text-muted mb-1 block text-xs"
								>Scan Barcode / Enter Lot ID *</label
							>
							<!-- svelte-ignore a11y_autofocus -->
							<input
								id="barcode"
								name="lotId"
								type="text"
								bind:value={lotBarcode}
								autofocus
								placeholder="Scan or type barcode..."
								class="tron-input w-full px-3 py-2 font-mono text-sm"
							/>
						</div>
						<div>
							<label for="bagBarcode" class="tron-text-muted mb-1 block text-xs"
								>Bag Barcode</label
							>
							<input
								id="bagBarcode"
								name="bagBarcode"
								type="text"
								placeholder="Scan or type bag barcode..."
								class="tron-input w-full px-3 py-2 font-mono text-sm"
							/>
						</div>
					</div>

					<div class="grid gap-4 sm:grid-cols-3">
						<div>
							<label for="lotQty" class="tron-text-muted mb-1 block text-xs"
								>Accepted Quantity *</label
							>
							<input
								id="lotQty"
								name="quantity"
								type="number"
								value={orderedQuantity}
								min="1"
								class="tron-input w-full px-3 py-2 text-sm"
							/>
						</div>
						<div>
							<label for="vendorLot" class="tron-text-muted mb-1 block text-xs">Vendor Lot #</label>
							<input
								id="vendorLot"
								name="vendorLotNumber"
								type="text"
								bind:value={vendorLotNumber}
								class="tron-input w-full px-3 py-2 text-sm"
							/>
						</div>
						<div>
							<label for="expDate" class="tron-text-muted mb-1 block text-xs">Expiration Date</label
							>
							<input
								id="expDate"
								name="expirationDate"
								type="date"
								bind:value={expirationDate}
								class="tron-input w-full px-3 py-2 text-sm"
							/>
						</div>
					</div>

					<div class="grid gap-4 sm:grid-cols-2">
						<div>
							<label for="lotPhotos" class="tron-text-muted mb-1 block text-xs">Photos (optional)</label>
							<input
								id="lotPhotos"
								name="lotPhotos"
								type="file"
								multiple
								accept=".jpg,.jpeg,.png,.heic"
								class="tron-input w-full px-2 py-1 text-xs"
							/>
						</div>
						<div>
							<label for="lotDocuments" class="tron-text-muted mb-1 block text-xs">Documents (optional)</label>
							<input
								id="lotDocuments"
								name="lotDocuments"
								type="file"
								multiple
								accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png"
								class="tron-input w-full px-2 py-1 text-xs"
							/>
						</div>
					</div>

					<button
						type="submit"
						disabled={!lotBarcode.trim() || lotCreating}
						class="tron-button w-full px-4 py-2 text-sm font-medium disabled:opacity-50"
					>
						{lotCreating ? 'Creating...' : rejecting ? 'Create Rejected Lot' : 'Create Lot & Accept Inventory'}
					</button>
				</div>
			</form>
		</div>
	{:else if step === 5}
		<!-- Step 5: Success -->
		<div class="tron-card p-8 text-center">
			{#if rejecting}
				<div class="mb-4 text-4xl text-red-400">✗</div>
				<h2 class="tron-text mb-2 text-xl font-bold">Lot Rejected</h2>
				<p class="tron-text-muted mb-1 text-sm">
					Lot <span class="font-mono font-medium">{createdLotId}</span> has been rejected.
				</p>
				<p class="tron-text-muted mb-4 text-sm">
					Sent to Rejected Inventory for tracking. Inventory was not updated.
				</p>
			{:else}
				<div class="mb-4 text-4xl">✓</div>
				<h2 class="tron-text mb-2 text-xl font-bold">Lot Created Successfully</h2>
				<p class="tron-text-muted mb-1 text-sm">
					Lot <span class="font-mono font-medium">{createdLotId}</span>
				</p>
				<p class="tron-text-muted mb-4 text-sm">
					{selectedPart?.partNumber} — {selectedPart?.name} — Qty: {orderedQuantity}
				</p>
			{/if}
			<div class="flex justify-center gap-3">
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
				<a href="/receiving" class="tron-button px-4 py-2 text-sm">Back to Receiving</a>
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
				<a href="/receiving/new" class="tron-text-muted px-4 py-2 text-sm hover:underline"
					>Receive Another</a
				>
			</div>
		</div>
	{/if}
</div>
