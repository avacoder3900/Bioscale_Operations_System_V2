<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/stores';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import { TronCard, TronButton, TronBadge } from '$lib/components/ui';

	let { data, form } = $props();

	let searchQuery = $state($page.url.searchParams.get('search') ?? '');
	let filterType = $state($page.url.searchParams.get('type') ?? 'all');
	let filterStatus = $state($page.url.searchParams.get('status') ?? 'all');
	let showAddForm = $state(false);
	let submitting = $state(false);

	function applyFilters() {
		const params = new SvelteURLSearchParams();
		if (searchQuery.trim()) params.set('search', searchQuery.trim());
		if (filterType !== 'all') params.set('type', filterType);
		if (filterStatus !== 'all') params.set('status', filterStatus);
		const qs = params.toString();
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve used, query params appended
		goto(resolve('/customers') + (qs ? `?${qs}` : ''), { replaceState: true });
	}

	let filteredCustomers = $derived(data.customers);
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<h2 class="tron-text-primary font-mono text-2xl font-bold">Customers</h2>
			<p class="tron-text-muted">Manage customer accounts and assignments</p>
		</div>
		<TronButton variant="primary" onclick={() => (showAddForm = !showAddForm)}>
			{showAddForm ? 'Cancel' : '+ Add Customer'}
		</TronButton>
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

	<!-- Add Customer Form -->
	{#if showAddForm}
		<TronCard>
			<h3 class="tron-text-primary mb-4 font-mono text-lg font-bold">New Customer</h3>
			<form
				method="POST"
				action="?/create"
				use:enhance={() => {
					submitting = true;
					return async ({ update, result }) => {
						submitting = false;
						if (result.type === 'success') showAddForm = false;
						await update();
					};
				}}
			>
				<div class="grid gap-4 sm:grid-cols-2">
					<div>
						<label class="tron-text-muted mb-1 block text-sm" for="name">Name *</label>
						<input
							id="name"
							name="name"
							type="text"
							required
							class="tron-input w-full"
							placeholder="Company name"
						/>
					</div>
					<div>
						<label class="tron-text-muted mb-1 block text-sm" for="customerType">Type *</label>
						<select id="customerType" name="customerType" required class="tron-input w-full">
							<option value="">Select type</option>
							<option value="b2b">B2B</option>
							<option value="b2c">B2C</option>
						</select>
					</div>
					<div>
						<label class="tron-text-muted mb-1 block text-sm" for="contactName">Contact Name</label>
						<input
							id="contactName"
							name="contactName"
							type="text"
							class="tron-input w-full"
							placeholder="Primary contact"
						/>
					</div>
					<div>
						<label class="tron-text-muted mb-1 block text-sm" for="contactEmail">Email</label>
						<input
							id="contactEmail"
							name="contactEmail"
							type="email"
							class="tron-input w-full"
							placeholder="contact@example.com"
						/>
					</div>
					<div>
						<label class="tron-text-muted mb-1 block text-sm" for="contactPhone">Phone</label>
						<input
							id="contactPhone"
							name="contactPhone"
							type="tel"
							class="tron-input w-full"
							placeholder="+1 (555) 000-0000"
						/>
					</div>
					<div>
						<label class="tron-text-muted mb-1 block text-sm" for="address">Address</label>
						<input
							id="address"
							name="address"
							type="text"
							class="tron-input w-full"
							placeholder="Street, City, State"
						/>
					</div>
					<div class="sm:col-span-2">
						<label class="tron-text-muted mb-1 block text-sm" for="notes">Notes</label>
						<textarea
							id="notes"
							name="notes"
							rows="2"
							class="tron-input w-full"
							placeholder="Additional notes..."
						></textarea>
					</div>
				</div>
				<div class="mt-4 flex justify-end gap-2">
					<TronButton type="button" onclick={() => (showAddForm = false)}>Cancel</TronButton>
					<TronButton type="submit" variant="primary" disabled={submitting}>
						{submitting ? 'Creating...' : 'Create Customer'}
					</TronButton>
				</div>
			</form>
		</TronCard>
	{/if}

	<!-- Filters -->
	<TronCard>
		<div class="flex flex-wrap items-center gap-4">
			<div class="flex-1">
				<input
					type="search"
					placeholder="Search by name, contact, or email..."
					bind:value={searchQuery}
					onkeydown={(e) => {
						if (e.key === 'Enter') applyFilters();
					}}
					class="tron-input w-full"
				/>
			</div>
			<select
				bind:value={filterType}
				onchange={applyFilters}
				class="tron-input rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] px-3 py-2 text-[var(--color-tron-text)]"
			>
				<option value="all">All Types</option>
				<option value="b2b">B2B</option>
				<option value="b2c">B2C</option>
			</select>
			<select
				bind:value={filterStatus}
				onchange={applyFilters}
				class="tron-input rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] px-3 py-2 text-[var(--color-tron-text)]"
			>
				<option value="all">All Status</option>
				<option value="active">Active</option>
				<option value="inactive">Inactive</option>
			</select>
			<TronButton onclick={applyFilters}>Search</TronButton>
		</div>
	</TronCard>

	<!-- Customer Table -->
	<TronCard>
		<div class="overflow-x-auto">
			<table class="tron-table">
				<thead>
					<tr>
						<th>Name</th>
						<th>Type</th>
						<th>Contact</th>
						<th>Email</th>
						<th>Status</th>
						<th>Actions</th>
					</tr>
				</thead>
				<tbody>
					{#each filteredCustomers as cust (cust.id)}
						<tr
							class="cursor-pointer transition-colors hover:bg-[var(--color-tron-bg-tertiary)]"
							onclick={() => goto(`/customers/${cust.id}`)}
						>
							<td class="font-mono text-[var(--color-tron-cyan)]">{cust.name}</td>
							<td>
								<TronBadge variant={cust.customerType === 'b2b' ? 'info' : 'neutral'}>
									{cust.customerType.toUpperCase()}
								</TronBadge>
							</td>
							<td>{cust.contactName ?? '—'}</td>
							<td>{cust.contactEmail ?? '—'}</td>
							<td>
								<TronBadge variant={cust.status === 'active' ? 'success' : 'warning'}>
									{cust.status}
								</TronBadge>
							</td>
							<td>
								<div class="flex items-center gap-2">
									{#if cust.status === 'active'}
										<form
											method="POST"
											action="?/deactivate"
											use:enhance={() => {
												return async ({ update }) => {
													await update();
												};
											}}
											onclick={(e) => e.stopPropagation()}
										>
											<input type="hidden" name="customerId" value={cust.id} />
											<button
												type="submit"
												class="text-sm text-[var(--color-tron-red)] hover:underline"
											>
												Deactivate
											</button>
										</form>
									{/if}
								</div>
							</td>
						</tr>
					{:else}
						<tr>
							<td colspan="6" class="tron-text-muted py-8 text-center">
								{#if searchQuery || filterType !== 'all' || filterStatus !== 'all'}
									No customers match your filters.
								{:else}
									No customers yet. Click "+ Add Customer" to create one.
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</TronCard>
</div>
