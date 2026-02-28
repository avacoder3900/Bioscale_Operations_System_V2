<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { TronCard, TronButton, TronBadge } from '$lib/components/ui';

	let { data, form } = $props();

	let editing = $state(false);
	let submitting = $state(false);
	let newNote = $state('');
	let addingNote = $state(false);
	let infoExpanded = $state(true);

	const qcColors: Record<string, 'success' | 'error' | 'warning'> = {
		pass: 'success',
		fail: 'error',
		pending: 'warning'
	};

	function formatDate(date: Date | string | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleDateString();
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<a
				href={resolve('/spu/customers')}
				class="tron-text-muted mb-2 inline-block text-sm hover:text-[var(--color-tron-cyan)]"
			>
				&larr; Back to Customers
			</a>
			<h2 class="tron-text-primary font-mono text-2xl font-bold">{data.customer.name}</h2>
			<div class="mt-1 flex items-center gap-2">
				<TronBadge variant={data.customer.customerType === 'b2b' ? 'info' : 'neutral'}>
					{data.customer.customerType.toUpperCase()}
				</TronBadge>
				<TronBadge variant={data.customer.status === 'active' ? 'success' : 'warning'}>
					{data.customer.status}
				</TronBadge>
			</div>
		</div>
		<TronButton variant="primary" onclick={() => (editing = !editing)}>
			{editing ? 'Cancel' : 'Edit'}
		</TronButton>
	</div>

	<!-- Feedback messages -->
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

	<!-- Customer Info (expandable) -->
	<TronCard>
		<button class="flex w-full items-center justify-between" onclick={() => (infoExpanded = !infoExpanded)}>
			<h3 class="tron-text-primary font-mono text-lg font-bold">Customer Information</h3>
			<svg class="h-5 w-5 transition-transform {infoExpanded ? 'rotate-180' : ''}" style="color: var(--color-tron-text-secondary)" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
			</svg>
		</button>

		{#if infoExpanded}

		{#if editing}
			<form
				method="POST"
				action="?/update"
				use:enhance={() => {
					submitting = true;
					return async ({ update, result }) => {
						submitting = false;
						if (result.type === 'success') editing = false;
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
							value={data.customer.name}
							class="tron-input w-full"
						/>
					</div>
					<div>
						<label class="tron-text-muted mb-1 block text-sm" for="customerType">Type *</label>
						<select id="customerType" name="customerType" required class="tron-input w-full">
							<option value="b2b" selected={data.customer.customerType === 'b2b'}>B2B</option>
							<option value="b2c" selected={data.customer.customerType === 'b2c'}>B2C</option>
						</select>
					</div>
					<div>
						<label class="tron-text-muted mb-1 block text-sm" for="contactName">Contact Name</label>
						<input
							id="contactName"
							name="contactName"
							type="text"
							value={data.customer.contactName ?? ''}
							class="tron-input w-full"
						/>
					</div>
					<div>
						<label class="tron-text-muted mb-1 block text-sm" for="contactEmail">Email</label>
						<input
							id="contactEmail"
							name="contactEmail"
							type="email"
							value={data.customer.contactEmail ?? ''}
							class="tron-input w-full"
						/>
					</div>
					<div>
						<label class="tron-text-muted mb-1 block text-sm" for="contactPhone">Phone</label>
						<input
							id="contactPhone"
							name="contactPhone"
							type="tel"
							value={data.customer.contactPhone ?? ''}
							class="tron-input w-full"
						/>
					</div>
					<div>
						<label class="tron-text-muted mb-1 block text-sm" for="address">Address</label>
						<input
							id="address"
							name="address"
							type="text"
							value={data.customer.address ?? ''}
							class="tron-input w-full"
						/>
					</div>
					<div class="sm:col-span-2">
						<label class="tron-text-muted mb-1 block text-sm" for="notes">Notes</label>
						<textarea id="notes" name="notes" rows="3" class="tron-input w-full"
							>{data.customer.notes ?? ''}</textarea
						>
					</div>
				</div>
				<div class="mt-4 flex justify-end gap-2">
					<TronButton type="button" onclick={() => (editing = false)}>Cancel</TronButton>
					<TronButton type="submit" variant="primary" disabled={submitting}>
						{submitting ? 'Saving...' : 'Save Changes'}
					</TronButton>
				</div>
			</form>
		{:else}
			<dl class="grid gap-4 sm:grid-cols-2">
				<div>
					<dt class="tron-text-muted text-sm">Name</dt>
					<dd class="tron-text-primary mt-1 font-mono">{data.customer.name}</dd>
				</div>
				<div>
					<dt class="tron-text-muted text-sm">Type</dt>
					<dd class="mt-1">
						<TronBadge variant={data.customer.customerType === 'b2b' ? 'info' : 'neutral'}>
							{data.customer.customerType.toUpperCase()}
						</TronBadge>
					</dd>
				</div>
				<div>
					<dt class="tron-text-muted text-sm">Contact Name</dt>
					<dd class="tron-text-primary mt-1">{data.customer.contactName ?? '—'}</dd>
				</div>
				<div>
					<dt class="tron-text-muted text-sm">Email</dt>
					<dd class="tron-text-primary mt-1">{data.customer.contactEmail ?? '—'}</dd>
				</div>
				<div>
					<dt class="tron-text-muted text-sm">Phone</dt>
					<dd class="tron-text-primary mt-1">{data.customer.contactPhone ?? '—'}</dd>
				</div>
				<div>
					<dt class="tron-text-muted text-sm">Address</dt>
					<dd class="tron-text-primary mt-1">{data.customer.address ?? '—'}</dd>
				</div>
				{#if data.customer.notes}
					<div class="sm:col-span-2">
						<dt class="tron-text-muted text-sm">Notes</dt>
						<dd class="tron-text-primary mt-1">{data.customer.notes}</dd>
					</div>
				{/if}
				<div>
					<dt class="tron-text-muted text-sm">Status</dt>
					<dd class="mt-1">
						<TronBadge variant={data.customer.status === 'active' ? 'success' : 'warning'}>
							{data.customer.status}
						</TronBadge>
					</dd>
				</div>
				<div>
					<dt class="tron-text-muted text-sm">Created</dt>
					<dd class="tron-text-primary mt-1">{formatDate(data.customer.createdAt)}</dd>
				</div>
			</dl>
		{/if}
		{/if}
	</TronCard>

	<!-- Notes -->
	<TronCard>
		<h3 class="tron-text-primary mb-4 font-mono text-lg font-bold">
			Notes
			{#if data.notes}
				<span class="ml-2 inline-block rounded-full bg-[var(--color-tron-cyan)] px-2 py-0.5 text-xs text-black">
					{data.notes.length}
				</span>
			{/if}
		</h3>

		<!-- Add Note Form -->
		<form
			method="POST"
			action="?/addNote"
			use:enhance={() => {
				addingNote = true;
				return async ({ update }) => {
					addingNote = false;
					newNote = '';
					await update();
				};
			}}
		>
			<div class="flex gap-2">
				<input
					type="text"
					name="noteText"
					placeholder="Add a note..."
					bind:value={newNote}
					class="tron-input flex-1"
				/>
				<TronButton type="submit" variant="primary" disabled={addingNote || !newNote.trim()}>
					{addingNote ? 'Adding...' : 'Add'}
				</TronButton>
			</div>
		</form>

		<!-- Notes List -->
		{#if data.notes && data.notes.length > 0}
			<div class="mt-4 space-y-3">
				{#each data.notes as note (note.id)}
					<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3">
						<div class="flex items-start justify-between">
							<div class="flex-1">
								<p class="tron-text-primary text-sm">{note.noteText}</p>
								<p class="tron-text-muted mt-1 text-xs">
									{note.authorName} &mdash; {formatDate(note.createdAt)}
								</p>
							</div>
							<form method="POST" action="?/deleteNote" use:enhance>
								<input type="hidden" name="noteId" value={note.id} />
								<button type="submit" class="ml-2 text-xs text-[var(--color-tron-red)] hover:underline">
									Delete
								</button>
							</form>
						</div>
					</div>
				{/each}
			</div>
		{:else}
			<p class="tron-text-muted mt-4 text-center text-sm">No notes yet</p>
		{/if}
	</TronCard>

	<!-- Order History -->
	{#if data.orderHistory && data.orderHistory.length > 0}
		<TronCard>
			<h3 class="tron-text-primary mb-4 font-mono text-lg font-bold">
				Order History
				<span class="ml-2 inline-block rounded-full bg-[var(--color-tron-cyan)] px-2 py-0.5 text-xs text-black">
					{data.orderHistory.length}
				</span>
			</h3>
			<div class="overflow-x-auto">
				<table class="tron-table">
					<thead>
						<tr>
							<th>Package ID</th>
							<th>Status</th>
							<th>Cartridges</th>
							<th>Tracking</th>
							<th>Carrier</th>
							<th>Created</th>
							<th>Shipped</th>
						</tr>
					</thead>
					<tbody>
						{#each data.orderHistory as order (order.id)}
							<tr>
								<td class="font-mono text-sm text-[var(--color-tron-cyan)]">{order.barcode}</td>
								<td>
									<TronBadge variant={order.status === 'delivered' ? 'success' : order.status === 'shipped' ? 'info' : 'neutral'}>
										{order.status}
									</TronBadge>
								</td>
								<td class="font-mono">{order.cartridgeCount}</td>
								<td class="text-sm">{order.trackingNumber ?? '—'}</td>
								<td class="text-sm">{order.carrier ?? '—'}</td>
								<td class="text-sm">{formatDate(order.createdAt)}</td>
								<td class="text-sm">{formatDate(order.shippedAt)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</TronCard>
	{/if}

	<!-- Assigned SPUs -->
	<TronCard>
		<h3 class="tron-text-primary mb-4 font-mono text-lg font-bold">
			Assigned SPUs
			<span
				class="ml-2 inline-block rounded-full bg-[var(--color-tron-cyan)] px-2 py-0.5 text-xs text-black"
			>
				{data.spus.length}
			</span>
		</h3>

		{#if data.spus.length > 0}
			<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				{#each data.spus as spuItem (spuItem.id)}
					<!-- eslint-disable svelte/no-navigation-without-resolve -->
					<a
						href="/spu/{spuItem.id}"
						class="block rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3 transition-colors hover:border-[var(--color-tron-cyan)]"
					>
						<div class="mb-1 font-mono text-sm text-[var(--color-tron-cyan)]">
							{spuItem.shortId}
						</div>
						<div class="tron-text-muted mb-2 truncate text-xs" title={spuItem.udi}>
							{spuItem.udi}
						</div>
						<div class="flex items-center justify-between">
							<TronBadge variant={qcColors[spuItem.qcStatus] ?? 'neutral'}>
								QC: {spuItem.qcStatus}
							</TronBadge>
							<span class="tron-text-muted text-xs">{formatDate(spuItem.createdAt)}</span>
						</div>
					</a>
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
				{/each}
			</div>
		{:else}
			<p class="tron-text-muted py-4 text-center">No SPUs assigned to this customer</p>
		{/if}
	</TronCard>
</div>
