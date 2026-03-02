<script lang="ts">
	import { enhance } from '$app/forms';
	import { TronCard, TronButton, TronBadge } from '$lib/components/ui';

	let { data, form } = $props();

	let showCreateModal = $state(false);
	let creating = $state(false);

	function formatDate(date: Date | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleDateString();
	}
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<h2 class="tron-text-primary text-2xl font-bold">Production Batches</h2>
			<p class="tron-text-muted">Track and manage production batches</p>
		</div>
		<TronButton variant="primary" onclick={() => (showCreateModal = true)}>New Batch</TronButton>
	</div>

	<TronCard>
		<div class="overflow-x-auto">
			<table class="tron-table">
				<thead>
					<tr>
						<th>Batch #</th>
						<th>Description</th>
						<th>Target Qty</th>
						<th>Started</th>
						<th>Completed</th>
						<th>Status</th>
						<th>Actions</th>
					</tr>
				</thead>
				<tbody>
					{#each data.batches as batch}
						<tr>
							<td class="font-mono">{batch.batchNumber}</td>
							<td>{batch.description ?? '—'}</td>
							<td class="text-center">{batch.targetQuantity ?? '—'}</td>
							<td>{formatDate(batch.startedAt)}</td>
							<td>{formatDate(batch.completedAt)}</td>
							<td>
								{#if batch.completedAt}
									<TronBadge variant="success">Completed</TronBadge>
								{:else if batch.startedAt}
									<TronBadge variant="warning">In Progress</TronBadge>
								{:else}
									<TronBadge variant="neutral">Pending</TronBadge>
								{/if}
							</td>
							<td>
								<a href="/spu/batches/{batch.id}" class="tron-link">View</a>
							</td>
						</tr>
					{:else}
						<tr>
							<td colspan="7" class="text-center tron-text-muted py-8">
								No batches found. Click "New Batch" to create one.
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</TronCard>
</div>

<!-- Create Batch Modal -->
{#if showCreateModal}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
		<div class="w-full max-w-md">
			<TronCard>
				<div class="mb-6 flex items-center justify-between">
					<h3 class="tron-text-primary text-xl font-bold">Create New Batch</h3>
					<button
						type="button"
						class="tron-text-muted hover:tron-text-primary"
						onclick={() => (showCreateModal = false)}
						aria-label="Close modal"
					>
						<svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M6 18L18 6M6 6l12 12"
							/>
						</svg>
					</button>
				</div>

				<form
					method="POST"
					action="?/create"
					use:enhance={() => {
						creating = true;
						return async ({ result, update }) => {
							creating = false;
							await update();
							if (result.type === 'success') {
								showCreateModal = false;
							}
						};
					}}
					class="space-y-4"
				>
					<div>
						<label for="batchNumber" class="tron-label">Batch Number</label>
						<input
							id="batchNumber"
							name="batchNumber"
							type="text"
							class="tron-input"
							placeholder="e.g., BATCH-2024-001"
							required
							disabled={creating}
						/>
					</div>

					<div>
						<label for="description" class="tron-label">Description (Optional)</label>
						<textarea
							id="description"
							name="description"
							class="tron-input"
							rows="3"
							placeholder="Enter batch description..."
							disabled={creating}
						></textarea>
					</div>

					<div>
						<label for="targetQuantity" class="tron-label">Target Quantity (Optional)</label>
						<input
							id="targetQuantity"
							name="targetQuantity"
							type="number"
							min="1"
							class="tron-input"
							placeholder="e.g., 100"
							disabled={creating}
						/>
					</div>

					{#if form?.error}
						<div
							class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-3"
						>
							<p class="text-sm text-[var(--color-tron-red)]">{form.error}</p>
						</div>
					{/if}

					<div class="flex gap-3 pt-2">
						<TronButton
							type="button"
							class="flex-1"
							onclick={() => (showCreateModal = false)}
							disabled={creating}
						>
							Cancel
						</TronButton>
						<TronButton type="submit" variant="primary" class="flex-1" disabled={creating}>
							{#if creating}
								Creating...
							{:else}
								Create Batch
							{/if}
						</TronButton>
					</div>
				</form>
			</TronCard>
		</div>
	</div>
{/if}
