<script lang="ts">
	import { enhance } from '$app/forms';
	import { TronCard, TronButton, TronBadge } from '$lib/components/ui';
	import SpuStatusBadge from '$lib/components/spu/SpuStatusBadge.svelte';

	let { data, form } = $props();

	let processing = $state(false);

	function formatDate(date: Date | string | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleDateString();
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
				href="/batches"
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
				Back to Batches
			</a>
			<h2 class="tron-text-primary font-mono text-2xl font-bold">{data.batch.batchNumber}</h2>
			<p class="tron-text-muted">{data.batch.description ?? 'No description'}</p>
		</div>
		<div class="flex gap-2">
			{#if !data.batch.startedAt}
				<form
					method="POST"
					action="?/start"
					use:enhance={() => {
						processing = true;
						return async ({ update }) => {
							processing = false;
							await update();
						};
					}}
				>
					<TronButton type="submit" variant="primary" disabled={processing}>
						{processing ? 'Starting...' : 'Start Batch'}
					</TronButton>
				</form>
			{:else if !data.batch.completedAt}
				<form
					method="POST"
					action="?/complete"
					use:enhance={() => {
						processing = true;
						return async ({ update }) => {
							processing = false;
							await update();
						};
					}}
				>
					<TronButton type="submit" disabled={processing}>
						{processing ? 'Completing...' : 'Complete Batch'}
					</TronButton>
				</form>
			{/if}
		</div>
	</div>

	{#if form?.error}
		<div class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-3">
			<p class="text-sm text-[var(--color-tron-red)]">{form.error}</p>
		</div>
	{/if}

	<!-- Stats Cards -->
	<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
		<TronCard>
			<div class="text-center">
				<div class="tron-text-primary font-mono text-3xl font-bold">{data.stats.total}</div>
				<div class="tron-text-muted text-sm">Total SPUs</div>
			</div>
		</TronCard>
		<TronCard>
			<div class="text-center">
				<div class="font-mono text-3xl font-bold text-[var(--color-tron-green)]">
					{data.stats.completed}
				</div>
				<div class="tron-text-muted text-sm">Completed</div>
			</div>
		</TronCard>
		<TronCard>
			<div class="text-center">
				<div class="font-mono text-3xl font-bold text-[var(--color-tron-yellow)]">
					{data.stats.inProgress}
				</div>
				<div class="tron-text-muted text-sm">In Progress</div>
			</div>
		</TronCard>
		<TronCard>
			<div class="text-center">
				<div class="tron-text-primary font-mono text-3xl font-bold">{data.stats.pending}</div>
				<div class="tron-text-muted text-sm">Pending</div>
			</div>
		</TronCard>
	</div>

	<!-- Batch Details -->
	<div class="grid gap-6 md:grid-cols-2">
		<TronCard>
			<h3 class="tron-text-primary mb-4 text-lg font-medium">Batch Information</h3>
			<dl class="space-y-3">
				<div class="flex justify-between">
					<dt class="tron-text-muted">Batch Number</dt>
					<dd class="tron-text-primary font-mono">{data.batch.batchNumber}</dd>
				</div>
				<div class="flex justify-between">
					<dt class="tron-text-muted">Target Quantity</dt>
					<dd class="tron-text-primary">{data.batch.targetQuantity ?? '—'}</dd>
				</div>
				<div class="flex justify-between">
					<dt class="tron-text-muted">Created By</dt>
					<dd class="tron-text-primary">{data.creatorName}</dd>
				</div>
				<div class="flex justify-between">
					<dt class="tron-text-muted">Created At</dt>
					<dd class="tron-text-primary">{formatDateTime(data.batch.createdAt)}</dd>
				</div>
			</dl>
		</TronCard>

		<TronCard>
			<h3 class="tron-text-primary mb-4 text-lg font-medium">Status Timeline</h3>
			<dl class="space-y-3">
				<div class="flex justify-between">
					<dt class="tron-text-muted">Status</dt>
					<dd>
						{#if data.batch.completedAt}
							<TronBadge variant="success">Completed</TronBadge>
						{:else if data.batch.startedAt}
							<TronBadge variant="warning">In Progress</TronBadge>
						{:else}
							<TronBadge variant="neutral">Pending</TronBadge>
						{/if}
					</dd>
				</div>
				<div class="flex justify-between">
					<dt class="tron-text-muted">Started At</dt>
					<dd class="tron-text-primary">{formatDateTime(data.batch.startedAt)}</dd>
				</div>
				<div class="flex justify-between">
					<dt class="tron-text-muted">Completed At</dt>
					<dd class="tron-text-primary">{formatDateTime(data.batch.completedAt)}</dd>
				</div>
			</dl>
		</TronCard>
	</div>

	<!-- SPUs Table -->
	<TronCard>
		<div class="mb-4 flex items-center justify-between">
			<h3 class="tron-text-primary text-lg font-medium">SPUs in Batch</h3>
			<span class="tron-text-muted text-sm">{data.spus.length} units</span>
		</div>
		<div class="overflow-x-auto">
			<table class="tron-table">
				<thead>
					<tr>
						<th>UDI</th>
						<th>Status</th>
						<th>Created</th>
						<th>Assembly Completed</th>
						<th>Actions</th>
					</tr>
				</thead>
				<tbody>
					{#each data.spus as spuItem (spuItem.id)}
						<tr>
							<td class="font-mono">{spuItem.udi}</td>
							<td><SpuStatusBadge status={spuItem.status} /></td>
							<td>{formatDate(spuItem.createdAt)}</td>
							<td>{formatDate(spuItem.assemblyCompletedAt)}</td>
							<td>
								<a
									href="/spu/{spuItem.id}"
									class="text-sm text-[var(--color-tron-cyan)] hover:underline"
								>
									View
								</a>
							</td>
						</tr>
					{:else}
						<tr>
							<td colspan="5" class="py-8 text-center tron-text-muted">
								No SPUs in this batch yet.
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</TronCard>
</div>
