<script lang="ts">
	import { enhance } from '$app/forms';
	import { TronCard, TronButton, TronBadge, TronInput } from '$lib/components/ui';

	let { data, form } = $props();

	let saving = $state(false);
	let showDeactivateModal = $state(false);

	function formatCurrency(value: string | null): string {
		if (!value) return '—';
		const num = parseFloat(value);
		if (isNaN(num)) return '—';
		return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(num);
	}

	function formatDateTime(date: Date | string | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleString();
	}
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<a
				href="/spu/bom"
				class="tron-text-muted mb-2 inline-flex items-center gap-1 text-sm hover:text-[var(--color-tron-cyan)]"
			>
				<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M15 19l-7-7 7-7"
					/>
				</svg>
				Back to BOM
			</a>
			<h2 class="tron-text-primary font-mono text-2xl font-bold">{data.item.partNumber}</h2>
			<p class="tron-text-muted">{data.item.name}</p>
		</div>
		<div class="flex gap-2">
			{#if data.part}
				<a href="/spu/parts/{data.part.id}">
					<TronButton variant="default">Edit Part Details</TronButton>
				</a>
			{/if}
			{#if data.item.isActive}
				<TronButton variant="danger" onclick={() => (showDeactivateModal = true)}
					>Deactivate</TronButton
				>
			{:else}
				<TronBadge variant="error">Inactive</TronBadge>
			{/if}
		</div>
	</div>

	{#if form?.error}
		<div class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-3">
			<p class="text-sm text-[var(--color-tron-red)]">{form.error}</p>
		</div>
	{/if}

	{#if form?.success}
		<div class="rounded border border-[var(--color-tron-green)] bg-[rgba(0,255,136,0.1)] p-3">
			<p class="text-sm text-[var(--color-tron-green)]">{form.message}</p>
		</div>
	{/if}

	<div class="grid gap-6 lg:grid-cols-3">
		<!-- Inventory Edit Form -->
		<div class="lg:col-span-2">
			<TronCard>
				<h3 class="tron-text-primary mb-4 text-lg font-medium">Inventory Details</h3>
				<form
					method="POST"
					action="?/update"
					use:enhance={() => {
						saving = true;
						return async ({ update }) => {
							saving = false;
							await update();
						};
					}}
					class="space-y-4"
				>
					<div class="grid gap-4 sm:grid-cols-2">
						<div>
							<label for="partNumber" class="tron-text-muted mb-1 block text-sm">Part Number</label>
							<div class="font-mono text-[var(--color-tron-cyan)]">{data.item.partNumber}</div>
							<p class="tron-text-muted text-xs">Synced from Box — not editable</p>
						</div>
						<div>
							<label for="category" class="tron-text-muted mb-1 block text-sm">Classification</label
							>
							<TronInput type="text" name="category" value={data.item.category ?? ''} />
						</div>
					</div>

					<div class="grid gap-4 sm:grid-cols-2">
						<div>
							<label for="inventoryCount" class="tron-text-muted mb-1 block text-sm"
								>Inventory Count</label
							>
							<TronInput
								type="number"
								name="inventoryCount"
								value={data.item.inventoryCount ?? ''}
							/>
						</div>
						<div>
							<label for="quantityPerUnit" class="tron-text-muted mb-1 block text-sm"
								>Quantity per Unit</label
							>
							<TronInput
								type="number"
								name="quantityPerUnit"
								value={data.item.quantityPerUnit ?? 1}
							/>
						</div>
					</div>

					<div>
						<label for="changeReason" class="tron-text-muted mb-1 block text-sm"
							>Change Reason *</label
						>
						<TronInput
							type="text"
							name="changeReason"
							placeholder="Why are you making this change?"
							required
						/>
					</div>

					<div class="flex justify-end pt-4">
						<TronButton type="submit" variant="primary" disabled={saving}>
							{saving ? 'Saving...' : 'Save Changes'}
						</TronButton>
					</div>
				</form>
			</TronCard>
		</div>

		<!-- Side Panel -->
		<div class="space-y-6">
			<!-- Sourcing Info (read-only from partDefinition) -->
			<TronCard>
				<div class="mb-4 flex items-center justify-between">
					<h3 class="tron-text-primary text-lg font-medium">Sourcing Info</h3>
					{#if data.part}
						<a
							href="/spu/parts/{data.part.id}"
							class="text-sm text-[var(--color-tron-cyan)] hover:underline"
						>
							Edit
						</a>
					{/if}
				</div>
				{#if data.part}
					<dl class="space-y-3">
						<div class="flex justify-between">
							<dt class="tron-text-muted">Supplier</dt>
							<dd>{data.part.supplier || '—'}</dd>
						</div>
						<div class="flex justify-between">
							<dt class="tron-text-muted">Vendor Part #</dt>
							<dd class="font-mono">{data.part.vendorPartNumber || '—'}</dd>
						</div>
						<div class="flex justify-between">
							<dt class="tron-text-muted">Unit Cost</dt>
							<dd class="font-mono text-[var(--color-tron-cyan)]">
								{formatCurrency(data.part.unitCost)}
							</dd>
						</div>
						<div class="flex justify-between">
							<dt class="tron-text-muted">Lead Time</dt>
							<dd class="font-mono">
								{data.part.leadTimeDays ? `${data.part.leadTimeDays} days` : '—'}
							</dd>
						</div>
						<div class="flex justify-between">
							<dt class="tron-text-muted">Min Order Qty</dt>
							<dd class="font-mono">{data.part.minimumOrderQty ?? '—'}</dd>
						</div>
						<div class="flex justify-between">
							<dt class="tron-text-muted">Hazard Class</dt>
							<dd>{data.part.hazardClass || '—'}</dd>
						</div>
					</dl>
				{:else}
					<p class="tron-text-muted text-sm">
						No linked part definition found. Run a sync or create one manually.
					</p>
				{/if}
			</TronCard>

			<!-- Value Summary -->
			<TronCard>
				<h3 class="tron-text-primary mb-4 text-lg font-medium">Value Summary</h3>
				<dl class="space-y-3">
					<div class="flex justify-between">
						<dt class="tron-text-muted">Inventory</dt>
						<dd class="font-mono">{data.item.inventoryCount ?? 0} units</dd>
					</div>
					<div class="flex justify-between">
						<dt class="tron-text-muted">Qty/Unit</dt>
						<dd class="font-mono">{data.item.quantityPerUnit}</dd>
					</div>
					<div class="flex justify-between">
						<dt class="tron-text-muted">Unit Cost</dt>
						<dd class="font-mono">{formatCurrency(data.item.unitCost)}</dd>
					</div>
					<div class="border-t border-[var(--color-tron-border)] pt-2">
						<div class="flex justify-between">
							<dt class="tron-text-muted font-medium">Total Value</dt>
							<dd class="font-mono text-lg font-bold text-[var(--color-tron-green)]">
								{formatCurrency(
									data.item.unitCost
										? (parseFloat(data.item.unitCost) * (data.item.inventoryCount ?? 0)).toString()
										: null
								)}
							</dd>
						</div>
					</div>
				</dl>
			</TronCard>
		</div>
	</div>

	<!-- Version History -->
	<TronCard>
		<h3 class="tron-text-primary mb-4 text-lg font-medium">Version History</h3>
		{#if data.versions.length > 0}
			<div class="space-y-4">
				{#each data.versions as version (version.id)}
					<div class="border-l-2 border-[var(--color-tron-border)] pl-4">
						<div class="flex items-center gap-2">
							<TronBadge
								variant={version.changeType === 'create'
									? 'success'
									: version.changeType === 'delete'
										? 'error'
										: 'warning'}
							>
								v{version.version} - {version.changeType}
							</TronBadge>
							<span class="tron-text-muted text-sm">{formatDateTime(version.changedAt)}</span>
						</div>
						{#if version.changeReason}
							<p class="tron-text-primary mt-1 text-sm">{version.changeReason}</p>
						{/if}
						{#if version.previousValues}
							<div class="tron-text-muted mt-1 text-xs">
								Changed: {Object.keys(version.previousValues as Record<string, unknown>).join(', ')}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{:else}
			<p class="tron-text-muted text-sm">No version history available.</p>
		{/if}
	</TronCard>
</div>

<!-- Deactivate Modal -->
{#if showDeactivateModal}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
		<div
			class="w-full max-w-md rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-6"
		>
			<h3 class="tron-text-primary mb-4 text-lg font-bold">Deactivate BOM Item</h3>
			<p class="tron-text-muted mb-4">
				This will mark the item as inactive. It will no longer appear in the active BOM list.
			</p>
			<form
				method="POST"
				action="?/deactivate"
				use:enhance={() => {
					return async ({ update, result }) => {
						if (result.type === 'success') {
							showDeactivateModal = false;
						}
						await update();
					};
				}}
				class="space-y-4"
			>
				<div>
					<label for="reason" class="tron-text-muted mb-1 block text-sm"
						>Reason for Deactivation *</label
					>
					<TronInput
						type="text"
						name="reason"
						placeholder="Why is this item being deactivated?"
						required
					/>
				</div>
				<div class="flex justify-end gap-2 pt-4">
					<TronButton type="button" variant="default" onclick={() => (showDeactivateModal = false)}>
						Cancel
					</TronButton>
					<TronButton type="submit" variant="danger">Deactivate</TronButton>
				</div>
			</form>
		</div>
	</div>
{/if}
