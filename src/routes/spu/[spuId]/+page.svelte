<script lang="ts">
	import { enhance } from '$app/forms';
	import { TronCard, TronBadge, TronButton } from '$lib/components/ui';
	import SpuStatusBadge from '$lib/components/spu/SpuStatusBadge.svelte';
	import SpuDeviceStateBadge from '$lib/components/spu/SpuDeviceStateBadge.svelte';

	let { data, form } = $props();

	let showStateForm = $state(false);
	let updatingState = $state(false);
	let showRenameForm = $state(false);
	let editingIdentifiers = $state(false);
	let savingIdentifiers = $state(false);
	let editUdi = $state(data.spu.udi);
	let editBarcode = $state(data.spu.barcode ?? '');
	let pinging = $state(false);
	let unlinking = $state(false);
	let renaming = $state(false);

	let editingAssignment = $state(false);
	let editingQc = $state(false);
	let assignmentOverride = $state<string | null>(null);
	let customerIdOverride = $state<string | null>(null);
	let qcOverride = $state<string | null>(null);

	let selectedAssignment = $derived(assignmentOverride ?? data.spu.assignmentType ?? '');
	let selectedCustomerId = $derived(customerIdOverride ?? data.spu.assignmentCustomerId ?? '');
	let selectedQcStatus = $derived(qcOverride ?? data.spu.qcStatus);
	let showCustomerSelect = $derived(selectedAssignment === 'customer');

	function startEditAssignment() {
		assignmentOverride = data.spu.assignmentType ?? '';
		customerIdOverride = data.spu.assignmentCustomerId ?? '';
		editingAssignment = true;
	}

	function cancelEditAssignment() {
		editingAssignment = false;
		assignmentOverride = null;
		customerIdOverride = null;
	}

	function startEditQc() {
		qcOverride = data.spu.qcStatus;
		editingQc = true;
	}

	function cancelEditQc() {
		editingQc = false;
		qcOverride = null;
	}

	function formatDate(date: Date | string | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleString();
	}

	function assignmentLabel(type: string | null, customerName: string | null): string {
		if (!type) return 'Unassigned';
		if (type === 'rnd') return 'R&D';
		if (type === 'manufacturing') return 'Manufacturing';
		if (type === 'customer') return customerName ?? 'Customer';
		return type;
	}

	type BadgeVariant = 'success' | 'error' | 'warning' | 'info' | 'neutral';
	const qcColors: Record<string, BadgeVariant> = {
		pass: 'success',
		fail: 'error',
		pending: 'warning'
	};

	const assemblyStatusColors: Record<string, BadgeVariant> = {
		created: 'neutral',
		in_progress: 'info',
		assembled: 'info',
		tested: 'warning',
		released: 'success',
		on_hold: 'warning',
		scrapped: 'error'
	};

	const assemblyStatusLabels: Record<string, string> = {
		created: 'Created',
		in_progress: 'In Progress',
		assembled: 'Assembled',
		tested: 'Tested',
		released: 'Released',
		on_hold: 'On Hold',
		scrapped: 'Scrapped'
	};

	const ASSEMBLY_STATUSES = [
		'created',
		'in_progress',
		'assembled',
		'tested',
		'released',
		'on_hold',
		'scrapped'
	] as const;

	let editingAssemblyStatus = $state(false);
	let assemblyStatusOverride = $state<string | null>(null);
	let selectedAssemblyStatus = $derived(
		assemblyStatusOverride ?? data.spu.assemblyStatus ?? 'created'
	);
	let showStatusHistory = $state(false);
	let showRecordHistory = $state(false);

	function startEditAssemblyStatus() {
		assemblyStatusOverride = data.spu.assemblyStatus ?? 'created';
		editingAssemblyStatus = true;
	}

	function cancelEditAssemblyStatus() {
		editingAssemblyStatus = false;
		assemblyStatusOverride = null;
	}

	const fieldLabels: Record<string, string> = {
		assignmentType: 'Assignment',
		assignmentCustomerId: 'Customer',
		qcStatus: 'QC Status',
		qcDocumentUrl: 'QC Document',
		assemblyStatus: 'Assembly Status',
		status: 'Status',
		batchId: 'Batch'
	};

	function describeAuditEntry(entry: {
		action: string;
		oldData: Record<string, unknown> | null;
		newData: Record<string, unknown> | null;
	}): string {
		if (entry.action === 'INSERT') return 'SPU record created';
		if (entry.action === 'DELETE') return 'SPU record deleted';
		const oldData = entry.oldData ?? {};
		const newData = entry.newData ?? {};
		const keys = new Set([...Object.keys(oldData), ...Object.keys(newData)]);
		const changes: string[] = [];
		for (const key of keys) {
			const oldVal = JSON.stringify(oldData[key] ?? null);
			const newVal = JSON.stringify(newData[key] ?? null);
			if (oldVal !== newVal) {
				const label = fieldLabels[key] ?? key;
				const from = oldData[key] ?? '—';
				const to = newData[key] ?? '—';
				changes.push(`${label}: ${from} → ${to}`);
			}
		}
		return changes.length > 0 ? changes.join(', ') : 'Record updated';
	}

	$effect(() => {
		if (form?.success) {
			showStateForm = false;
		}
	});
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<h2 class="tron-text-primary font-mono text-2xl font-bold">{data.spu.udi}</h2>
			<p class="tron-text-muted">Device History Record</p>
		</div>
		<div class="flex gap-2">
			<SpuDeviceStateBadge deviceState={data.spu.deviceState} />
			<SpuStatusBadge status={data.spu.status} />
		</div>
	</div>

	{#if form?.error}
		<div
			class="rounded border px-4 py-2 text-sm"
			style="border-color: var(--color-tron-error); color: var(--color-tron-error);"
		>
			{form.error}
		</div>
	{/if}

	<div class="grid grid-cols-1 gap-6 md:grid-cols-2">
		<TronCard>
			<h3 class="tron-text-primary mb-4 text-lg font-medium">Device Information</h3>
			<dl class="space-y-3">
				<div class="flex justify-between">
					<dt class="tron-text-muted">Device ID</dt>
					<dd class="tron-text-primary font-mono text-sm break-all">{data.spu.id}</dd>
				</div>
				<div class="flex justify-between items-start">
					<dt class="tron-text-muted">UDI</dt>
					<dd class="tron-text-primary font-mono">{data.spu.udi}</dd>
				</div>
				<div class="flex justify-between items-start">
					<dt class="tron-text-muted">Barcode</dt>
					<dd class="tron-text-primary font-mono">{data.spu.barcode ?? '—'}</dd>
				</div>
				<div>
					{#if !editingIdentifiers}
						<TronButton variant="ghost" onclick={() => { editingIdentifiers = true; editUdi = data.spu.udi; editBarcode = data.spu.barcode ?? ''; }} style="font-size: 0.75rem; padding: 4px 8px;">
							✏️ Edit UDI / Barcode
						</TronButton>
					{:else}
						<form
							method="POST"
							action="?/updateIdentifiers"
							use:enhance={() => {
								savingIdentifiers = true;
								return async ({ result, update }) => {
									savingIdentifiers = false;
									if (result.type === 'success') {
										editingIdentifiers = false;
									}
									await update();
								};
							}}
							class="space-y-3 mt-2 rounded border border-[var(--color-tron-cyan)] bg-[rgba(0,255,255,0.03)] p-3"
						>
							<div>
								<label for="edit-udi" class="tron-label text-xs">UDI</label>
								<input id="edit-udi" name="udi" type="text" class="tron-input text-sm" bind:value={editUdi} required style="min-height: 38px;" />
							</div>
							<div>
								<label for="edit-barcode" class="tron-label text-xs">Barcode</label>
								<input id="edit-barcode" name="barcode" type="text" class="tron-input text-sm" bind:value={editBarcode} placeholder="Scan or enter barcode" style="min-height: 38px;" />
							</div>
							<div class="flex gap-2">
								<TronButton variant="primary" type="submit" disabled={savingIdentifiers} style="font-size: 0.75rem; padding: 4px 12px;">
									{savingIdentifiers ? 'Saving...' : 'Save'}
								</TronButton>
								<TronButton variant="ghost" onclick={() => { editingIdentifiers = false; }} style="font-size: 0.75rem; padding: 4px 12px;">
									Cancel
								</TronButton>
							</div>
							{#if form?.error && !form?.identifierSuccess}
								<p class="text-xs text-red-400">{form.error}</p>
							{/if}
							{#if form?.identifierSuccess}
								<p class="text-xs text-green-400">✓ Updated</p>
							{/if}
						</form>
					{/if}
				</div>
				<div class="flex justify-between">
					<dt class="tron-text-muted">Batch</dt>
					<dd>
						{#if data.batch}
							<!-- eslint-disable svelte/no-navigation-without-resolve -->
							<a
								href="/spu/batches/{data.batch.id}"
								class="font-mono underline"
								style="color: var(--color-tron-cyan);"
							>
								{data.batch.batchNumber}
							</a>
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
						{:else}
							<span class="text-sm" style="color: var(--color-tron-orange);"
								>Not associated with a production batch</span
							>
						{/if}
					</dd>
				</div>
				<div class="flex justify-between">
					<dt class="tron-text-muted">Created</dt>
					<dd class="tron-text-primary">{formatDate(data.spu.createdAt)}</dd>
				</div>
				<div class="flex justify-between">
					<dt class="tron-text-muted">Created By</dt>
					<dd class="tron-text-primary">{data.createdByName ?? '—'}</dd>
				</div>

				<!-- Assignment (editable) -->
				<div class="flex items-center justify-between gap-2">
					<dt class="tron-text-muted">Assignment</dt>
					<dd class="flex items-center gap-2">
						{#if editingAssignment}
							<form
								method="POST"
								action="?/updateAssignment"
								use:enhance={() => {
									return async ({ update }) => {
										await update();
										cancelEditAssignment();
									};
								}}
								class="flex items-center gap-2"
							>
								<select
									name="assignmentType"
									value={selectedAssignment}
									onchange={(e) => (assignmentOverride = e.currentTarget.value)}
									class="tron-input rounded px-2 py-1 text-sm"
								>
									<option value="rnd">R&D</option>
									<option value="manufacturing">Manufacturing</option>
									<option value="customer">Customer</option>
								</select>
								{#if showCustomerSelect}
									<select
										name="customerId"
										value={selectedCustomerId}
										onchange={(e) => (customerIdOverride = e.currentTarget.value)}
										class="tron-input rounded px-2 py-1 text-sm"
									>
										<option value="">Select customer…</option>
										{#each data.activeCustomers as c (c.id)}
											<option value={c.id}>{c.name}</option>
										{/each}
									</select>
								{/if}
								<button
									type="submit"
									class="rounded px-2 py-1 text-xs"
									style="background: var(--color-tron-cyan); color: var(--color-tron-bg);"
									>Save</button
								>
								<button
									type="button"
									onclick={cancelEditAssignment}
									class="tron-text-muted text-xs underline">Cancel</button
								>
							</form>
						{:else}
							<span class="tron-text-primary">
								{#if data.spu.assignmentType === 'customer' && data.assignmentCustomerName}
									<!-- eslint-disable svelte/no-navigation-without-resolve -->
									<a
										href="/spu/customers/{data.spu.assignmentCustomerId}"
										class="underline"
										style="color: var(--color-tron-cyan);"
									>
										{data.assignmentCustomerName}
									</a>
									<!-- eslint-enable svelte/no-navigation-without-resolve -->
								{:else}
									{assignmentLabel(data.spu.assignmentType, data.assignmentCustomerName)}
								{/if}
							</span>
							<button
								type="button"
								onclick={startEditAssignment}
								class="tron-text-muted text-xs underline">Edit</button
							>
						{/if}
					</dd>
				</div>

				<!-- QC Status (editable) -->
				<div class="flex items-center justify-between gap-2">
					<dt class="tron-text-muted">QC Status</dt>
					<dd class="flex items-center gap-2">
						{#if editingQc}
							<form
								method="POST"
								action="?/updateQcStatus"
								use:enhance={() => {
									return async ({ update }) => {
										await update();
										cancelEditQc();
									};
								}}
								class="flex items-center gap-2"
							>
								<select
									name="qcStatus"
									value={selectedQcStatus}
									onchange={(e) => (qcOverride = e.currentTarget.value)}
									class="tron-input rounded px-2 py-1 text-sm"
								>
									<option value="pending">Pending</option>
									<option value="pass">Pass</option>
									<option value="fail">Fail</option>
								</select>
								<button
									type="submit"
									class="rounded px-2 py-1 text-xs"
									style="background: var(--color-tron-cyan); color: var(--color-tron-bg);"
									>Save</button
								>
								<button
									type="button"
									onclick={cancelEditQc}
									class="tron-text-muted text-xs underline">Cancel</button
								>
							</form>
						{:else}
							<TronBadge variant={qcColors[data.spu.qcStatus] ?? 'neutral'}>
								{data.spu.qcStatus.charAt(0).toUpperCase() + data.spu.qcStatus.slice(1)}
							</TronBadge>
							<button type="button" onclick={startEditQc} class="tron-text-muted text-xs underline"
								>Edit</button
							>
						{/if}
					</dd>
				</div>

				<!-- QC Document -->
				<div class="flex justify-between">
					<dt class="tron-text-muted">QC Document</dt>
					<dd>
						{#if data.spu.qcDocumentUrl}
							<!-- eslint-disable svelte/no-navigation-without-resolve -->
							<a
								href={data.spu.qcDocumentUrl}
								target="_blank"
								rel="noopener noreferrer"
								class="text-sm underline"
								style="color: var(--color-tron-cyan);"
							>
								View QC Report
							</a>
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
						{:else}
							<span class="tron-text-muted text-sm">QC report not yet generated</span>
						{/if}
					</dd>
				</div>
			</dl>
		</TronCard>

		<TronCard>
			<h3 class="tron-text-primary mb-4 text-lg font-medium">Assembly Status</h3>
			<dl class="space-y-3">
				<!-- Assembly Status (editable) -->
				<div class="flex items-center justify-between gap-2">
					<dt class="tron-text-muted">Status</dt>
					<dd class="flex items-center gap-2">
						{#if editingAssemblyStatus}
							<form
								method="POST"
								action="?/updateAssemblyStatus"
								use:enhance={() => {
									return async ({ update }) => {
										await update();
										cancelEditAssemblyStatus();
									};
								}}
								class="flex items-center gap-2"
							>
								<select
									name="assemblyStatus"
									value={selectedAssemblyStatus}
									onchange={(e) => (assemblyStatusOverride = e.currentTarget.value)}
									class="tron-input rounded px-2 py-1 text-sm"
								>
									{#each ASSEMBLY_STATUSES as s (s)}
										<option value={s}>{assemblyStatusLabels[s]}</option>
									{/each}
								</select>
								<button
									type="submit"
									class="rounded px-2 py-1 text-xs"
									style="background: var(--color-tron-cyan); color: var(--color-tron-bg);"
									>Save</button
								>
								<button
									type="button"
									onclick={cancelEditAssemblyStatus}
									class="tron-text-muted text-xs underline">Cancel</button
								>
							</form>
						{:else}
							<TronBadge variant={assemblyStatusColors[data.spu.assemblyStatus] ?? 'neutral'}>
								{assemblyStatusLabels[data.spu.assemblyStatus] ?? data.spu.assemblyStatus}
							</TronBadge>
							<button
								type="button"
								onclick={startEditAssemblyStatus}
								class="tron-text-muted text-xs underline">Edit</button
							>
						{/if}
					</dd>
				</div>
				{#if data.spu.assemblyCompletedAt}
					<div class="flex justify-between">
						<dt class="tron-text-muted">Completed At</dt>
						<dd class="tron-text-primary">{formatDate(data.spu.assemblyCompletedAt)}</dd>
					</div>
				{/if}
				{#if data.assemblySignature}
					<div class="flex justify-between">
						<dt class="tron-text-muted">Signed By</dt>
						<dd class="tron-text-primary">{data.assemblySignature.userName}</dd>
					</div>
				{/if}
			</dl>

			<!-- Mini status history timeline -->
			{#if data.assemblyStatusHistory.length > 0}
				<div class="mt-4 border-t pt-3" style="border-color: var(--color-tron-border);">
					<button
						type="button"
						class="tron-text-muted flex w-full items-center gap-2 text-xs"
						onclick={() => (showStatusHistory = !showStatusHistory)}
					>
						<svg
							class="h-3 w-3 transition-transform {showStatusHistory ? 'rotate-90' : ''}"
							fill="currentColor"
							viewBox="0 0 20 20"
						>
							<path
								fill-rule="evenodd"
								d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
								clip-rule="evenodd"
							/>
						</svg>
						Status History ({data.assemblyStatusHistory.length})
					</button>
					{#if showStatusHistory}
						<div class="mt-2 space-y-2">
							{#each data.assemblyStatusHistory as entry (entry.id)}
								<div
									class="flex items-center gap-3 rounded px-3 py-2 text-xs"
									style="background: color-mix(in srgb, var(--color-tron-surface) 50%, transparent);"
								>
									<div class="flex shrink-0 items-center gap-1">
										{#if entry.from}
											<TronBadge
												variant={assemblyStatusColors[entry.from] ?? 'neutral'}
												class="text-[10px]"
											>
												{assemblyStatusLabels[entry.from] ?? entry.from}
											</TronBadge>
											<span class="tron-text-muted">&rarr;</span>
										{/if}
										<TronBadge
											variant={assemblyStatusColors[entry.to] ?? 'neutral'}
											class="text-[10px]"
										>
											{assemblyStatusLabels[entry.to] ?? entry.to}
										</TronBadge>
									</div>
									<span class="tron-text-muted ml-auto shrink-0">
										{entry.changedBy} &middot; {formatDate(entry.changedAt)}
									</span>
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{/if}
		</TronCard>
	</div>

	<!-- Device State Management -->
	<TronCard>
		<div class="mb-4 flex items-center justify-between">
			<h3 class="tron-text-primary text-lg font-medium">Device State</h3>
			{#if !showStateForm}
				<TronButton
					variant="primary"
					onclick={() => (showStateForm = true)}
					style="min-height: 44px;"
				>
					Change State
				</TronButton>
			{/if}
		</div>

		<dl class="space-y-3">
			<div class="flex justify-between">
				<dt class="tron-text-muted">Current State</dt>
				<dd><SpuDeviceStateBadge deviceState={data.spu.deviceState} /></dd>
			</div>
			{#if data.spu.owner}
				<div class="flex justify-between">
					<dt class="tron-text-muted">Owner</dt>
					<dd class="tron-text-primary">{data.spu.owner}</dd>
				</div>
			{/if}
			{#if data.spu.ownerNotes}
				<div class="flex justify-between">
					<dt class="tron-text-muted">Owner Notes</dt>
					<dd class="tron-text-primary">{data.spu.ownerNotes}</dd>
				</div>
			{/if}
		</dl>

		{#if showStateForm}
			<form
				method="POST"
				action="?/updateState"
				use:enhance={() => {
					updatingState = true;
					return async ({ result, update }) => {
						updatingState = false;
						await update();
					};
				}}
				class="mt-4 space-y-4 rounded border border-[var(--color-tron-cyan)] bg-[rgba(0,255,255,0.03)] p-4"
			>
				<div>
					<label for="state-deviceState" class="tron-label">Device State</label>
					<select
						id="state-deviceState"
						name="deviceState"
						class="tron-select"
						required
						disabled={updatingState}
						value={data.spu.deviceState}
						style="min-height: 44px;"
					>
						<option value="assembly">Assembly</option>
						<option value="production">Production</option>
						<option value="development_a">Dev A</option>
						<option value="development_b">Dev B</option>
						<option value="out_of_service">Out of Service</option>
					</select>
				</div>

				<div>
					<label for="state-owner" class="tron-label">Owner</label>
					<input
						id="state-owner"
						name="owner"
						type="text"
						class="tron-input"
						placeholder="Person, team, or customer"
						value={data.spu.owner ?? ''}
						disabled={updatingState}
						style="min-height: 44px;"
					/>
				</div>

				<div>
					<label for="state-ownerNotes" class="tron-label">Owner Notes</label>
					<input
						id="state-ownerNotes"
						name="ownerNotes"
						type="text"
						class="tron-input"
						placeholder="Context about assignment"
						value={data.spu.ownerNotes ?? ''}
						disabled={updatingState}
						style="min-height: 44px;"
					/>
				</div>

				{#if form?.error}
					<div
						class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-3"
					>
						<p class="text-sm text-[var(--color-tron-red)]">{form.error}</p>
					</div>
				{/if}

				<div class="flex gap-3">
					<TronButton
						type="button"
						class="flex-1"
						onclick={() => (showStateForm = false)}
						disabled={updatingState}
					>
						Cancel
					</TronButton>
					<TronButton type="submit" variant="primary" class="flex-1" disabled={updatingState}>
						{#if updatingState}
							Updating...
						{:else}
							Update State
						{/if}
					</TronButton>
				</div>
			</form>
		{/if}
	</TronCard>

	{#if data.particleDevice}
		<TronCard>
			<div class="mb-4 flex items-center justify-between">
				<h3 class="tron-text-primary text-lg font-medium">Particle IoT Device</h3>
				<div class="flex items-center gap-2">
					{#if data.particleDevice.status === 'online'}
						<TronBadge variant="success">Online</TronBadge>
					{:else}
						<TronBadge variant="neutral">{data.particleDevice.status ?? 'Offline'}</TronBadge>
					{/if}
				</div>
			</div>
			<dl class="grid grid-cols-2 gap-4 md:grid-cols-3">
				<div>
					<dt class="tron-text-muted text-sm">Device Name</dt>
					<dd class="tron-text-primary font-mono">{data.particleDevice.name}</dd>
				</div>
				<div>
					<dt class="tron-text-muted text-sm">Particle Device ID</dt>
					<dd class="tron-text-primary font-mono text-xs break-all">{data.particleDevice.particleDeviceId}</dd>
				</div>
				{#if data.particleDevice.serialNumber}
					<div>
						<dt class="tron-text-muted text-sm">Serial (Particle Cloud API)</dt>
						<dd class="tron-text-primary font-mono">{data.particleDevice.serialNumber}</dd>
					</div>
				{/if}
				{#if data.particleDevice.firmwareVersion}
					<div>
						<dt class="tron-text-muted text-sm">Firmware</dt>
						<dd class="tron-text-primary font-mono">{data.particleDevice.firmwareVersion}</dd>
					</div>
				{/if}
				{#if data.particleDevice.systemVersion}
					<div>
						<dt class="tron-text-muted text-sm">OS Version</dt>
						<dd class="tron-text-primary font-mono">{data.particleDevice.systemVersion}</dd>
					</div>
				{/if}
				<div>
					<dt class="tron-text-muted text-sm">Last Heard</dt>
					<dd class="tron-text-primary">{formatDate(data.particleDevice.lastHeardAt)}</dd>
				</div>
				{#if data.particleDevice.lastIpAddress}
					<div>
						<dt class="tron-text-muted text-sm">Last IP</dt>
						<dd class="tron-text-primary font-mono">{data.particleDevice.lastIpAddress}</dd>
					</div>
				{/if}
			</dl>
			<!-- Device Actions -->
			<div class="mt-4 flex flex-wrap items-center gap-3 border-t border-[var(--color-tron-border)] pt-4">
				<form
					method="POST"
					action="?/pingDevice"
					use:enhance={() => {
						pinging = true;
						return async ({ update }) => {
							pinging = false;
							await update();
						};
					}}
				>
					<TronButton type="submit" disabled={pinging} style="min-height: 44px;">
						{pinging ? 'Pinging...' : 'Ping Device'}
					</TronButton>
				</form>

				{#if !showRenameForm}
					<TronButton
						type="button"
						onclick={() => (showRenameForm = true)}
						style="min-height: 44px;"
					>
						Rename
					</TronButton>
				{/if}

				<form
					method="POST"
					action="?/unlinkDevice"
					use:enhance={() => {
						unlinking = true;
						return async ({ update }) => {
							unlinking = false;
							await update();
						};
					}}
				>
					<TronButton type="submit" disabled={unlinking} style="min-height: 44px;">
						{unlinking ? 'Unlinking...' : 'Unlink Device'}
					</TronButton>
				</form>
			</div>

			{#if showRenameForm}
				<form
					method="POST"
					action="?/renameDevice"
					use:enhance={() => {
						renaming = true;
						return async ({ result, update }) => {
							renaming = false;
							if (result.type === 'success') showRenameForm = false;
							await update();
						};
					}}
					class="mt-3 flex items-center gap-3"
				>
					<input
						name="name"
						type="text"
						class="tron-input flex-1"
						placeholder="New device name"
						value={data.particleDevice.name}
						required
						disabled={renaming}
						style="min-height: 44px;"
					/>
					<TronButton type="submit" variant="primary" disabled={renaming} style="min-height: 44px;">
						{renaming ? 'Saving...' : 'Save'}
					</TronButton>
					<TronButton
						type="button"
						onclick={() => (showRenameForm = false)}
						disabled={renaming}
						style="min-height: 44px;"
					>
						Cancel
					</TronButton>
				</form>
			{/if}

			{#if form?.message}
				<div class="mt-3 rounded border border-[var(--color-tron-green)] bg-[rgba(0,255,136,0.1)] p-3">
					<p class="text-sm text-[var(--color-tron-green)]">{form.message}</p>
				</div>
			{/if}
		</TronCard>
	{:else if data.particleLink}
		<TronCard>
			<h3 class="tron-text-primary mb-4 text-lg font-medium">Particle Link</h3>
			<dl class="grid grid-cols-2 gap-4 md:grid-cols-3">
				<div>
					<dt class="tron-text-muted text-sm">Serial</dt>
					<dd class="tron-text-primary font-mono">{data.particleLink.particleSerial}</dd>
				</div>
				<div>
					<dt class="tron-text-muted text-sm">Device ID</dt>
					<dd class="tron-text-primary font-mono">{data.particleLink.particleDeviceId ?? '—'}</dd>
				</div>
				<div>
					<dt class="tron-text-muted text-sm">Linked At</dt>
					<dd class="tron-text-primary">{formatDate(data.particleLink.linkedAt)}</dd>
				</div>
			</dl>
		</TronCard>
	{/if}

	<TronCard>
		<h3 class="tron-text-primary mb-4 text-lg font-medium">Parts Traceability</h3>
		{#if data.parts.length > 0}
			<div class="overflow-x-auto">
				<table class="tron-table">
					<thead>
						<tr>
							<th>Part #</th>
							<th>Name</th>
							<th>Lot #</th>
							<th>Qty</th>
							<th>Lot Expiration</th>
							<th>Recorded At</th>
							<th>Recorded By</th>
						</tr>
					</thead>
					<tbody>
						{#each data.parts as part (part.id)}
							<tr>
								<td>
									<!-- eslint-disable svelte/no-navigation-without-resolve -->
									<a
										href="/spu/parts/{part.partId}"
										class="font-mono underline"
										style="color: var(--color-tron-cyan);"
									>
										{part.partNumber}
									</a>
									<!-- eslint-enable svelte/no-navigation-without-resolve -->
								</td>
								<td>{part.partName}</td>
								<td class="font-mono">
									{#if part.lotNumber}
										{part.lotNumber}
									{:else if part.lotId}
										<span class="tron-text-muted text-xs">Lot linked</span>
									{:else}
										<span class="tron-text-muted">N/A</span>
									{/if}
								</td>
								<td>{part.quantityUsed}</td>
								<td><span class="tron-text-muted">N/A</span></td>
								<td>{formatDate(part.recordedAt)}</td>
								<td>{part.recordedByName}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else}
			<div class="py-6 text-center">
				<p class="tron-text-muted">No parts recorded yet.</p>
				<p class="mt-1 text-xs" style="color: var(--color-tron-cyan); opacity: 0.7;">
					Parts are recorded during the assembly process
				</p>
			</div>
		{/if}
	</TronCard>

	{#if data.sessions.length > 0}
		<TronCard>
			<h3 class="tron-text-primary mb-4 text-lg font-medium">Assembly Sessions</h3>
			<div class="overflow-x-auto">
				<table class="tron-table">
					<thead>
						<tr>
							<th>Started</th>
							<th>Completed</th>
							<th>Status</th>
							<th>Operator</th>
						</tr>
					</thead>
					<tbody>
						{#each data.sessions as session (session.id)}
							<tr>
								<td>{formatDate(session.startedAt)}</td>
								<td>{formatDate(session.completedAt)}</td>
								<td>
									{#if session.status === 'completed'}
										<TronBadge variant="success">Completed</TronBadge>
									{:else if session.status === 'in_progress'}
										<TronBadge variant="warning">In Progress</TronBadge>
									{:else if session.status === 'paused'}
										<TronBadge variant="neutral">Paused</TronBadge>
									{:else}
										<TronBadge variant="neutral">{session.status}</TronBadge>
									{/if}
								</td>
								<td>{session.operatorName}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</TronCard>
	{/if}

	{#if data.signatures.length > 0}
		<TronCard>
			<h3 class="tron-text-primary mb-4 text-lg font-medium">Electronic Signatures</h3>
			<div class="overflow-x-auto">
				<table class="tron-table">
					<thead>
						<tr>
							<th>Type</th>
							<th>Meaning</th>
							<th>Signed By</th>
							<th>Signed At</th>
						</tr>
					</thead>
					<tbody>
						{#each data.signatures as sig (sig.id)}
							<tr>
								<td>{sig.entityType}</td>
								<td class="italic">"{sig.meaning}"</td>
								<td>{sig.userName}</td>
								<td>{formatDate(sig.signedAt)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</TronCard>
	{/if}

	<!-- Record History (Audit Trail) -->
	<TronCard>
		<button
			type="button"
			class="flex w-full items-center justify-between"
			onclick={() => (showRecordHistory = !showRecordHistory)}
		>
			<h3 class="tron-text-primary text-lg font-medium">
				Record History
				{#if data.auditTrail.length > 0}
					<span
						class="ml-2 inline-block rounded-full px-2 py-0.5 text-xs font-normal"
						style="background: var(--color-tron-cyan); color: var(--color-tron-bg);"
					>
						{data.auditTrail.length}
					</span>
				{/if}
			</h3>
			<svg
				class="h-5 w-5 transition-transform {showRecordHistory ? 'rotate-180' : ''}"
				fill="currentColor"
				viewBox="0 0 20 20"
				style="color: var(--color-tron-cyan);"
			>
				<path
					fill-rule="evenodd"
					d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
					clip-rule="evenodd"
				/>
			</svg>
		</button>
		{#if showRecordHistory}
			<div class="mt-4 space-y-0">
				{#if data.auditTrail.length === 0}
					<p class="tron-text-muted py-4 text-center text-sm">No history recorded yet.</p>
				{:else}
					{#each data.auditTrail as entry, i (entry.id)}
						<div
							class="flex items-start gap-3 border-l-2 py-3 pl-4"
							style="border-color: var(--color-tron-cyan); background: {i % 2 === 0
								? 'transparent'
								: 'color-mix(in srgb, var(--color-tron-surface) 30%, transparent)'};"
						>
							<div
								class="-ml-[21px] mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full"
								style="background: var(--color-tron-bg); border: 2px solid var(--color-tron-cyan);"
							>
								{#if entry.action === 'INSERT'}
									<span class="text-[8px]" style="color: var(--color-tron-cyan);">+</span>
								{:else if entry.action === 'DELETE'}
									<span class="text-[8px]" style="color: var(--color-tron-error);">−</span>
								{:else}
									<span class="text-[8px]" style="color: var(--color-tron-cyan);">✎</span>
								{/if}
							</div>
							<div class="min-w-0 flex-1">
								<div class="flex flex-wrap items-center gap-2">
									<TronBadge
										variant={entry.action === 'INSERT'
											? 'success'
											: entry.action === 'DELETE'
												? 'error'
												: 'info'}
									>
										{entry.action}
									</TronBadge>
									<span class="tron-text-primary text-sm font-medium">{entry.changedBy}</span>
								</div>
								<p class="tron-text-muted mt-1 text-xs">
									{describeAuditEntry(entry)}
								</p>
								<p class="mt-1 text-xs" style="color: var(--color-tron-cyan); opacity: 0.6;">
									{formatDate(entry.changedAt)}
								</p>
							</div>
						</div>
					{/each}
				{/if}
			</div>
		{/if}
	</TronCard>
</div>
