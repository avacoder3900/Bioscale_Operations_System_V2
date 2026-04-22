<script lang="ts">
	import { TronCard, TronBadge } from '$lib/components/ui';
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';

	let { data, form: _form } = $props();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const form = _form as any;

	// Tab state
	let activeTab = $state<'overview' | 'transactions' | 'receiving'>('overview');

	// Filter state
	let typeFilter = $state(data.filters.type ?? '');
	let startDate = $state(data.filters.startDate ?? '');
	let endDate = $state(data.filters.endDate ?? '');
	let retractedFilter = $state(data.filters.retracted ?? '');

	// Retraction state
	let retractingId = $state<string | null>(null);
	let retractReason = $state('');
	let retracting = $state(false);

	// Admin edit transaction state
	let editingTxnId = $state<string | null>(null);
	let editTxnQuantity = $state(0);
	let editTxnReason = $state('');
	let editingTxn = $state(false);
	let editTxnSuccess = $state(false);

	function formatCurrency(value: number | null): string {
		if (value === null || value === undefined) return '—';
		if (isNaN(value)) return '—';
		return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
	}

	function formatDate(date: Date | string | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleDateString();
	}

	function formatDateTime(date: Date | string | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleString();
	}

	function applyFilters() {
		const params = new URLSearchParams();
		if (typeFilter) params.set('type', typeFilter);
		if (startDate) params.set('startDate', startDate);
		if (endDate) params.set('endDate', endDate);
		if (retractedFilter) params.set('retracted', retractedFilter);
		const qs = params.toString();
		goto(`?${qs}`, { invalidateAll: true });
	}

	function clearFilters() {
		typeFilter = '';
		startDate = '';
		endDate = '';
		retractedFilter = '';
		goto('?', { invalidateAll: true });
	}

	let hasActiveFilters = $derived(
		Boolean(typeFilter || startDate || endDate || retractedFilter)
	);

	let item = $derived(data.item);
	let totalValue = $derived((item.unitCost ?? 0) * (item.inventoryCount ?? 0));
	let isCritical = $derived(item.category === 'Critical');
	let hazardEmpty = $derived(!item.hazardClass);
	let expirationEmpty = $derived(!item.expirationDate);
	let certsEmpty = $derived(
		!item.certifications || !Array.isArray(item.certifications) || item.certifications.length === 0
	);
	let msdsEmpty = $derived(!item.msdsFileId);

	let editingMinStock = $state(false);
	let minStockInput = $state(item.minimumStockLevel);
	let historyOpen = $state(false);

	let editingInspectionConfig = $state(false);
	let sampleSizeInput = $state(item.inspectionConfig?.sampleSize ?? 1);
	let percentAcceptedInput = $state(item.inspectionConfig?.percentAccepted ?? 100);

	$effect(() => {
		if (!editingMinStock) {
			minStockInput = item.minimumStockLevel;
		}
	});

	function describeChange(entry: { action: string; oldData: unknown; newData: unknown }): string {
		const oldObj = entry.oldData as Record<string, unknown> | null;
		const newObj = entry.newData as Record<string, unknown> | null;
		if (!oldObj && !newObj) return entry.action;

		const changes: string[] = [];
		const allKeys = new Set([...Object.keys(oldObj ?? {}), ...Object.keys(newObj ?? {})]);

		for (const key of allKeys) {
			const oldVal = oldObj?.[key];
			const newVal = newObj?.[key];
			if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
				changes.push(`${key}: ${oldVal ?? '—'} → ${newVal ?? '—'}`);
			}
		}

		return changes.length > 0 ? changes.join(', ') : entry.action;
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-start justify-between">
		<div>
			<div class="flex items-center gap-3">
				<!-- eslint-disable svelte/no-navigation-without-resolve -->
				<a
					href="/parts"
					class="tron-text-muted hover:text-[var(--color-tron-cyan)]"
					aria-label="Back to parts"
				>
					<svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M10 19l-7-7m0 0l7-7m-7 7h18"
						/>
					</svg>
				</a>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
				<h2 class="tron-text-primary font-mono text-2xl font-bold">{item.partNumber}</h2>
				{#if item.isActive}
					<TronBadge variant="success">Active</TronBadge>
				{:else}
					<TronBadge variant="neutral">Inactive</TronBadge>
				{/if}
			</div>
			<p class="tron-text-muted mt-1 ml-9">{item.name}</p>
		</div>
	</div>

	<!-- Success/Error feedback -->
	{#if form?.success}
		<div
			class="rounded border border-[var(--color-tron-green)] bg-[color-mix(in_srgb,var(--color-tron-green)_10%,transparent)] px-4 py-2 text-[var(--color-tron-green)]"
		>
			Minimum stock level updated successfully.
		</div>
	{/if}
	{#if editTxnSuccess}
		<div
			class="rounded border border-[var(--color-tron-green)] bg-[color-mix(in_srgb,var(--color-tron-green)_10%,transparent)] px-4 py-2 text-[var(--color-tron-green)]"
		>
			Transaction updated successfully.
		</div>
	{/if}
	{#if form?.error}
		<div
			class="rounded border border-[var(--color-tron-error)] bg-[color-mix(in_srgb,var(--color-tron-error)_10%,transparent)] px-4 py-2 text-[var(--color-tron-error)]"
		>
			{form.error}
		</div>
	{/if}

	<!-- Tab Bar -->
	<div class="tab-bar">
		<button
			class="tab-btn"
			class:active={activeTab === 'overview'}
			onclick={() => (activeTab = 'overview')}
		>
			<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
			</svg>
			Overview
		</button>
		<button
			class="tab-btn"
			class:active={activeTab === 'transactions'}
			onclick={() => (activeTab = 'transactions')}
		>
			<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
			</svg>
			Transaction History
			{#if data.inventoryTransactions.length > 0}
				<span class="tab-count">{data.inventoryTransactions.length}</span>
			{/if}
		</button>
		<button
			class="tab-btn"
			class:active={activeTab === 'receiving'}
			onclick={() => (activeTab = 'receiving')}
		>
			<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
			</svg>
			Receiving Lots
			{#if data.receivingLots?.length > 0}
				<span class="tab-count">{data.receivingLots.length}</span>
			{/if}
		</button>
	</div>

	<!-- ===== OVERVIEW TAB ===== -->
	{#if activeTab === 'overview'}
		<!-- Main Info Grid -->
		<div class="grid gap-6 lg:grid-cols-2">
			<!-- Basic Information -->
			<TronCard>
				<h3 class="tron-text-primary mb-4 text-lg font-semibold">Basic Information</h3>
				<dl class="space-y-3">
					<div class="flex justify-between">
						<dt class="tron-text-muted">Part Number</dt>
						<dd class="font-mono text-[var(--color-tron-cyan)]">{item.partNumber}</dd>
					</div>
					<div class="flex justify-between">
						<dt class="tron-text-muted">Name</dt>
						<dd class="tron-text-primary">{item.name}</dd>
					</div>
					<div class="flex justify-between">
						<dt class="tron-text-muted">Description</dt>
						<dd class="tron-text-primary max-w-xs text-right">{item.description || '—'}</dd>
					</div>
					<div class="flex justify-between">
						<dt class="tron-text-muted">Classification</dt>
						<dd>
							{#if item.category}
								<TronBadge variant="neutral">{item.category}</TronBadge>
							{:else}
								<span class="tron-text-muted">—</span>
							{/if}
						</dd>
					</div>
					<div class="flex justify-between">
						<dt class="tron-text-muted">Inspection Pathway</dt>
						<dd>
							{#if item.inspectionPathway === 'ip'}
								<TronBadge variant="warning">IP</TronBadge>
							{:else}
								<TronBadge variant="info">COC</TronBadge>
							{/if}
						</dd>
					</div>
				</dl>
			</TronCard>

			<!-- Inventory & Pricing -->
			<TronCard>
				<h3 class="tron-text-primary mb-4 text-lg font-semibold">Inventory & Pricing</h3>
				<dl class="space-y-3">
					<div class="flex justify-between">
						<dt class="tron-text-muted">Quantity Per Unit</dt>
						<dd class="tron-text-primary font-mono">{item.quantityPerUnit}</dd>
					</div>
					<div class="flex justify-between">
						<dt class="tron-text-muted">Inventory Count</dt>
						<dd
							class="font-mono {(item.inventoryCount ?? 0) <= item.minimumStockLevel
								? 'text-[var(--color-tron-orange)]'
								: 'tron-text-primary'}"
						>
							{item.inventoryCount ?? 0}
						</dd>
					</div>
					<div class="flex items-center justify-between">
						<dt class="tron-text-muted">Minimum Stock Level</dt>
						<dd class="flex items-center gap-2">
							{#if editingMinStock}
								<form
									method="POST"
									action="?/updateMinStockLevel"
									use:enhance={() => {
										return async ({ update }) => {
											editingMinStock = false;
											await update();
										};
									}}
									class="flex items-center gap-2"
								>
									<input
										type="number"
										name="minimumStockLevel"
										bind:value={minStockInput}
										min="0"
										class="w-20 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] px-2 py-1 text-right font-mono text-[var(--color-tron-text)]"
									/>
									<button
										type="submit"
										class="rounded bg-[var(--color-tron-cyan)] px-2 py-1 text-xs font-semibold text-black"
									>
										Save
									</button>
									<button
										type="button"
										onclick={() => {
											editingMinStock = false;
											minStockInput = item.minimumStockLevel;
										}}
										class="tron-text-muted px-2 py-1 text-xs hover:text-[var(--color-tron-text)]"
									>
										Cancel
									</button>
								</form>
							{:else}
								<span class="tron-text-primary font-mono">{item.minimumStockLevel}</span>
								<button
									type="button"
									onclick={() => {
										editingMinStock = true;
										minStockInput = item.minimumStockLevel;
									}}
									class="tron-text-muted hover:text-[var(--color-tron-cyan)]"
									aria-label="Edit minimum stock level"
								>
									<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
										/>
									</svg>
								</button>
							{/if}
						</dd>
					</div>
					<div class="flex justify-between">
						<dt class="tron-text-muted">Unit Cost</dt>
						<dd class="font-mono text-[var(--color-tron-cyan)]">{formatCurrency(item.unitCost)}</dd>
					</div>
					<div class="flex justify-between border-t border-[var(--color-tron-border)] pt-3">
						<dt class="tron-text-primary font-semibold">Total Value</dt>
						<dd class="font-mono text-lg text-[var(--color-tron-cyan)]">
							{formatCurrency(totalValue)}
						</dd>
					</div>
				</dl>
			</TronCard>

			<!-- Sourcing Information -->
			<TronCard>
				<h3 class="tron-text-primary mb-4 text-lg font-semibold">Sourcing</h3>
				<dl class="space-y-3">
					<div class="flex justify-between">
						<dt class="tron-text-muted">Manufacturer</dt>
						<dd class="tron-text-primary">{item.manufacturer || '—'}</dd>
					</div>
					<div class="flex justify-between">
						<dt class="tron-text-muted">Supplier</dt>
						<dd class="tron-text-primary">{item.supplier || '—'}</dd>
					</div>
					<div class="flex justify-between">
						<dt class="tron-text-muted">Vendor Part Number</dt>
						<dd class="tron-text-primary font-mono">{item.vendorPartNumber || '—'}</dd>
					</div>
					<div class="flex justify-between">
						<dt class="tron-text-muted">Lead Time</dt>
						<dd class="tron-text-primary">{item.leadTimeDays ? `${item.leadTimeDays} days` : '—'}</dd>
					</div>
				</dl>
			</TronCard>

			<!-- Compliance Information -->
			<TronCard>
				<div class="mb-4 flex items-center gap-2">
					<h3 class="tron-text-primary text-lg font-semibold">Compliance</h3>
					{#if isCritical}
						<TronBadge variant="warning">Critical Part</TronBadge>
					{/if}
				</div>
				<dl class="space-y-3">
					<div
						class="flex items-center justify-between {isCritical && hazardEmpty
							? 'rounded border border-[var(--color-tron-orange)] bg-[color-mix(in_srgb,var(--color-tron-orange)_8%,transparent)] px-2 py-1'
							: ''}"
					>
						<dt class="tron-text-muted">Hazard Class</dt>
						<dd class="tron-text-primary">
							{#if hazardEmpty && isCritical}
								<span class="flex items-center gap-1 text-[var(--color-tron-orange)]">
									<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"
										><path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z"
										/></svg
									>
									Not specified
								</span>
							{:else}
								{item.hazardClass || '—'}
							{/if}
						</dd>
					</div>

					<div
						class="flex items-center justify-between {isCritical && expirationEmpty
							? 'rounded border border-[var(--color-tron-orange)] bg-[color-mix(in_srgb,var(--color-tron-orange)_8%,transparent)] px-2 py-1'
							: ''}"
					>
						<dt class="tron-text-muted">Expiration Date</dt>
						<dd class="tron-text-primary">
							{#if expirationEmpty && isCritical}
								<span class="flex items-center gap-1 text-[var(--color-tron-orange)]">
									<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"
										><path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z"
										/></svg
									>
									Not specified
								</span>
							{:else}
								{formatDate(item.expirationDate)}
							{/if}
						</dd>
					</div>

					<div
						class="flex items-center justify-between {isCritical && certsEmpty
							? 'rounded border border-[var(--color-tron-orange)] bg-[color-mix(in_srgb,var(--color-tron-orange)_8%,transparent)] px-2 py-1'
							: ''}"
					>
						<dt class="tron-text-muted">Certifications</dt>
						<dd class="tron-text-primary">
							{#if item.certifications && Array.isArray(item.certifications) && item.certifications.length > 0}
								{item.certifications.join(', ')}
							{:else if isCritical}
								<span class="flex items-center gap-1 text-[var(--color-tron-orange)]">
									<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"
										><path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z"
										/></svg
									>
									Not specified
								</span>
							{:else}
								—
							{/if}
						</dd>
					</div>

					<div
						class="flex items-center justify-between {isCritical && msdsEmpty
							? 'rounded border border-[var(--color-tron-orange)] bg-[color-mix(in_srgb,var(--color-tron-orange)_8%,transparent)] px-2 py-1'
							: ''}"
					>
						<dt class="tron-text-muted">MSDS File</dt>
						<dd class="tron-text-primary">
							{#if msdsEmpty && isCritical}
								<span class="flex items-center gap-1 text-[var(--color-tron-orange)]">
									<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"
										><path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z"
										/></svg
									>
									Not specified
								</span>
							{:else}
								{item.msdsFileId ? 'Available' : '—'}
							{/if}
						</dd>
					</div>
				</dl>
			</TronCard>
		</div>

		<!-- Metadata -->
		<TronCard>
			<h3 class="tron-text-primary mb-4 text-lg font-semibold">Record Information</h3>
			<dl class="grid gap-4 sm:grid-cols-3">
				<div>
					<dt class="tron-text-muted text-sm">Created</dt>
					<dd class="tron-text-primary">{formatDateTime(item.createdAt)}</dd>
				</div>
				<div>
					<dt class="tron-text-muted text-sm">Last Updated</dt>
					<dd class="tron-text-primary">{formatDateTime(item.updatedAt)}</dd>
				</div>
				<div>
					<dt class="tron-text-muted text-sm">Box Row Index</dt>
					<dd class="tron-text-primary font-mono">{item.boxRowIndex ?? '—'}</dd>
				</div>
			</dl>
		</TronCard>

		<!-- Inspection Configuration (for IP pathway parts) -->
		{#if item.inspectionPathway === 'ip'}
			<TronCard>
				<div class="mb-4 flex items-center justify-between">
					<div class="flex items-center gap-2">
						<h3 class="tron-text-primary text-lg font-semibold">Inspection Configuration</h3>
						<TronBadge variant="warning">IP</TronBadge>
					</div>
					{#if !editingInspectionConfig}
						<button
							type="button"
							class="rounded border border-[var(--color-tron-border)] px-2.5 py-1 text-xs text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]"
							onclick={() => (editingInspectionConfig = true)}
						>
							Edit
						</button>
					{/if}
				</div>

				{#if form?.inspectionConfigError}
					<div class="mb-4 rounded border border-[var(--color-tron-error)] bg-[color-mix(in_srgb,var(--color-tron-error)_10%,transparent)] px-4 py-2 text-sm text-[var(--color-tron-error)]">
						{form.inspectionConfigError}
					</div>
				{/if}
				{#if form?.inspectionConfigSuccess}
					<div class="mb-4 rounded border border-[var(--color-tron-green)] bg-[color-mix(in_srgb,var(--color-tron-green)_10%,transparent)] px-4 py-2 text-sm text-[var(--color-tron-green)]">
						Inspection config updated.
					</div>
				{/if}

				{#if editingInspectionConfig}
					<form
						method="POST"
						action="?/updateInspectionConfig"
						use:enhance={() => {
							return async ({ update }) => {
								editingInspectionConfig = false;
								await update();
							};
						}}
					>
						<div class="grid gap-4 sm:grid-cols-2">
							<div>
								<label for="sampleSizeInput" class="tron-text-muted mb-1 block text-xs">Sample Size</label>
								<input
									id="sampleSizeInput"
									name="sampleSize"
									type="number"
									min="1"
									bind:value={sampleSizeInput}
									class="tron-input w-full px-3 py-2 text-sm"
								/>
								<p class="tron-text-muted mt-1 text-xs">Number of units to inspect per lot</p>
							</div>
							<div>
								<label for="percentAcceptedInput" class="tron-text-muted mb-1 block text-xs">Percent Accepted (0–100)</label>
								<input
									id="percentAcceptedInput"
									name="percentAccepted"
									type="number"
									min="0"
									max="100"
									step="0.1"
									bind:value={percentAcceptedInput}
									class="tron-input w-full px-3 py-2 text-sm"
								/>
								<p class="tron-text-muted mt-1 text-xs">Minimum passing rate to accept a lot</p>
							</div>
						</div>
						<div class="mt-4 flex gap-2">
							<button
								type="submit"
								class="rounded bg-[var(--color-tron-cyan)] px-4 py-1.5 text-sm font-semibold text-black"
							>
								Save
							</button>
							<button
								type="button"
								onclick={() => (editingInspectionConfig = false)}
								class="rounded border border-[var(--color-tron-border)] px-4 py-1.5 text-sm text-[var(--color-tron-text-secondary)]"
							>
								Cancel
							</button>
						</div>
					</form>
				{:else}
					<dl class="grid gap-4 sm:grid-cols-2">
						<div>
							<dt class="tron-text-muted text-sm">Sample Size</dt>
							<dd class="tron-text-primary font-medium">{data.sampleSize ?? 1} units</dd>
						</div>
						<div>
							<dt class="tron-text-muted text-sm">Acceptance Threshold</dt>
							<dd class="tron-text-primary font-medium">{data.percentAccepted ?? 100}% pass rate required</dd>
						</div>
					</dl>
				{/if}
			</TronCard>

			<!-- IP Revision History -->
			<IpRevisionHistory
				revisions={data.ipRevisions ?? []}
				partDefinitionId={data.partDefinitionId ?? item.id}
				ipError={form?.ipError as string | null ?? null}
				ipSuccess={form?.ipSuccess === true}
			/>

			<!-- IP Form Definition Editor (only if there's a current revision) -->
			{#if currentRevision}
				<IpFormDefinitionEditor
					revisionId={currentRevision.id}
					formDefinition={currentRevision.formDefinition}
					formDefError={form?.formDefError as string | null ?? null}
					formDefSuccess={form?.formDefSuccess === true}
				/>
			{/if}
		{/if}

		<!-- Version History -->
		{#if data.versions.length > 0}
			<TronCard>
				<h3 class="tron-text-primary mb-4 text-lg font-semibold">Change History</h3>
				<div class="overflow-x-auto">
					<table class="tron-table">
						<thead>
							<tr>
								<th>Version</th>
								<th>Change Type</th>
								<th>Changed At</th>
								<th>Reason</th>
							</tr>
						</thead>
						<tbody>
							{#each data.versions as version (version.id)}
								<tr>
									<td class="font-mono">{version.version}</td>
									<td>
										<TronBadge
											variant={version.changeType === 'create'
												? 'success'
												: version.changeType === 'delete'
													? 'error'
													: 'warning'}
										>
											{version.changeType}
										</TronBadge>
									</td>
									<td>{formatDateTime(version.changedAt)}</td>
									<td class="tron-text-muted">{version.changeReason || '—'}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</TronCard>
		{/if}
	{/if}

	<!-- ===== TRANSACTION HISTORY TAB ===== -->
	{#if activeTab === 'transactions'}
		<!-- Filters -->
		<TronCard>
			<div class="filter-bar">
				<div class="filter-group">
					<label class="filter-label" for="type-filter">Type</label>
					<select id="type-filter" class="filter-input" bind:value={typeFilter} onchange={applyFilters}>
						<option value="">All Types</option>
						<option value="deduction">Deduction</option>
						<option value="receipt">Receipt</option>
						<option value="adjustment">Adjustment</option>
					</select>
				</div>
				<div class="filter-group">
					<label class="filter-label" for="start-date">From</label>
					<input id="start-date" type="date" class="filter-input" bind:value={startDate} onchange={applyFilters} />
				</div>
				<div class="filter-group">
					<label class="filter-label" for="end-date">To</label>
					<input id="end-date" type="date" class="filter-input" bind:value={endDate} onchange={applyFilters} />
				</div>
				<div class="filter-group">
					<label class="filter-label" for="retracted-filter">Status</label>
					<select id="retracted-filter" class="filter-input" bind:value={retractedFilter} onchange={applyFilters}>
						<option value="">All</option>
						<option value="no">Active</option>
						<option value="yes">Retracted</option>
					</select>
				</div>
				{#if hasActiveFilters}
					<button class="clear-filters-btn" onclick={clearFilters}>Clear Filters</button>
				{/if}
			</div>
		</TronCard>

		<!-- Retraction feedback -->
		{#if form?.retractSuccess}
			<div class="success-banner">
				Transaction retracted successfully. {form.restoredQuantity} unit(s) restored to inventory.
			</div>
		{/if}
		{#if form?.retractError}
			<div class="error-banner">{form.retractError}</div>
		{/if}

		<!-- Transaction Table -->
		<TronCard>
			<div class="mb-4 flex items-center justify-between">
				<h3 class="tron-text-primary text-lg font-semibold">Inventory Transactions</h3>
				<span class="text-xs text-[var(--color-tron-text-secondary)]">
					{data.inventoryTransactions.length} transaction{data.inventoryTransactions.length !== 1 ? 's' : ''}
				</span>
			</div>

			{#if data.inventoryTransactions.length === 0}
				<div class="empty-state">
					<p class="tron-text-muted">No transactions found{hasActiveFilters ? ' matching filters' : ''}.</p>
				</div>
			{:else}
				<div class="overflow-x-auto">
					<table class="tron-table">
						<thead>
							<tr>
								<th>Date</th>
								<th>Type</th>
								<th>Quantity</th>
								<th>Balance</th>
								<th>User</th>
								<th>Session</th>
								<th>Actions</th>
							</tr>
						</thead>
						<tbody>
							{#each data.inventoryTransactions as txn (txn.id)}
								<tr class={txn.retractedAt ? 'opacity-50' : ''}>
									<td class="text-sm">{formatDateTime(txn.performedAt)}</td>
									<td>
										<TronBadge
											variant={txn.transactionType === 'deduction'
												? 'warning'
												: txn.transactionType === 'receipt'
													? 'success'
													: 'neutral'}
										>
											{txn.transactionType}
										</TronBadge>
										{#if txn.retractedAt}
											<span class="ml-1 text-xs text-[var(--color-tron-orange)]">(retracted)</span>
										{/if}
									</td>
									<td
										class="font-mono {txn.quantity < 0
											? 'text-[var(--color-tron-red)]'
											: 'text-[var(--color-tron-green)]'}"
									>
										{txn.quantity > 0 ? '+' : ''}{txn.quantity}
									</td>
									<td class="tron-text-muted font-mono">
										{txn.previousQuantity} → {txn.newQuantity}
									</td>
									<td class="tron-text-muted text-sm">{txn.performedByName ?? 'Unknown'}</td>
									<td>
										{#if txn.assemblySessionId}
											<a
												href="/assembly/{txn.assemblySessionId}"
												class="text-xs text-[var(--color-tron-cyan)] hover:underline"
											>
												View Session
											</a>
										{:else}
											<span class="tron-text-muted">—</span>
										{/if}
									</td>
									<td>
										<div class="flex items-center gap-2">
											{#if !txn.retractedAt && txn.transactionType === 'deduction'}
												{#if retractingId === txn.id}
													<form
														method="POST"
														action="?/retractTransaction"
														use:enhance={() => {
															retracting = true;
															return async ({ update }) => {
																retracting = false;
																retractingId = null;
																retractReason = '';
																await update();
															};
														}}
														class="retract-form"
													>
														<input type="hidden" name="transactionId" value={txn.id} />
														<input
															type="text"
															name="reason"
															class="retract-reason-input"
															placeholder="Reason for retraction..."
															bind:value={retractReason}
															required
														/>
														<div class="retract-actions">
															<button
																type="submit"
																class="retract-confirm-btn"
																disabled={retracting || !retractReason.trim()}
															>
																{retracting ? 'Retracting...' : 'Confirm'}
															</button>
															<button
																type="button"
																class="retract-cancel-btn"
																onclick={() => { retractingId = null; retractReason = ''; }}
															>
																Cancel
															</button>
														</div>
													</form>
												{:else}
													<button
														class="retract-btn"
														onclick={() => (retractingId = txn.id)}
													>
														Retract
													</button>
												{/if}
											{:else if !txn.retractedAt}
												<span class="tron-text-muted">—</span>
											{/if}
											{#if data.isAdmin && !txn.retractedAt}
												{#if editingTxnId === txn.id}
													<form
														method="POST"
														action="?/editTransaction"
														use:enhance={() => {
															editingTxn = true;
															return async ({ result, update }) => {
																editingTxn = false;
																if (result.type === 'success' && result.data?.editSuccess) {
																	editTxnSuccess = true;
																	editingTxnId = null;
																	editTxnReason = '';
																	setTimeout(() => { editTxnSuccess = false; }, 3000);
																}
																await update();
															};
														}}
														class="flex flex-col gap-1 min-w-[200px]"
													>
														<input type="hidden" name="transactionId" value={txn.id} />
														<label class="text-xs tron-text-muted">New Quantity</label>
														<input
															type="number"
															name="newQuantity"
															class="w-full px-2 py-1 text-xs rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-dark)] text-[var(--color-tron-text)]"
															bind:value={editTxnQuantity}
															required
														/>
														<textarea
															name="reason"
															class="w-full px-2 py-1 text-xs rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-dark)] text-[var(--color-tron-text)]"
															placeholder="Reason for edit..."
															bind:value={editTxnReason}
															required
															rows="2"
														></textarea>
														<div class="flex gap-1">
															<button
																type="submit"
																class="px-2 py-0.5 text-xs rounded bg-[var(--color-tron-cyan)] text-black font-medium hover:opacity-80"
																disabled={editingTxn || !editTxnReason.trim()}
															>
																{editingTxn ? 'Saving...' : 'Save'}
															</button>
															<button
																type="button"
																class="px-2 py-0.5 text-xs rounded border border-[var(--color-tron-border)] tron-text-muted hover:opacity-80"
																onclick={() => { editingTxnId = null; editTxnReason = ''; }}
															>
																Cancel
															</button>
														</div>
													</form>
												{:else}
													<button
														class="px-2 py-0.5 text-xs rounded border border-[var(--color-tron-border)] tron-text-muted hover:text-[var(--color-tron-cyan)] hover:border-[var(--color-tron-cyan)]"
														onclick={() => { editingTxnId = txn.id; editTxnQuantity = txn.quantity; editTxnReason = ''; }}
													>
														Edit
													</button>
												{/if}
											{/if}
										</div>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</TronCard>
	{/if}

	<!-- Change History (Audit Trail) -->
	<TronCard>
		<button
			type="button"
			onclick={() => {
				historyOpen = !historyOpen;
			}}
			class="flex w-full items-center justify-between"
		>
			<div class="flex items-center gap-2">
				<h3 class="tron-text-primary text-lg font-semibold">Change History</h3>
				{#if data.auditEntries.length > 0}
					<span
						class="rounded-full bg-[var(--color-tron-cyan)] px-2 py-0.5 text-xs font-semibold text-black"
					>
						{data.auditEntries.length}
					</span>
				{/if}
			</div>
			<svg
				class="h-5 w-5 text-[var(--color-tron-cyan)] transition-transform duration-200 {historyOpen
					? 'rotate-180'
					: ''}"
				fill="none"
				viewBox="0 0 24 24"
				stroke="currentColor"
			>
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
			</svg>
		</button>

		{#if historyOpen}
			<div class="mt-4">
				{#if data.auditEntries.length === 0}
					<p class="tron-text-muted py-4 text-center text-sm">No changes recorded yet.</p>
				{:else}
					<div class="space-y-0">
						{#each data.auditEntries as entry, i (entry.id)}
							<div
								class="flex gap-4 border-l-2 border-[var(--color-tron-border)] py-3 pl-4 {i % 2 ===
								0
									? 'bg-[color-mix(in_srgb,var(--color-tron-bg-secondary)_50%,transparent)]'
									: ''}"
							>
								<div class="flex-shrink-0">
									<div
										class="flex h-8 w-8 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--color-tron-cyan)_15%,transparent)]"
									>
										{#if entry.action === 'INSERT'}
											<svg
												class="h-4 w-4 text-[var(--color-tron-green)]"
												fill="none"
												viewBox="0 0 24 24"
												stroke="currentColor"
											>
												<path
													stroke-linecap="round"
													stroke-linejoin="round"
													stroke-width="2"
													d="M12 4v16m8-8H4"
												/>
											</svg>
										{:else if entry.action === 'DELETE'}
											<svg
												class="h-4 w-4 text-[var(--color-tron-error)]"
												fill="none"
												viewBox="0 0 24 24"
												stroke="currentColor"
											>
												<path
													stroke-linecap="round"
													stroke-linejoin="round"
													stroke-width="2"
													d="M20 12H4"
												/>
											</svg>
										{:else}
											<svg
												class="h-4 w-4 text-[var(--color-tron-cyan)]"
												fill="none"
												viewBox="0 0 24 24"
												stroke="currentColor"
											>
												<path
													stroke-linecap="round"
													stroke-linejoin="round"
													stroke-width="2"
													d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
												/>
											</svg>
										{/if}
									</div>
								</div>
								<div class="min-w-0 flex-1">
									<div class="flex items-center gap-2">
										<TronBadge
											variant={entry.action === 'INSERT'
												? 'success'
												: entry.action === 'DELETE'
													? 'error'
													: 'warning'}
										>
											{entry.action}
										</TronBadge>
										<span class="tron-text-muted text-sm">
											by {entry.username ?? 'System'}
										</span>
									</div>
									<p class="tron-text-primary mt-1 font-mono text-sm break-all">
										{describeChange(entry)}
									</p>
									<p class="tron-text-muted mt-0.5 text-xs">
										{formatDateTime(entry.changedAt)}
									</p>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{/if}
	<!-- ===== RECEIVING LOTS TAB ===== -->
	{#if activeTab === 'receiving'}
		<div class="p-4">
			{#if data.receivingLots?.length > 0}
				<div class="mb-3 text-sm tron-text-muted">
					Total received: <strong class="tron-text-primary">{data.receivingLotsTotalQty}</strong> units across {data.receivingLots.length} lot{data.receivingLots.length !== 1 ? 's' : ''}
				</div>
				<div class="overflow-x-auto">
					<table class="w-full text-sm">
						<thead>
							<tr class="border-b" style="border-color: var(--color-tron-border);">
								<th class="text-left p-2 font-medium tron-text-muted">Lot #</th>
								<th class="text-left p-2 font-medium tron-text-muted">Barcode</th>
								<th class="text-right p-2 font-medium tron-text-muted">Qty</th>
								<th class="text-left p-2 font-medium tron-text-muted">Status</th>
								<th class="text-left p-2 font-medium tron-text-muted">Operator</th>
								<th class="text-left p-2 font-medium tron-text-muted">Date</th>
								<th class="text-left p-2 font-medium tron-text-muted">CoC</th>
							</tr>
						</thead>
						<tbody>
							{#each data.receivingLots as lot}
								<tr class="border-b hover:bg-white/5" style="border-color: var(--color-tron-border);">
									<td class="p-2">
										<a href="/parts/accession" class="text-cyan-400 hover:underline font-mono text-xs">{lot.lotNumber}</a>
									</td>
									<td class="p-2 font-mono text-xs tron-text-muted">{lot.bagBarcode || lot.lotId || '—'}</td>
									<td class="p-2 text-right tron-text-primary">{lot.quantity}</td>
									<td class="p-2">
										<span class="px-2 py-0.5 rounded text-xs font-medium" class:bg-green-900={lot.status === 'accepted'} class:text-green-300={lot.status === 'accepted'} class:bg-yellow-900={lot.status === 'pending'} class:text-yellow-300={lot.status === 'pending'} class:bg-red-900={lot.status === 'rejected'} class:text-red-300={lot.status === 'rejected'}>
											{lot.status}
										</span>
									</td>
									<td class="p-2 tron-text-muted">{lot.operator ?? '—'}</td>
									<td class="p-2 tron-text-muted text-xs">{lot.createdAt ? new Date(lot.createdAt).toLocaleDateString() : '—'}</td>
									<td class="p-2">
										{#if lot.cocDocumentUrl}
											<a href={lot.cocDocumentUrl} target="_blank" class="text-cyan-400 hover:underline text-xs">View CoC</a>
										{:else}
											<span class="tron-text-muted text-xs">—</span>
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{:else}
				<div class="empty-state">
					<p class="tron-text-muted">No receiving lots recorded for this part.</p>
					<p class="tron-text-muted text-xs mt-1">Use the <a href="/parts/accession" class="text-cyan-400 hover:underline">ROG</a> page to scan incoming inventory.</p>
				</div>
			{/if}
		</div>
	{/if}
	</TronCard>
</div>

<style>
	/* Tab Bar */
	.tab-bar {
		display: flex;
		gap: 0.5rem;
		border-bottom: 1px solid var(--color-tron-border);
		padding-bottom: 0;
	}

	.tab-btn {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.625rem 1rem;
		min-height: 44px;
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--color-tron-text-secondary);
		background: transparent;
		border: none;
		border-bottom: 2px solid transparent;
		cursor: pointer;
		transition: all 0.2s;
	}

	.tab-btn:hover {
		color: var(--color-tron-cyan);
		background-color: var(--color-tron-bg-tertiary);
	}

	.tab-btn.active {
		color: var(--color-tron-cyan);
		border-bottom-color: var(--color-tron-cyan);
	}

	.tab-count {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.25rem;
		height: 1.25rem;
		padding: 0 0.375rem;
		font-size: 0.6875rem;
		font-weight: 600;
		border-radius: 9999px;
		background-color: var(--color-tron-bg-tertiary);
		border: 1px solid var(--color-tron-border);
		color: var(--color-tron-text-secondary);
	}

	.tab-btn.active .tab-count {
		background-color: rgba(0, 212, 255, 0.15);
		border-color: var(--color-tron-cyan);
		color: var(--color-tron-cyan);
	}

	/* Filters */
	.filter-bar {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
		align-items: flex-end;
	}

	.filter-group {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.filter-label {
		font-size: 0.75rem;
		color: var(--color-tron-text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.filter-input {
		min-height: 36px;
		padding: 0.375rem 0.75rem;
		background-color: var(--color-tron-bg-tertiary);
		border: 1px solid var(--color-tron-border);
		border-radius: 0.375rem;
		color: var(--color-tron-text-primary);
		font-size: 0.875rem;
	}

	.filter-input:focus {
		outline: none;
		border-color: var(--color-tron-cyan);
		box-shadow: 0 0 0 1px var(--color-tron-cyan);
	}

	.clear-filters-btn {
		min-height: 36px;
		padding: 0.375rem 0.75rem;
		background: transparent;
		border: 1px solid var(--color-tron-border);
		border-radius: 0.375rem;
		color: var(--color-tron-text-secondary);
		font-size: 0.75rem;
		cursor: pointer;
		transition: all 0.15s;
	}

	.clear-filters-btn:hover {
		border-color: var(--color-tron-red);
		color: var(--color-tron-red);
	}

	/* Feedback banners */
	.success-banner {
		padding: 0.75rem 1rem;
		border: 1px solid var(--color-tron-green);
		border-radius: 0.5rem;
		background-color: rgba(0, 255, 100, 0.08);
		color: var(--color-tron-green);
		font-size: 0.875rem;
	}

	.error-banner {
		padding: 0.75rem 1rem;
		border: 1px solid var(--color-tron-red);
		border-radius: 0.5rem;
		background-color: rgba(255, 0, 0, 0.08);
		color: var(--color-tron-red);
		font-size: 0.875rem;
	}

	/* Empty state */
	.empty-state {
		padding: 2rem;
		text-align: center;
	}

	/* Retraction UI */
	.retract-btn {
		padding: 0.25rem 0.625rem;
		min-height: 28px;
		font-size: 0.75rem;
		background: transparent;
		border: 1px solid var(--color-tron-orange);
		border-radius: 0.25rem;
		color: var(--color-tron-orange);
		cursor: pointer;
		transition: all 0.15s;
	}

	.retract-btn:hover {
		background-color: rgba(255, 165, 0, 0.1);
	}

	.retract-form {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		min-width: 180px;
	}

	.retract-reason-input {
		padding: 0.25rem 0.5rem;
		background-color: var(--color-tron-bg-tertiary);
		border: 1px solid var(--color-tron-border);
		border-radius: 0.25rem;
		color: var(--color-tron-text-primary);
		font-size: 0.75rem;
	}

	.retract-reason-input:focus {
		outline: none;
		border-color: var(--color-tron-orange);
	}

	.retract-actions {
		display: flex;
		gap: 0.375rem;
	}

	.retract-confirm-btn {
		padding: 0.25rem 0.5rem;
		min-height: 28px;
		font-size: 0.75rem;
		background-color: var(--color-tron-orange);
		color: var(--color-tron-bg-primary);
		border: none;
		border-radius: 0.25rem;
		font-weight: 600;
		cursor: pointer;
	}

	.retract-confirm-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.retract-cancel-btn {
		padding: 0.25rem 0.5rem;
		min-height: 28px;
		font-size: 0.75rem;
		background: transparent;
		border: 1px solid var(--color-tron-border);
		border-radius: 0.25rem;
		color: var(--color-tron-text-secondary);
		cursor: pointer;
	}
</style>
