<script lang="ts">
	import { goto } from '$app/navigation';
	import { TronCard } from '$lib/components/ui';

	let { data } = $props();

	function formatDate(date: Date | string | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleDateString('en-US', {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}
</script>

<div class="space-y-6">
	<h2 class="tron-text-primary text-2xl font-bold">Pending Approvals</h2>

	<TronCard>
		{#if data.pendingRevisions.length === 0}
			<div class="py-12 text-center">
				<svg
					class="mx-auto h-12 w-12 text-[var(--color-tron-green)]"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
					/>
				</svg>
				<h3 class="tron-text-primary mt-4 text-lg font-medium">All caught up!</h3>
				<p class="tron-text-muted mt-2">No documents are waiting for your approval.</p>
			</div>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full">
					<thead>
						<tr class="border-b border-[var(--color-tron-border)]">
							<th class="tron-text-muted px-4 py-3 text-left text-sm font-medium">Document #</th>
							<th class="tron-text-muted px-4 py-3 text-left text-sm font-medium">Title</th>
							<th class="tron-text-muted px-4 py-3 text-left text-sm font-medium">Revision</th>
							<th class="tron-text-muted px-4 py-3 text-left text-sm font-medium">Submitted By</th>
							<th class="tron-text-muted px-4 py-3 text-left text-sm font-medium">Submitted</th>
							<th class="tron-text-muted px-4 py-3 text-left text-sm font-medium">Action</th>
						</tr>
					</thead>
					<tbody>
						{#each data.pendingRevisions as item}
							<tr class="border-b border-[var(--color-tron-border)]">
								<td class="px-4 py-3">
									<span class="font-mono text-[var(--color-tron-cyan)]">{item.documentNumber}</span>
								</td>
								<td class="tron-text-primary px-4 py-3 font-medium">{item.title}</td>
								<td class="px-4 py-3">
									<span class="font-mono text-[var(--color-tron-text-secondary)]">
										{item.revision}
									</span>
								</td>
								<td class="tron-text-secondary px-4 py-3">{item.submittedByUsername ?? '—'}</td>
								<td class="tron-text-secondary px-4 py-3">{formatDate(item.submittedAt)}</td>
								<td class="px-4 py-3">
									<button
										class="text-[var(--color-tron-cyan)] underline-offset-2 hover:underline"
										onclick={() => goto(`/documents/${item.documentId}/approve`)}
									>
										Review
									</button>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</TronCard>
</div>
