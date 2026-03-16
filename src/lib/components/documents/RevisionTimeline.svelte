<script lang="ts">
	interface Revision {
		id: string;
		revision: string;
		status: string;
		createdAt: Date | string;
		createdBy?: { username: string } | null;
		changeDescription?: string | null;
	}

	interface Props {
		revisions: Revision[];
		currentRevision?: string;
		initialCollapsed?: boolean;
	}

	let { revisions, currentRevision, initialCollapsed = true }: Props = $props();

	let showAll = $state(!initialCollapsed || revisions.length <= 3);

	let visibleRevisions = $derived(showAll ? revisions : revisions.slice(0, 2));
	let hiddenCount = $derived(revisions.length - 2);

	function formatDate(date: Date | string): string {
		const d = typeof date === 'string' ? new Date(date) : date;
		return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
	}

	const statusConfig: Record<string, { color: string; label: string }> = {
		draft: { color: 'var(--color-tron-text-secondary)', label: 'Draft' },
		in_review: { color: 'var(--color-tron-orange)', label: 'In Review' },
		approved: { color: 'var(--color-tron-cyan)', label: 'Approved' },
		effective: { color: 'var(--color-tron-green)', label: 'Effective' },
		retired: { color: 'var(--color-tron-red)', label: 'Retired' }
	};
</script>

<div class="timeline">
	{#each visibleRevisions as revision, index}
		{@const isCurrent = revision.revision === currentRevision}
		{@const config = statusConfig[revision.status] ?? {
			color: 'var(--color-tron-text-secondary)',
			label: revision.status
		}}
		{@const isLast = index === visibleRevisions.length - 1 && !showAll && hiddenCount <= 0}

		<div class="timeline-item" class:current={isCurrent}>
			<div class="timeline-marker" style="border-color: {config.color}">
				{#if isCurrent}
					<div class="marker-dot" style="background-color: {config.color}"></div>
				{/if}
			</div>

			{#if !isLast}
				<div class="timeline-line"></div>
			{/if}

			<div class="timeline-content">
				<div class="timeline-header">
					<span class="revision-number" class:current={isCurrent}>
						Rev {revision.revision}
					</span>
					<span class="status-label" style="color: {config.color}">
						{config.label}
					</span>
				</div>

				<div class="timeline-meta">
					<span class="date">{formatDate(revision.createdAt)}</span>
					{#if revision.createdBy?.username}
						<span class="separator">by</span>
						<span class="author">{revision.createdBy.username}</span>
					{/if}
				</div>

				{#if revision.changeDescription}
					<p class="change-description">{revision.changeDescription}</p>
				{/if}
			</div>
		</div>
	{/each}

	{#if !showAll && hiddenCount > 0}
		<button class="show-more" onclick={() => (showAll = true)}>
			<div class="timeline-marker collapsed">
				<span class="count">+{hiddenCount}</span>
			</div>
			<span class="show-more-text"
				>Show {hiddenCount} older revision{hiddenCount > 1 ? 's' : ''}</span
			>
		</button>
	{/if}
</div>

<style>
	.timeline {
		position: relative;
		padding-left: 1rem;
	}

	.timeline-item {
		position: relative;
		padding-bottom: 1.5rem;
		padding-left: 1.5rem;
	}

	.timeline-item.current {
		padding-bottom: 1.75rem;
	}

	.timeline-marker {
		position: absolute;
		left: 0;
		top: 0;
		width: 1rem;
		height: 1rem;
		border-radius: 50%;
		border: 2px solid var(--color-tron-border);
		background-color: var(--color-tron-bg-card);
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.marker-dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
	}

	.timeline-line {
		position: absolute;
		left: 0.4375rem;
		top: 1rem;
		bottom: 0;
		width: 1px;
		background-color: var(--color-tron-border);
	}

	.timeline-content {
		min-height: 2rem;
	}

	.timeline-header {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 0.25rem;
	}

	.revision-number {
		font-weight: 600;
		color: var(--color-tron-text-primary);
		font-size: 0.9375rem;
	}

	.revision-number.current {
		color: var(--color-tron-cyan);
	}

	.status-label {
		font-size: 0.75rem;
		font-weight: 500;
	}

	.timeline-meta {
		font-size: 0.8125rem;
		color: var(--color-tron-text-secondary);
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}

	.separator {
		color: var(--color-tron-text-secondary);
		opacity: 0.6;
	}

	.author {
		color: var(--color-tron-text-primary);
	}

	.change-description {
		margin-top: 0.5rem;
		font-size: 0.8125rem;
		color: var(--color-tron-text-secondary);
		line-height: 1.4;
	}

	.show-more {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0;
		padding-left: 1.5rem;
		background: none;
		border: none;
		cursor: pointer;
		position: relative;
	}

	.show-more .timeline-marker {
		border-style: dashed;
		width: 1.25rem;
		height: 1.25rem;
		left: -0.125rem;
	}

	.show-more .count {
		font-size: 0.625rem;
		font-weight: 600;
		color: var(--color-tron-text-secondary);
	}

	.show-more-text {
		font-size: 0.8125rem;
		color: var(--color-tron-cyan);
		transition: color 0.2s ease;
	}

	.show-more:hover .show-more-text {
		color: var(--color-tron-text-primary);
	}
</style>
