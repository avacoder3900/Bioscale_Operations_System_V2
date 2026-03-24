<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { TronCard, TronButton, TronBadge } from '$lib/components/ui';

	let { data, form } = $props();

	let showAddForm = $state(false);
	let showGroupForm = $state(false);
	let submitting = $state(false);

	// Filter state from server
	let statusFilter = $state(data.filters?.status ?? '');
	let groupFilter = $state(data.filters?.group ?? '');

	function applyFilters() {
		const params = new URLSearchParams();
		if (statusFilter) params.set('status', statusFilter);
		if (groupFilter) params.set('group', groupFilter);
		goto(`/cartridges?${params.toString()}`);
	}

	function clearFilters() {
		statusFilter = '';
		groupFilter = '';
		goto('/cartridges');
	}

	function goToPage(p: number) {
		const params = new URLSearchParams(page.url.searchParams);
		params.set('page', String(p));
		goto(`/cartridges?${params.toString()}`);
	}

	function getStatusVariant(status: string): 'success' | 'info' | 'warning' | 'error' | 'neutral' {
		switch (status) {
			case 'available': return 'success';
			case 'in_use': return 'info';
			case 'depleted': return 'warning';
			case 'expired': return 'error';
			case 'quarantine': return 'error';
			case 'disposed': return 'neutral';
			default: return 'neutral';
		}
	}

	function formatDate(date: string | Date | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleDateString();
	}

	function getGroupInfo(groupId: string | null): { name: string; color: string } | null {
		if (!groupId) return null;
		const group = (data.groups ?? []).find((g: { id: string }) => g.id === groupId);
		return group ? { name: group.name, color: group.color || 'var(--color-tron-cyan)' } : null;
	}

	let hasFilters = $derived(!!statusFilter || !!groupFilter);
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h2 class="tron-text-primary font-mono text-2xl font-bold">Lab Cartridges</h2>
			<p class="tron-text-muted text-sm">{data.pagination?.total ?? 0} total cartridges</p>
		</div>
		<TronButton variant="primary" onclick={() => (showAddForm = !showAddForm)}>
			{showAddForm ? 'Cancel' : 'Register Cartridge'}
		</TronButton>
	</div>

	{#if form?.error}
		<div class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-3">
			<p class="text-sm text-[var(--color-tron-red)]">{form.error}</p>
		</div>
	{/if}

	{#if form?.success}
		<div class="rounded border border-[var(--color-tron-green)] bg-[rgba(0,255,136,0.1)] p-3">
			<p class="text-sm text-[var(--color-tron-green)]">Operation completed successfully.</p>
		</div>
	{/if}

	<!-- Add Cartridge Form -->
	{#if showAddForm}
		<TronCard>
			<h3 class="tron-text-primary mb-3 font-mono text-sm font-semibold">Register New Cartridge</h3>
			<form
				method="POST"
				action="?/create"
				use:enhance={() => {
					submitting = true;
					return async ({ update }) => {
						submitting = false;
						showAddForm = false;
						await update();
					};
				}}
			>
				<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
					<div>
						<label class="tron-text-muted mb-1 block text-xs">Barcode</label>
						<input type="text" name="barcode" class="tron-input w-full" placeholder="e.g. LC-0001" />
					</div>
					<div>
						<label class="tron-text-muted mb-1 block text-xs">Serial Number</label>
						<input type="text" name="serialNumber" class="tron-input w-full" />
					</div>
					<div>
						<label class="tron-text-muted mb-1 block text-xs">Lot Number</label>
						<input type="text" name="lotNumber" class="tron-input w-full" />
					</div>
					<div>
						<label class="tron-text-muted mb-1 block text-xs">Cartridge Type *</label>
						<select name="cartridgeType" class="tron-input w-full" required>
							<option value="measurement">Measurement</option>
							<option value="calibration">Calibration</option>
							<option value="reference">Reference</option>
							<option value="test">Test</option>
						</select>
					</div>
					<div>
						<label class="tron-text-muted mb-1 block text-xs">Total Uses</label>
						<input type="number" name="totalUses" class="tron-input w-full" value="10" min="1" />
					</div>
					<div>
						<label class="tron-text-muted mb-1 block text-xs">Manufacturer</label>
						<input type="text" name="manufacturer" class="tron-input w-full" />
					</div>
					<div>
						<label class="tron-text-muted mb-1 block text-xs">Expiration Date</label>
						<input type="date" name="expirationDate" class="tron-input w-full" />
					</div>
					<div>
						<label class="tron-text-muted mb-1 block text-xs">Storage Location</label>
						<input type="text" name="storageLocation" class="tron-input w-full" placeholder="e.g. Fridge 001 - Shelf 1" />
					</div>
					<div>
						<label class="tron-text-muted mb-1 block text-xs">Storage Conditions</label>
						<input type="text" name="storageConditions" class="tron-input w-full" placeholder="e.g. 2-8°C" />
					</div>
					<div>
						<label class="tron-text-muted mb-1 block text-xs">Group</label>
						<select name="groupId" class="tron-input w-full">
							<option value="">No Group</option>
							{#each data.groups ?? [] as group (group.id)}
								<option value={group.id}>{group.name}</option>
							{/each}
						</select>
					</div>
					<div class="sm:col-span-2 lg:col-span-2">
						<label class="tron-text-muted mb-1 block text-xs">Notes</label>
						<input type="text" name="notes" class="tron-input w-full" />
					</div>
				</div>
				<div class="mt-3 flex justify-end">
					<TronButton type="submit" variant="primary" disabled={submitting}>
						{submitting ? 'Registering...' : 'Register Cartridge'}
					</TronButton>
				</div>
			</form>
		</TronCard>
	{/if}

	<!-- Filter Bar -->
	<TronCard>
		<div class="flex flex-wrap items-end gap-3">
			<div>
				<label class="tron-text-muted mb-1 block text-xs">Status</label>
				<select
					class="tron-input"
					style="min-height: 40px"
					bind:value={statusFilter}
					onchange={applyFilters}
				>
					<option value="">All Statuses</option>
					<option value="available">Available</option>
					<option value="in_use">In Use</option>
					<option value="depleted">Depleted</option>
					<option value="expired">Expired</option>
					<option value="quarantine">Quarantine</option>
					<option value="disposed">Disposed</option>
				</select>
			</div>
			<div>
				<label class="tron-text-muted mb-1 block text-xs">Group</label>
				<select
					class="tron-input"
					style="min-height: 40px"
					bind:value={groupFilter}
					onchange={applyFilters}
				>
					<option value="">All Groups</option>
					{#each data.groups ?? [] as group (group.id)}
						<option value={group.id}>{group.name}</option>
					{/each}
				</select>
			</div>
			{#if hasFilters}
				<button class="tron-button" style="min-height: 40px" onclick={clearFilters}>Clear Filters</button>
			{/if}
		</div>
	</TronCard>

	<!-- Cartridges Table -->
	<TronCard>
		<div class="overflow-x-auto">
			<table class="tron-table">
				<thead>
					<tr>
						<th>Barcode</th>
						<th>Serial #</th>
						<th>Lot #</th>
						<th>Type</th>
						<th>Status</th>
						<th>Group</th>
						<th>Uses</th>
						<th>Storage</th>
						<th>Received</th>
						<th>Actions</th>
					</tr>
				</thead>
				<tbody>
					{#each data.cartridges ?? [] as cartridge (cartridge.id)}
						{@const groupInfo = getGroupInfo(cartridge.groupId)}
						<tr>
							<td class="font-mono text-[var(--color-tron-cyan)]">{cartridge.barcode ?? cartridge.id}</td>
							<td class="font-mono text-xs">{cartridge.serialNumber ?? '—'}</td>
							<td class="font-mono text-xs">{cartridge.lotNumber ?? '—'}</td>
							<td class="capitalize">{cartridge.cartridgeType}</td>
							<td><TronBadge variant={getStatusVariant(cartridge.status)}>{cartridge.status.replace('_', ' ')}</TronBadge></td>
							<td>
								{#if groupInfo}
									<span class="inline-flex items-center gap-1">
										<span class="inline-block h-2 w-2 rounded-full" style="background: {groupInfo.color}"></span>
										{groupInfo.name}
									</span>
								{:else}
									<span class="tron-text-muted">—</span>
								{/if}
							</td>
							<td class="text-center font-mono">
								{#if cartridge.usesRemaining != null && cartridge.totalUses != null}
									{cartridge.usesRemaining}/{cartridge.totalUses}
								{:else}
									—
								{/if}
							</td>
							<td class="text-xs">{cartridge.storageLocation ?? '—'}</td>
							<td class="tron-text-muted text-xs">{formatDate(cartridge.receivedDate)}</td>
							<td>
								<div class="flex items-center gap-1">
									<!-- Status Change -->
									<form
										method="POST"
										action="?/updateStatus"
										use:enhance={() => {
											return async ({ update }) => { await update(); };
										}}
									>
										<input type="hidden" name="cartridgeId" value={cartridge.id} />
										<select
											name="status"
											class="tron-input text-xs"
											style="min-width: 90px"
											onchange={(e: Event) => (e.target as HTMLFormElement).form?.requestSubmit()}
										>
											<option value="" disabled selected>Status...</option>
											<option value="available">Available</option>
											<option value="in_use">In Use</option>
											<option value="depleted">Depleted</option>
											<option value="expired">Expired</option>
											<option value="quarantine">Quarantine</option>
											<option value="disposed">Disposed</option>
										</select>
									</form>
									<!-- Group Change -->
									<form
										method="POST"
										action="?/changeGroup"
										use:enhance={() => {
											return async ({ update }) => { await update(); };
										}}
									>
										<input type="hidden" name="cartridgeId" value={cartridge.id} />
										<select
											name="groupId"
											class="tron-input text-xs"
											style="min-width: 90px"
											onchange={(e: Event) => (e.target as HTMLFormElement).form?.requestSubmit()}
										>
											<option value="" disabled selected>Group...</option>
											{#each data.groups ?? [] as group (group.id)}
												<option value={group.id}>{group.name}</option>
											{/each}
										</select>
									</form>
								</div>
							</td>
						</tr>
					{:else}
						<tr>
							<td colspan="10" class="tron-text-muted text-center">
								{#if hasFilters}
									No cartridges match your filters.
								{:else}
									No cartridges registered yet.
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</TronCard>

	<!-- Pagination -->
	{#if data.pagination && (data.pagination.hasPrev || data.pagination.hasNext)}
		<div class="flex items-center justify-between">
			<button
				class="tron-button"
				disabled={!data.pagination.hasPrev}
				onclick={() => goToPage(data.pagination.page - 1)}
			>
				Previous
			</button>
			<span class="tron-text-muted text-sm">
				Page {data.pagination.page} of {Math.ceil(data.pagination.total / data.pagination.limit)}
			</span>
			<button
				class="tron-button"
				disabled={!data.pagination.hasNext}
				onclick={() => goToPage(data.pagination.page + 1)}
			>
				Next
			</button>
		</div>
	{/if}

	<!-- Create Group Form -->
	<TronCard>
		<div class="flex items-center justify-between">
			<h3 class="tron-text-primary font-mono text-sm font-semibold">Cartridge Groups</h3>
			<TronButton variant="default" onclick={() => (showGroupForm = !showGroupForm)}>
				{showGroupForm ? 'Cancel' : 'New Group'}
			</TronButton>
		</div>
		{#if showGroupForm}
			<form
				method="POST"
				action="?/createGroup"
				class="mt-3 flex flex-wrap items-end gap-3"
				use:enhance={() => {
					submitting = true;
					return async ({ update }) => {
						submitting = false;
						showGroupForm = false;
						await update();
					};
				}}
			>
				<div class="flex-1">
					<label class="tron-text-muted mb-1 block text-xs">Name *</label>
					<input type="text" name="name" class="tron-input w-full" required />
				</div>
				<div class="flex-1">
					<label class="tron-text-muted mb-1 block text-xs">Description</label>
					<input type="text" name="description" class="tron-input w-full" />
				</div>
				<div>
					<label class="tron-text-muted mb-1 block text-xs">Color</label>
					<input type="color" name="color" class="h-10 w-10 cursor-pointer rounded border-0" value="#3B82F6" />
				</div>
				<TronButton type="submit" variant="primary" disabled={submitting}>
					{submitting ? 'Creating...' : 'Create Group'}
				</TronButton>
			</form>
		{/if}
		{#if data.groups && data.groups.length > 0}
			<div class="mt-3 flex flex-wrap gap-2">
				{#each data.groups as group (group.id)}
					<span class="inline-flex items-center gap-1.5 rounded border border-[var(--color-tron-border)] px-2 py-1 text-sm">
						<span class="inline-block h-2.5 w-2.5 rounded-full" style="background: {group.color || 'var(--color-tron-cyan)'}"></span>
						{group.name}
						{#if group.description}
							<span class="tron-text-muted text-xs">— {group.description}</span>
						{/if}
					</span>
				{/each}
			</div>
		{/if}
	</TronCard>
</div>
