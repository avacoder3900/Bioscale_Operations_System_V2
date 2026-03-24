<script lang="ts">
	import TronCard from '$lib/components/ui/TronCard.svelte';
	import DocumentStatusBadge from './DocumentStatusBadge.svelte';

	interface Props {
		id: string;
		documentNumber: string;
		title: string;
		category?: string | null;
		revision: string;
		status: string;
		effectiveDate?: Date | string | null;
	}

	let { id, documentNumber, title, category, revision, status, effectiveDate }: Props = $props();

	function formatDate(date: Date | string | null | undefined): string {
		if (!date) return '—';
		const d = typeof date === 'string' ? new Date(date) : date;
		return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
	}
</script>

<a href="/documents/{id}" class="block">
	<TronCard interactive class="document-card">
		<div class="card-header">
			<span class="document-number">{documentNumber}</span>
			<DocumentStatusBadge {status} />
		</div>

		<h3 class="document-title">{title}</h3>

		<div class="card-meta">
			{#if category}
				<span class="category">{category}</span>
			{/if}
			<span class="revision">Rev {revision}</span>
			{#if effectiveDate}
				<span class="effective-date">Effective: {formatDate(effectiveDate)}</span>
			{/if}
		</div>
	</TronCard>
</a>

<style>
	a {
		text-decoration: none;
		display: block;
	}

	:global(.document-card) {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.card-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.document-number {
		font-family: monospace;
		font-size: 0.875rem;
		color: var(--color-tron-cyan);
		font-weight: 600;
	}

	.document-title {
		margin: 0;
		font-size: 1rem;
		font-weight: 500;
		color: var(--color-tron-text-primary);
		line-height: 1.4;
	}

	.card-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		font-size: 0.8125rem;
		color: var(--color-tron-text-secondary);
	}

	.category {
		text-transform: capitalize;
	}

	.revision {
		font-weight: 500;
	}
</style>
