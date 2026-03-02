<script lang="ts">
	import { goto } from '$app/navigation';
	import { TronCard, TronButton } from '$lib/components/ui';
	import DocumentStatusBadge from '$lib/components/documents/DocumentStatusBadge.svelte';
	import RevisionTimeline from '$lib/components/documents/RevisionTimeline.svelte';

	let { data } = $props();

	function formatDate(date: Date | string | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleDateString('en-US', {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}

	// Get current revision content
	let currentRevision = $derived(
		data.revisions.find((r) => r.revision === data.document.currentRevision)
	);

	// Check if current user is the document owner
	let isOwner = $derived(data.document.ownerId === data.user?.id);

	// Transform revisions for RevisionTimeline component
	let timelineRevisions = $derived(
		data.revisions.map((r) => ({
			id: r.id,
			revision: r.revision,
			status: r.status,
			createdAt: r.createdAt,
			createdBy: r.createdBy ? { username: r.createdBy } : null,
			changeDescription: r.changeDescription
		}))
	);
</script>

<div class="space-y-6">
	<!-- Back Button & Actions -->
	<div class="flex items-center justify-between">
		<button
			class="flex items-center gap-2 text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-cyan)]"
			onclick={() => goto('/documents')}
		>
			<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
			</svg>
			Back to Documents
		</button>

		<div class="flex items-center gap-3">
			{#if isOwner && data.document.status !== 'retired'}
				<TronButton onclick={() => goto(`/documents/${data.document.id}/revise`)}>
					New Revision
				</TronButton>
			{/if}
			{#if data.document.status === 'pending_approval'}
				<TronButton
					variant="primary"
					onclick={() => goto(`/documents/${data.document.id}/approve`)}
				>
					Review & Approve
				</TronButton>
			{/if}
			{#if (data.document.status === 'approved' || data.document.status === 'effective') && !data.isTrainedOnCurrent}
				<TronButton variant="primary" onclick={() => goto(`/documents/${data.document.id}/train`)}>
					Complete Training
				</TronButton>
			{/if}
		</div>
	</div>

	<!-- Document Header -->
	<TronCard>
		<div class="flex items-start justify-between">
			<div>
				<div class="flex items-center gap-3">
					<h1 class="tron-text-primary text-2xl font-bold">{data.document.title}</h1>
					<DocumentStatusBadge status={data.document.status} />
				</div>
				<p class="tron-text-muted mt-1 font-mono">{data.document.documentNumber}</p>
			</div>
			<div class="text-right">
				<div class="tron-text-muted text-sm">Current Revision</div>
				<div class="text-xl font-bold text-[var(--color-tron-cyan)]">
					{data.document.currentRevision}
				</div>
			</div>
		</div>

		<div class="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
			<div>
				<div class="tron-text-muted text-sm">Category</div>
				<div class="tron-text-primary font-medium">{data.document.category ?? '—'}</div>
			</div>
			<div>
				<div class="tron-text-muted text-sm">Owner</div>
				<div class="tron-text-primary font-medium">{data.document.ownerUsername ?? '—'}</div>
			</div>
			<div>
				<div class="tron-text-muted text-sm">Effective Date</div>
				<div class="tron-text-primary font-medium">{formatDate(data.document.effectiveDate)}</div>
			</div>
			<div>
				<div class="tron-text-muted text-sm">Created</div>
				<div class="tron-text-primary font-medium">{formatDate(data.document.createdAt)}</div>
			</div>
		</div>
	</TronCard>

	<!-- Current Revision Content -->
	{#if currentRevision?.content}
		<TronCard>
			<h2 class="tron-text-primary mb-4 text-lg font-bold">Document Content</h2>
			<div class="tron-text-secondary prose max-w-none whitespace-pre-wrap prose-invert">
				{currentRevision.content}
			</div>
		</TronCard>
	{/if}

	<!-- Training Status -->
	{#if data.userTraining.length > 0}
		<TronCard>
			<h2 class="tron-text-primary mb-4 text-lg font-bold">Your Training</h2>
			<div class="space-y-2">
				{#each data.userTraining as training}
					<div
						class="flex items-center justify-between rounded-lg bg-[var(--color-tron-bg-tertiary)] p-3"
					>
						<span class="tron-text-secondary">
							Trained on revision: {training.revision}
						</span>
						<span class="text-[var(--color-tron-green)]">
							{formatDate(training.trainedAt)}
						</span>
					</div>
				{/each}
			</div>
		</TronCard>
	{/if}

	<!-- Revision History -->
	{#if data.revisions.length > 0}
		<TronCard>
			<h2 class="tron-text-primary mb-4 text-lg font-bold">Revision History</h2>
			<RevisionTimeline
				revisions={timelineRevisions}
				currentRevision={data.document.currentRevision}
			/>
		</TronCard>
	{/if}
</div>
