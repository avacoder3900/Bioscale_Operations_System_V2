<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let lot = $derived(data.lot);
	let inspectionResults = $derived(data.inspectionResults ?? []);
	let toolConfirmations = $derived(data.toolConfirmations ?? []);

	// Disposition state
	let showDisposition = $state(false);
	let dispositionType = $state<string>('accepted');
	let totalRejects = $state(0);
	let defectDescription = $state('');
	let rmaNumber = $state('');
	let dispositionExplanation = $state('');
	let disposing = $state(false);

	function formatDate(date: string | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleDateString();
	}

	function formatDateTime(date: string | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleString();
	}

	function checklistLabel(key: string): string {
		const labels: Record<string, string> = {
			packingSlipIncluded: 'Packing slip included',
			materialLabeledIdentified: 'Material properly labeled/identified',
			materialProperlyPackaged: 'Material properly packaged',
			materialFreeOfDefects: 'Material free of debris/visual damages/cosmetic defects',
			purchaseOrderRequirementsMet: 'Purchase order requirements met'
		};
		return labels[key] ?? key;
	}

	const isCompleted = $derived(lot.status !== 'in_progress');

	// Group inspection results by sample number
	const resultsBySample = $derived(() => {
		const grouped: Record<number, typeof inspectionResults> = {};
		for (const r of inspectionResults) {
			const s = r.sampleNumber ?? 1;
			if (!grouped[s]) grouped[s] = [];
			grouped[s].push(r);
		}
		return grouped;
	});
</script>

<svelte:head>
	<title>Lot {lot.lotNumber ?? lot.lotId} | Receiving | Bioscale</title>
</svelte:head>

<div class="mx-auto max-w-5xl p-6">
	<!-- Header -->
	<div class="mb-6">
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
		<a href="/spu/receiving" class="tron-text-muted text-sm hover:underline">← Back to Receiving</a>
		<div class="mt-2 flex items-center justify-between">
			<div>
				<h1 class="tron-text text-2xl font-bold">
					{lot.lotNumber ?? lot.lotId}
				</h1>
				<p class="tron-text-muted mt-1 text-sm">
					{lot.part?.partNumber} — {lot.part?.name}
				</p>
			</div>
			<div class="flex items-center gap-2">
				<span class="rounded px-3 py-1 text-sm font-medium uppercase
					{lot.status === 'accepted' ? 'bg-green-500/20 text-green-400' :
					 lot.status === 'rejected' ? 'bg-red-500/20 text-red-400' :
					 lot.status === 'returned' ? 'bg-yellow-500/20 text-yellow-400' :
					 lot.status === 'in_progress' ? 'bg-blue-500/20 text-blue-400' :
					 'bg-gray-500/20 text-gray-400'}">
					{lot.status}
				</span>
				{#if lot.inspectionPathway}
					<span class="rounded px-2 py-0.5 text-xs font-medium uppercase
						{lot.inspectionPathway === 'coc' ? 'bg-blue-500/20 text-blue-400' : 'bg-orange-500/20 text-orange-400'}">
						{lot.inspectionPathway}
					</span>
				{/if}
				{#if lot.firstArticleInspection}
					<span class="rounded bg-purple-500/20 px-2 py-0.5 text-xs font-medium text-purple-400">FAI</span>
				{/if}
			</div>
		</div>
	</div>

	{#if form?.error}
		<div class="mb-4 rounded bg-red-500/10 px-4 py-2 text-sm text-red-400">{form.error}</div>
	{/if}
	{#if form?.disposed}
		<div class="mb-4 rounded bg-green-500/10 px-4 py-2 text-sm text-green-400">Lot disposition saved successfully.</div>
	{/if}

	<div class="space-y-6">
		<!-- Lot Info -->
		<div class="tron-card p-4">
			<h2 class="tron-text mb-3 text-sm font-semibold tracking-wider uppercase">Lot Information</h2>
			<dl class="grid gap-4 text-sm sm:grid-cols-3">
				<div>
					<dt class="tron-text-muted">Lot Number</dt>
					<dd class="tron-text font-mono">{lot.lotNumber ?? '—'}</dd>
				</div>
				<div>
					<dt class="tron-text-muted">Barcode / Lot ID</dt>
					<dd class="tron-text font-mono">{lot.lotId}</dd>
				</div>
				<div>
					<dt class="tron-text-muted">Quantity</dt>
					<dd class="tron-text font-medium">{lot.quantity}</dd>
				</div>
				<div>
					<dt class="tron-text-muted">PO Reference</dt>
					<dd class="tron-text">{lot.poReference ?? '—'}</dd>
				</div>
				<div>
					<dt class="tron-text-muted">Supplier</dt>
					<dd class="tron-text">{lot.supplier ?? '—'}</dd>
				</div>
				<div>
					<dt class="tron-text-muted">Vendor Lot #</dt>
					<dd class="tron-text font-mono">{lot.vendorLotNumber ?? '—'}</dd>
				</div>
				{#if lot.bagBarcode}
					<div>
						<dt class="tron-text-muted">Bag Barcode</dt>
						<dd class="tron-text font-mono">{lot.bagBarcode}</dd>
					</div>
				{/if}
				{#if lot.serialNumber}
					<div>
						<dt class="tron-text-muted">Serial Number</dt>
						<dd class="tron-text font-mono">{lot.serialNumber}</dd>
					</div>
				{/if}
				<div>
					<dt class="tron-text-muted">Expiration Date</dt>
					<dd class="tron-text">{formatDate(lot.expirationDate)}</dd>
				</div>
				<div>
					<dt class="tron-text-muted">Operator</dt>
					<dd class="tron-text">{lot.operator?.username ?? '—'}</dd>
				</div>
				<div>
					<dt class="tron-text-muted">Created</dt>
					<dd class="tron-text">{formatDateTime(lot.createdAt)}</dd>
				</div>
				{#if lot.storageConditionsRequired}
					<div>
						<dt class="tron-text-muted">Storage Conditions</dt>
						<dd class="text-yellow-400 font-medium">Required</dd>
					</div>
				{/if}
				{#if lot.esdHandlingRequired}
					<div>
						<dt class="tron-text-muted">ESD Handling</dt>
						<dd class="text-yellow-400 font-medium">Required</dd>
					</div>
				{/if}
			</dl>
		</div>

		<!-- Checklist -->
		{#if lot.checklist}
			<div class="tron-card p-4">
				<h2 class="tron-text mb-3 text-sm font-semibold tracking-wider uppercase">Receiving Checklist</h2>
				<div class="space-y-2">
					{#each Object.entries(lot.checklist) as [key, value]}
						<div class="flex items-center justify-between text-sm">
							<span class="tron-text">{checklistLabel(key)}</span>
							<span class="rounded px-2 py-0.5 text-xs font-medium uppercase
								{value === 'yes' ? 'bg-green-500/20 text-green-400' :
								 value === 'no' ? 'bg-red-500/20 text-red-400' :
								 'bg-gray-500/20 text-gray-400'}">
								{value}
							</span>
						</div>
					{/each}
				</div>
				{#if lot.formFitFunctionCheck}
					<div class="mt-3 flex items-center justify-between border-t border-white/10 pt-3 text-sm">
						<span class="tron-text">Form-Fit-Function Check</span>
						<span class="rounded px-2 py-0.5 text-xs font-medium uppercase
							{lot.formFitFunctionCheck === 'pass' ? 'bg-green-500/20 text-green-400' :
							 lot.formFitFunctionCheck === 'fail' ? 'bg-red-500/20 text-red-400' :
							 'bg-gray-500/20 text-gray-400'}">
							{lot.formFitFunctionCheck}
						</span>
					</div>
				{/if}
			</div>
		{/if}

		<!-- CoC -->
		{#if lot.cocDocumentUrl}
			<div class="tron-card p-4">
				<h2 class="tron-text mb-3 text-sm font-semibold tracking-wider uppercase">Certificate of Conformity</h2>
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
				<a href={lot.cocDocumentUrl} target="_blank" rel="noopener noreferrer"
					class="flex items-center gap-3 rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/5 px-4 py-3 transition-colors hover:bg-[var(--color-tron-cyan)]/10">
					<svg class="h-8 w-8 shrink-0 text-[var(--color-tron-cyan)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
						<path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
					</svg>
					<div class="flex-1">
						<div class="text-sm font-medium text-[var(--color-tron-cyan)]">View CoC Document</div>
						<div class="text-xs text-[var(--color-tron-text-secondary)]">Click to open in Box.com</div>
					</div>
					<svg class="h-5 w-5 text-[var(--color-tron-cyan)]/60" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
					</svg>
				</a>
				{#if lot.cocMeetsStandards !== undefined && lot.cocMeetsStandards !== null}
					<div class="mt-2">
						<span class="rounded px-2 py-0.5 text-xs font-medium
							{lot.cocMeetsStandards ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}">
							{lot.cocMeetsStandards ? 'Meets Standards' : 'Does Not Meet Standards'}
						</span>
					</div>
				{/if}
			</div>
		{/if}

		<!-- Tool Confirmations -->
		{#if toolConfirmations.length > 0}
			<div class="tron-card p-4">
				<h2 class="tron-text mb-3 text-sm font-semibold tracking-wider uppercase">Tools Confirmed</h2>
				<div class="space-y-1">
					{#each toolConfirmations as tool}
						<div class="flex items-center justify-between text-sm">
							<span class="tron-text">{tool.toolName} <span class="tron-text-muted font-mono text-xs">({tool.toolId})</span></span>
							<span class="tron-text-muted text-xs">{tool.confirmedBy?.username ?? '—'} at {formatDateTime(tool.confirmedAt)}</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Inspection Results -->
		{#if inspectionResults.length > 0}
			<div class="tron-card p-4">
				<h2 class="tron-text mb-3 text-sm font-semibold tracking-wider uppercase">Inspection Results</h2>
				{#if lot.ipResults}
					<div class="mb-3 flex items-center gap-3 text-sm">
						<span class="rounded px-2 py-0.5 text-xs font-medium uppercase
							{lot.ipResults.result === 'accepted' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}">
							{lot.ipResults.result}
						</span>
						<span class="tron-text-muted">
							{lot.ipResults.passRate?.toFixed(1)}% pass rate (required: {lot.ipResults.percentRequired}%)
						</span>
					</div>
				{/if}

				<div class="overflow-x-auto">
					<table class="w-full text-left text-sm">
						<thead>
							<tr class="tron-border-b border-b">
								<th class="tron-text-muted px-3 py-2 font-medium">Sample</th>
								<th class="tron-text-muted px-3 py-2 font-medium">Step</th>
								<th class="tron-text-muted px-3 py-2 font-medium">Check</th>
								<th class="tron-text-muted px-3 py-2 font-medium">Type</th>
								<th class="tron-text-muted px-3 py-2 font-medium">Value</th>
								<th class="tron-text-muted px-3 py-2 font-medium">Result</th>
								<th class="tron-text-muted px-3 py-2 font-medium">Notes</th>
							</tr>
						</thead>
						<tbody>
							{#each inspectionResults as result}
								<tr class="tron-border-b hover:bg-white/5 border-b">
									<td class="px-3 py-2">{result.sampleNumber}</td>
									<td class="px-3 py-2">{result.stepOrder}</td>
									<td class="tron-text px-3 py-2 text-xs">{result.questionLabel}</td>
									<td class="tron-text-muted px-3 py-2 text-xs">{result.inputType}</td>
									<td class="tron-text px-3 py-2 font-mono text-xs">{result.actualValue}</td>
									<td class="px-3 py-2">
										<span class="rounded px-2 py-0.5 text-xs font-medium
											{result.result === 'pass' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}">
											{result.result}
										</span>
									</td>
									<td class="tron-text-muted max-w-xs truncate px-3 py-2 text-xs">{result.notes ?? '—'}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</div>
		{/if}

		<!-- Override Info -->
		{#if lot.overrideApplied}
			<div class="tron-card border-l-4 border-yellow-500 p-4">
				<h2 class="mb-2 text-sm font-semibold tracking-wider uppercase text-yellow-400">Override Applied</h2>
				<dl class="grid gap-3 text-sm sm:grid-cols-2">
					<div>
						<dt class="tron-text-muted">Reason</dt>
						<dd class="tron-text">{lot.overrideReason ?? '—'}</dd>
					</div>
					<div>
						<dt class="tron-text-muted">Approved By</dt>
						<dd class="tron-text">{lot.overrideBy?.username ?? '—'} at {formatDateTime(lot.overrideAt)}</dd>
					</div>
				</dl>
			</div>
		{/if}

		<!-- Notes -->
		{#if lot.notes}
			<div class="tron-card p-4">
				<h2 class="tron-text mb-3 text-sm font-semibold tracking-wider uppercase">Notes</h2>
				<p class="tron-text whitespace-pre-wrap text-sm">{lot.notes}</p>
			</div>
		{/if}

		<!-- Photos -->
		{#if lot.photos && lot.photos.length > 0}
			<div class="tron-card p-4">
				<h2 class="tron-text mb-3 text-sm font-semibold tracking-wider uppercase">Photos ({lot.photos.length})</h2>
				<div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
					{#each lot.photos as photo, i}
						<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
						<a href={photo} target="_blank" rel="noopener noreferrer"
							class="flex items-center gap-3 rounded-lg border border-purple-500/20 bg-purple-500/5 px-4 py-3 transition-colors hover:bg-purple-500/10">
							<svg class="h-8 w-8 shrink-0 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
								<path stroke-linecap="round" stroke-linejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z" />
							</svg>
							<div class="flex-1 min-w-0">
								<div class="text-sm font-medium text-purple-300">Photo {i + 1}</div>
								<div class="text-xs text-[var(--color-tron-text-secondary)]">Click to view</div>
							</div>
							<svg class="h-4 w-4 shrink-0 text-purple-400/60" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
								<path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
							</svg>
						</a>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Additional Documents -->
		{#if lot.additionalDocuments && lot.additionalDocuments.length > 0}
			<div class="tron-card p-4">
				<h2 class="tron-text mb-3 text-sm font-semibold tracking-wider uppercase">Documents ({lot.additionalDocuments.length})</h2>
				<div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
					{#each lot.additionalDocuments as doc, i}
						<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
						<a href={doc} target="_blank" rel="noopener noreferrer"
							class="flex items-center gap-3 rounded-lg border border-blue-500/20 bg-blue-500/5 px-4 py-3 transition-colors hover:bg-blue-500/10">
							<svg class="h-8 w-8 shrink-0 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
								<path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
							</svg>
							<div class="flex-1 min-w-0">
								<div class="text-sm font-medium text-blue-300">Document {i + 1}</div>
								<div class="text-xs text-[var(--color-tron-text-secondary)]">Click to view</div>
							</div>
							<svg class="h-4 w-4 shrink-0 text-blue-400/60" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
								<path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
							</svg>
						</a>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Disposition -->
		{#if lot.disposedAt}
			<div class="tron-card p-4">
				<h2 class="tron-text mb-3 text-sm font-semibold tracking-wider uppercase">Disposition</h2>
				<dl class="grid gap-4 text-sm sm:grid-cols-2">
					<div>
						<dt class="tron-text-muted">Type</dt>
						<dd class="tron-text font-medium uppercase">{lot.dispositionType ?? lot.status}</dd>
					</div>
					<div>
						<dt class="tron-text-muted">Dispositioned By</dt>
						<dd class="tron-text">{lot.disposedBy?.username ?? '—'} at {formatDateTime(lot.disposedAt)}</dd>
					</div>
					{#if lot.ncNumber}
						<div>
							<dt class="tron-text-muted">NC Number</dt>
							<dd class="tron-text font-mono text-red-400">{lot.ncNumber}</dd>
						</div>
					{/if}
					{#if lot.rmaNumber}
						<div>
							<dt class="tron-text-muted">RMA Number</dt>
							<dd class="tron-text font-mono">{lot.rmaNumber}</dd>
						</div>
					{/if}
					{#if lot.totalRejects}
						<div>
							<dt class="tron-text-muted">Total Rejects</dt>
							<dd class="tron-text text-red-400">{lot.totalRejects}</dd>
						</div>
					{/if}
					{#if lot.defectDescription}
						<div class="sm:col-span-2">
							<dt class="tron-text-muted">Defect Description</dt>
							<dd class="tron-text">{lot.defectDescription}</dd>
						</div>
					{/if}
					{#if lot.dispositionExplanation}
						<div class="sm:col-span-2">
							<dt class="tron-text-muted">Explanation</dt>
							<dd class="tron-text">{lot.dispositionExplanation}</dd>
						</div>
					{/if}
				</dl>
			</div>
		{/if}

		<!-- Disposition Action (for in_progress lots only) -->
		{#if !isCompleted}
			<div class="tron-card p-4">
				{#if !showDisposition}
					<button
						type="button"
						onclick={() => (showDisposition = true)}
						class="tron-button w-full px-4 py-2 text-sm font-medium"
					>
						Complete Disposition
					</button>
				{:else}
					<h2 class="tron-text mb-4 text-sm font-semibold tracking-wider uppercase">Final Disposition</h2>
					<form
						method="POST"
						action="?/disposeLot"
						use:enhance={() => {
							disposing = true;
							return async ({ update }) => {
								disposing = false;
								await update();
							};
						}}
					>
						<div class="space-y-4">
							<div>
								<label for="dispositionType" class="tron-text-muted mb-1 block text-xs">Disposition *</label>
								<select
									id="dispositionType"
									name="dispositionType"
									bind:value={dispositionType}
									class="tron-input w-full px-3 py-2 text-sm"
								>
									<option value="accepted">Accepted</option>
									<option value="rejected">Rejected</option>
									<option value="returned">Return to Supplier</option>
									<option value="other">Other</option>
								</select>
							</div>

							{#if dispositionType === 'rejected'}
								<div class="grid gap-4 sm:grid-cols-2">
									<div>
										<label for="totalRejects" class="tron-text-muted mb-1 block text-xs">Total Rejects</label>
										<input id="totalRejects" name="totalRejects" type="number" min="0"
											bind:value={totalRejects} class="tron-input w-full px-3 py-2 text-sm" />
									</div>
									<div>
										<label for="defectDescription" class="tron-text-muted mb-1 block text-xs">Defect Description</label>
										<textarea id="defectDescription" name="defectDescription"
											bind:value={defectDescription} rows="2"
											class="tron-input w-full px-3 py-2 text-sm"></textarea>
									</div>
								</div>
							{/if}

							{#if dispositionType === 'returned'}
								<div>
									<label for="rmaNumber" class="tron-text-muted mb-1 block text-xs">RMA Number</label>
									<input id="rmaNumber" name="rmaNumber" type="text"
										bind:value={rmaNumber} class="tron-input w-full px-3 py-2 text-sm" />
								</div>
							{/if}

							{#if dispositionType === 'other'}
								<div>
									<label for="dispositionExplanation" class="tron-text-muted mb-1 block text-xs">Explanation *</label>
									<textarea id="dispositionExplanation" name="dispositionExplanation"
										bind:value={dispositionExplanation} rows="3"
										class="tron-input w-full px-3 py-2 text-sm"
										placeholder="Explain the disposition decision..."></textarea>
								</div>
							{/if}

							<div class="flex gap-2">
								<button
									type="submit"
									disabled={disposing || (dispositionType === 'other' && !dispositionExplanation.trim())}
									class="tron-button flex-1 px-4 py-2 text-sm font-medium disabled:opacity-50"
								>
									{disposing ? 'Saving...' : 'Confirm Disposition'}
								</button>
								<button
									type="button"
									onclick={() => (showDisposition = false)}
									class="rounded border border-white/20 px-4 py-2 text-sm text-white/60 hover:bg-white/5"
								>
									Cancel
								</button>
							</div>
						</div>
					</form>
				{/if}
			</div>
		{/if}
	</div>
</div>
