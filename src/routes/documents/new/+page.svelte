<script lang="ts">
	import { enhance } from '$app/forms';
	import TronInput from '$lib/components/ui/TronInput.svelte';
	import TronButton from '$lib/components/ui/TronButton.svelte';

	let { form } = $props();

	const categories = ['SOP', 'Work Instruction', 'Form', 'Policy', 'Specification'];
</script>

<svelte:head>
	<title>New Document | Document Control</title>
</svelte:head>

<div class="page-container">
	<header class="page-header">
		<a href="/documents" class="back-link">&larr; Back to Documents</a>
		<h1 class="tron-heading">New Document</h1>
	</header>

	<form method="POST" use:enhance class="document-form">
		{#if form?.error}
			<div class="error-message">{form.error}</div>
		{/if}

		<div class="form-row">
			<div class="form-group">
				<label for="documentNumber" class="tron-label">Document Number *</label>
				<TronInput
					type="text"
					id="documentNumber"
					name="documentNumber"
					placeholder="e.g., SOP-001"
					value={form?.documentNumber ?? ''}
					required
				/>
			</div>

			<div class="form-group">
				<label for="category" class="tron-label">Category</label>
				<select id="category" name="category" class="tron-select">
					<option value="">Select category...</option>
					{#each categories as cat}
						<option value={cat} selected={form?.category === cat}>{cat}</option>
					{/each}
				</select>
			</div>
		</div>

		<div class="form-group">
			<label for="title" class="tron-label">Title *</label>
			<TronInput
				type="text"
				id="title"
				name="title"
				placeholder="Document title"
				value={form?.title ?? ''}
				required
			/>
		</div>

		<div class="form-group">
			<label for="content" class="tron-label">Content *</label>
			<textarea
				id="content"
				name="content"
				class="tron-input content-area"
				placeholder="Enter document content (Markdown supported)"
				rows="15"
				required>{form?.content ?? ''}</textarea
			>
		</div>

		<div class="form-actions">
			<a href="/documents" class="tron-button">Cancel</a>
			<TronButton type="submit" variant="primary">Create Document</TronButton>
		</div>
	</form>
</div>

<style>
	.page-container {
		max-width: 800px;
		margin: 0 auto;
		padding: 2rem;
	}

	.page-header {
		margin-bottom: 2rem;
	}

	.back-link {
		display: inline-block;
		margin-bottom: 0.5rem;
		font-size: 0.875rem;
		color: var(--color-tron-cyan);
		text-decoration: none;
	}

	.back-link:hover {
		text-decoration: underline;
	}

	h1 {
		margin: 0;
		font-size: 1.75rem;
		color: var(--color-tron-text-primary);
	}

	.document-form {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	.error-message {
		padding: 0.75rem 1rem;
		background-color: rgba(255, 51, 102, 0.1);
		border: 1px solid var(--color-tron-red);
		border-radius: 0.375rem;
		color: var(--color-tron-red);
		font-size: 0.875rem;
	}

	.form-row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;
	}

	@media (max-width: 600px) {
		.form-row {
			grid-template-columns: 1fr;
		}
	}

	.form-group {
		display: flex;
		flex-direction: column;
	}

	.content-area {
		resize: vertical;
		min-height: 200px;
		font-family: monospace;
		line-height: 1.5;
	}

	.form-actions {
		display: flex;
		justify-content: flex-end;
		gap: 1rem;
		padding-top: 1rem;
		border-top: 1px solid var(--color-tron-border);
	}
</style>
