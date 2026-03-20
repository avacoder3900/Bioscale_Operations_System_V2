<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { TronCard, TronButton, TronInput } from '$lib/components/ui';
	import DocumentStatusBadge from '$lib/components/documents/DocumentStatusBadge.svelte';

	let { data, form } = $props();

	let showRejectForm = $state(false);

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

<svelte:head>
	<title>Approve Document | {data.document.documentNumber}</title>
</svelte:head>

<div class="space-y-6">
	<!-- Back Button -->
	<button
		class="flex items-center gap-2 text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-cyan)]"
		onclick={() => goto(`/documents/${data.document.id}`)}
	>
		<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
		</svg>
		Back to Document
	</button>

	<!-- Header -->
	<div>
		<h1 class="tron-heading text-2xl font-bold">Review & Approve Document</h1>
		<p class="tron-text-muted mt-1">Review the revision below and approve or reject it.</p>
	</div>

	<!-- Document Info -->
	<TronCard>
		<div class="flex items-start justify-between">
			<div>
				<h2 class="tron-text-primary text-lg font-bold">{data.document.title}</h2>
				<p class="tron-text-muted mt-1 font-mono">{data.document.documentNumber}</p>
			</div>
			<DocumentStatusBadge status={data.document.status} />
		</div>
		<div class="mt-4 grid gap-4 sm:grid-cols-3">
			<div>
				<div class="tron-text-muted text-sm">Category</div>
				<div class="tron-text-primary">{data.document.category ?? '—'}</div>
			</div>
			<div>
				<div class="tron-text-muted text-sm">Owner</div>
				<div class="tron-text-primary">{data.document.ownerUsername ?? '—'}</div>
			</div>
			<div>
				<div class="tron-text-muted text-sm">Current Status</div>
				<div class="tron-text-primary capitalize">{data.document.status.replace('_', ' ')}</div>
			</div>
		</div>
	</TronCard>

	<!-- Revision to Review -->
	<TronCard>
		<div class="mb-4 flex items-center justify-between">
			<h2 class="tron-text-primary text-lg font-bold">Revision {data.revision.revision}</h2>
			<DocumentStatusBadge status={data.revision.status} />
		</div>

		<div class="mb-4 grid gap-4 sm:grid-cols-2">
			<div>
				<div class="tron-text-muted text-sm">Created By</div>
				<div class="tron-text-primary">{data.revision.createdByUsername ?? '—'}</div>
			</div>
			<div>
				<div class="tron-text-muted text-sm">Created At</div>
				<div class="tron-text-primary">{formatDate(data.revision.createdAt)}</div>
			</div>
		</div>

		{#if data.revision.changeDescription}
			<div class="mb-4">
				<div class="tron-text-muted text-sm">Change Description</div>
				<div class="tron-text-primary mt-1">{data.revision.changeDescription}</div>
			</div>
		{/if}

		{#if data.revision.content}
			<div>
				<div class="tron-text-muted mb-2 text-sm">Content Preview</div>
				<div class="max-h-64 overflow-y-auto rounded-lg bg-[var(--color-tron-bg-tertiary)] p-4">
					<pre class="tron-text-secondary text-sm whitespace-pre-wrap">{data.revision.content}</pre>
				</div>
			</div>
		{/if}
	</TronCard>

	<!-- Error Display -->
	{#if form?.error}
		<div
			class="rounded-lg border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-4 text-[var(--color-tron-red)]"
		>
			{form.error}
		</div>
	{/if}

	<!-- Approve Form -->
	{#if !showRejectForm}
		<TronCard>
			<h2 class="tron-text-primary mb-4 text-lg font-bold">Approve with Electronic Signature</h2>
			<p class="tron-text-muted mb-4 text-sm">
				By entering your password, you confirm: "I approve this document revision for release."
			</p>

			<form method="POST" action="?/approve" use:enhance class="space-y-4">
				<input type="hidden" name="revisionId" value={data.revision.id} />

				<div>
					<label for="password" class="tron-label">Password *</label>
					<TronInput
						type="password"
						id="password"
						name="password"
						placeholder="Enter your password to sign"
						required
					/>
				</div>

				<div class="tron-text-muted text-xs">
					Signing as: <span class="font-medium text-[var(--color-tron-cyan)]">{data.userName}</span>
				</div>

				<div class="flex gap-3">
					<TronButton type="submit" variant="primary">Approve Document</TronButton>
					<TronButton type="button" variant="danger" onclick={() => (showRejectForm = true)}>
						Reject
					</TronButton>
				</div>
			</form>
		</TronCard>
	{:else}
		<!-- Reject Form -->
		<TronCard>
			<h2 class="tron-text-primary mb-4 text-lg font-bold">Reject Revision</h2>
			<p class="tron-text-muted mb-4 text-sm">
				Provide a reason for rejecting this revision. The document owner will be notified.
			</p>

			<form method="POST" action="?/reject" use:enhance class="space-y-4">
				<input type="hidden" name="revisionId" value={data.revision.id} />

				<div>
					<label for="reason" class="tron-label">Rejection Reason *</label>
					<textarea
						id="reason"
						name="reason"
						class="tron-input"
						rows="3"
						placeholder="Explain why this revision is being rejected..."
						required
					></textarea>
				</div>

				<div class="flex gap-3">
					<TronButton type="submit" variant="danger">Confirm Rejection</TronButton>
					<TronButton type="button" onclick={() => (showRejectForm = false)}>Cancel</TronButton>
				</div>
			</form>
		</TronCard>
	{/if}
</div>
