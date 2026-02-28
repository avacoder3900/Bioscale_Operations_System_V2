<script lang="ts">
	import { goto } from '$app/navigation';
	import { TronCard, TronButton } from '$lib/components/ui';
	import DocumentStatusBadge from '$lib/components/documents/DocumentStatusBadge.svelte';

	let { data } = $props();

	function formatDate(date: Date | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleDateString('en-US', {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}

	function handleCategoryChange(e: Event) {
		const select = e.target as HTMLSelectElement;
		const category = select.value;
		if (category) {
			goto(`/documents?category=${encodeURIComponent(category)}`);
		} else {
			goto('/documents');
		}
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<h2 class="tron-text-primary text-2xl font-bold">Documents</h2>
		<div class="flex items-center gap-4">
			<!-- Category Filter -->
			<select
				class="tron-input min-w-[160px]"
				value={data.selectedCategory ?? ''}
				onchange={handleCategoryChange}
			>
				<option value="">All Categories</option>
				{#each data.categories as category}
					<option value={category}>{category}</option>
				{/each}
			</select>

			<!-- New Document Button (permission-gated) -->
			{#if data.permissions?.canWrite}
				<TronButton variant="primary" onclick={() => goto('/documents/new')}>
					New Document
				</TronButton>
			{/if}
		</div>
	</div>

	<!-- Documents Table -->
	<TronCard>
		{#if data.documents.length === 0}
			<div class="py-12 text-center">
				<svg
					class="mx-auto h-12 w-12 text-[var(--color-tron-text-muted)]"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
					/>
				</svg>
				<h3 class="tron-text-primary mt-4 text-lg font-medium">No documents found</h3>
				<p class="tron-text-muted mt-2">
					{#if data.selectedCategory}
						No documents in this category.
					{:else}
						Get started by creating a new document.
					{/if}
				</p>
			</div>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full">
					<thead>
						<tr class="border-b border-[var(--color-tron-border)]">
							<th class="tron-text-muted px-4 py-3 text-left text-sm font-medium">Document #</th>
							<th class="tron-text-muted px-4 py-3 text-left text-sm font-medium">Title</th>
							<th class="tron-text-muted px-4 py-3 text-left text-sm font-medium">Category</th>
							<th class="tron-text-muted px-4 py-3 text-left text-sm font-medium">Revision</th>
							<th class="tron-text-muted px-4 py-3 text-left text-sm font-medium">Status</th>
							<th class="tron-text-muted px-4 py-3 text-left text-sm font-medium">Effective Date</th
							>
						</tr>
					</thead>
					<tbody>
						{#each data.documents as doc}
							<tr
								class="cursor-pointer border-b border-[var(--color-tron-border)] transition-colors hover:bg-[var(--color-tron-bg-tertiary)]"
								onclick={() => goto(`/documents/${doc.id}`)}
								onkeydown={(e) => e.key === 'Enter' && goto(`/documents/${doc.id}`)}
								tabindex="0"
								role="button"
							>
								<td class="px-4 py-3">
									<span class="font-mono text-[var(--color-tron-cyan)]">{doc.documentNumber}</span>
								</td>
								<td class="tron-text-primary px-4 py-3 font-medium">{doc.title}</td>
								<td class="tron-text-secondary px-4 py-3">{doc.category ?? '—'}</td>
								<td class="px-4 py-3">
									<span class="font-mono text-[var(--color-tron-text-secondary)]">
										{doc.currentRevision}
									</span>
								</td>
								<td class="px-4 py-3">
									<DocumentStatusBadge status={doc.status} />
								</td>
								<td class="tron-text-secondary px-4 py-3">{formatDate(doc.effectiveDate)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</TronCard>
</div>
