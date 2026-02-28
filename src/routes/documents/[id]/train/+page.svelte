<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { TronCard, TronButton, TronInput } from '$lib/components/ui';
	import DocumentStatusBadge from '$lib/components/documents/DocumentStatusBadge.svelte';

	let { data, form } = $props();
</script>

<svelte:head>
	<title>Training | {data.document.documentNumber}</title>
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
		<h1 class="tron-heading text-2xl font-bold">Document Training</h1>
		<p class="tron-text-muted mt-1">
			Read the document content below and acknowledge your training.
		</p>
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
		<div class="mt-4 flex items-center gap-4">
			<div>
				<span class="tron-text-muted text-sm">Revision:</span>
				<span class="ml-1 font-bold text-[var(--color-tron-cyan)]">{data.revision.revision}</span>
			</div>
			{#if data.document.category}
				<div>
					<span class="tron-text-muted text-sm">Category:</span>
					<span class="tron-text-primary ml-1">{data.document.category}</span>
				</div>
			{/if}
		</div>
	</TronCard>

	<!-- Already Trained Warning -->
	{#if data.alreadyTrained}
		<div class="rounded-lg border border-[var(--color-tron-green)] bg-[rgba(0,255,136,0.1)] p-4">
			<div class="flex items-center gap-2 text-[var(--color-tron-green)]">
				<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
					/>
				</svg>
				<span class="font-medium">You have already completed training on this revision.</span>
			</div>
			<p class="tron-text-muted mt-2 text-sm">
				View your training record in the <a
					href="/documents/training"
					class="text-[var(--color-tron-cyan)] hover:underline">training dashboard</a
				>.
			</p>
		</div>
	{:else}
		<!-- Document Content -->
		<TronCard>
			<h2 class="tron-text-primary mb-4 text-lg font-bold">Document Content</h2>
			{#if data.revision.changeDescription}
				<div
					class="mb-4 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] p-3"
				>
					<span class="tron-text-muted text-sm">Revision Notes:</span>
					<p class="tron-text-primary mt-1">{data.revision.changeDescription}</p>
				</div>
			{/if}
			{#if data.revision.content}
				<div class="prose max-w-none prose-invert">
					<pre
						class="tron-text-secondary rounded-lg bg-[var(--color-tron-bg-secondary)] p-4 text-sm whitespace-pre-wrap">{data
							.revision.content}</pre>
				</div>
			{:else}
				<p class="tron-text-muted italic">No content available for this revision.</p>
			{/if}
		</TronCard>

		<!-- Training Form -->
		<TronCard>
			<h2 class="tron-text-primary mb-4 text-lg font-bold">Acknowledge Training</h2>
			<p class="tron-text-muted mb-4 text-sm">
				By entering your password, you confirm: "I acknowledge that I have read, understood, and
				been trained on this document."
			</p>

			{#if form?.error}
				<div
					class="mb-4 rounded-lg border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-4 text-[var(--color-tron-red)]"
				>
					{form.error}
				</div>
			{/if}

			<form method="POST" use:enhance class="space-y-4">
				<input type="hidden" name="revisionId" value={data.revision.id} />

				<div>
					<label for="notes" class="tron-label">Notes (optional)</label>
					<textarea
						id="notes"
						name="notes"
						class="tron-input"
						rows="2"
						placeholder="Any notes or questions about the training..."
					></textarea>
				</div>

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

				<TronButton type="submit" variant="primary">Complete Training</TronButton>
			</form>
		</TronCard>
	{/if}
</div>
