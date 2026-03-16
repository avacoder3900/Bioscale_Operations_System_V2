<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { TronCard, TronButton, TronInput } from '$lib/components/ui';

	let { data, form } = $props();

	let submitting = $state(false);
	let content = $state(data.latestContent ?? '');
	let showPreview = $state(false);

	// Calculate next revision number
	function getNextRevision(current: string, major: boolean): string {
		const parts = current.split('.');
		if (parts.length === 2) {
			const majorNum = parseInt(parts[0], 10);
			const minorNum = parseInt(parts[1], 10);
			if (major) {
				return `${majorNum + 1}.0`;
			}
			return `${majorNum}.${minorNum + 1}`;
		}
		// Fallback for non-semantic versions
		return major ? `${current}.1` : `${current}.0.1`;
	}

	let useMajorBump = $state(false);
	let suggestedRevision = $derived(getNextRevision(data.document.currentRevision, useMajorBump));
</script>

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

	<TronCard>
		<h2 class="tron-text-primary mb-6 text-xl font-bold">
			New Revision for {data.document.documentNumber}
		</h2>

		{#if form?.error}
			<div class="mb-4 rounded-lg border border-[var(--color-tron-red)] bg-red-500/10 p-4">
				<p class="text-[var(--color-tron-red)]">{form.error}</p>
			</div>
		{/if}

		<form
			method="POST"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update();
					submitting = false;
				};
			}}
			class="space-y-6"
		>
			<!-- Document Info (Read-only) -->
			<div class="rounded-lg bg-[var(--color-tron-bg-tertiary)] p-4">
				<div class="grid gap-4 sm:grid-cols-3">
					<div>
						<div class="tron-text-muted text-sm">Document</div>
						<div class="tron-text-primary font-medium">{data.document.title}</div>
					</div>
					<div>
						<div class="tron-text-muted text-sm">Current Revision</div>
						<div class="font-mono text-[var(--color-tron-cyan)]">
							{data.document.currentRevision}
						</div>
					</div>
					<div>
						<div class="tron-text-muted text-sm">Category</div>
						<div class="tron-text-primary">{data.document.category ?? '—'}</div>
					</div>
				</div>
			</div>

			<!-- New Revision Number -->
			<div>
				<label class="tron-text-muted mb-2 block text-sm">New Revision *</label>
				<div class="flex items-center gap-4">
					<TronInput type="text" name="revision" value={suggestedRevision} required class="w-32" />
					<label class="flex items-center gap-2">
						<input
							type="checkbox"
							bind:checked={useMajorBump}
							class="h-4 w-4 rounded border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)]"
						/>
						<span class="tron-text-secondary text-sm">Major version bump</span>
					</label>
				</div>
			</div>

			<!-- Change Description -->
			<div>
				<label for="changeDescription" class="tron-text-muted mb-2 block text-sm">
					Change Description *
				</label>
				<TronInput
					type="text"
					id="changeDescription"
					name="changeDescription"
					placeholder="Describe what changed in this revision..."
					required
				/>
			</div>

			<!-- Content Editor/Preview Toggle -->
			<div>
				<div class="mb-2 flex items-center justify-between">
					<label class="tron-text-muted text-sm">Content</label>
					<button
						type="button"
						class="text-sm text-[var(--color-tron-cyan)] hover:underline"
						onclick={() => (showPreview = !showPreview)}
					>
						{showPreview ? 'Edit' : 'Preview'}
					</button>
				</div>

				{#if showPreview}
					<div
						class="tron-text-secondary prose max-w-none rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] p-4 whitespace-pre-wrap prose-invert"
					>
						{content || 'No content yet...'}
					</div>
					<input type="hidden" name="content" value={content} />
				{:else}
					<textarea
						name="content"
						bind:value={content}
						rows="15"
						class="tron-input w-full resize-y font-mono text-sm"
						placeholder="Enter document content..."
					></textarea>
				{/if}
			</div>

			<!-- Actions -->
			<div class="flex justify-end gap-3">
				<TronButton type="button" onclick={() => goto(`/documents/${data.document.id}`)}>
					Cancel
				</TronButton>
				<TronButton variant="primary" type="submit" disabled={submitting}>
					{submitting ? 'Creating...' : 'Create Revision'}
				</TronButton>
			</div>
		</form>
	</TronCard>
</div>
