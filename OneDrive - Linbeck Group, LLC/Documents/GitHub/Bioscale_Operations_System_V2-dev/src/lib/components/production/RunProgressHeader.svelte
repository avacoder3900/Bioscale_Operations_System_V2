<script lang="ts">
	interface Progress {
		total: number;
		completed: number;
		inProgress: number;
		pending: number;
	}

	type RunStatus = 'approved' | 'in_progress' | 'paused' | 'completed' | 'cancelled';

	interface Props {
		runNumber: string;
		workInstructionTitle: string;
		leadBuilder: string;
		status: RunStatus;
		progress: Progress;
		startedAt: Date | null;
	}

	let { runNumber, workInstructionTitle, leadBuilder, status, progress, startedAt }: Props =
		$props();

	let elapsed = $state('');

	function formatElapsed(ms: number): string {
		const totalSec = Math.floor(ms / 1000);
		const h = Math.floor(totalSec / 3600);
		const m = Math.floor((totalSec % 3600) / 60);
		const s = totalSec % 60;
		return h > 0
			? `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`
			: `${m}m ${String(s).padStart(2, '0')}s`;
	}

	$effect(() => {
		if (!startedAt) {
			elapsed = '';
			return;
		}
		const start = new Date(startedAt).getTime();
		const tick = () => {
			elapsed = formatElapsed(Date.now() - start);
		};
		tick();
		if (status === 'in_progress') {
			const id = setInterval(tick, 1000);
			return () => clearInterval(id);
		}
	});

	const statusLabel: Record<RunStatus, string> = {
		approved: 'Approved',
		in_progress: 'In Progress',
		paused: 'Paused',
		completed: 'Completed',
		cancelled: 'Cancelled'
	};

	const statusClass: Record<RunStatus, string> = {
		approved: 'badge-yellow',
		in_progress: 'badge-cyan',
		paused: 'badge-orange',
		completed: 'badge-green',
		cancelled: 'badge-red'
	};

	let percentage = $derived(
		progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0
	);
</script>

<div class="tron-card run-header">
	<div class="top-row">
		<div class="run-info">
			<span class="run-number">{runNumber}</span>
			<span class="status-badge {statusClass[status]}">{statusLabel[status]}</span>
		</div>
		{#if elapsed}
			<span class="elapsed">{elapsed}</span>
		{/if}
	</div>

	<div class="details">
		<span class="wi-title">{workInstructionTitle}</span>
		<span class="lead-builder">Lead: {leadBuilder}</span>
	</div>

	<div class="progress-section">
		<div class="progress-label">
			<span>{progress.completed}/{progress.total} units</span>
			<span class="progress-pct">{percentage}%</span>
		</div>
		<div class="tron-progress">
			<div class="tron-progress-bar" style="width: {percentage}%"></div>
		</div>
		<div class="progress-breakdown">
			{#if progress.inProgress > 0}
				<span class="breakdown-item cyan">{progress.inProgress} active</span>
			{/if}
			{#if progress.pending > 0}
				<span class="breakdown-item muted">{progress.pending} pending</span>
			{/if}
		</div>
	</div>
</div>

<style>
	.run-header {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.top-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		flex-wrap: wrap;
	}

	.run-info {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.run-number {
		font-family: monospace;
		font-size: 1.5rem;
		font-weight: 700;
		color: var(--color-tron-cyan);
		letter-spacing: 0.05em;
	}

	.status-badge {
		display: inline-flex;
		align-items: center;
		padding: 0.25rem 0.75rem;
		border-radius: 9999px;
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.badge-yellow {
		border: 1px solid #fbbf24;
		color: #fbbf24;
	}

	.badge-cyan {
		border: 1px solid var(--color-tron-cyan);
		color: var(--color-tron-cyan);
		animation: tron-pulse 2s ease-in-out infinite;
	}

	.badge-orange {
		border: 1px solid var(--color-tron-orange);
		color: var(--color-tron-orange);
	}

	.badge-green {
		border: 1px solid var(--color-tron-green);
		color: var(--color-tron-green);
	}

	.badge-red {
		border: 1px solid var(--color-tron-red);
		color: var(--color-tron-red);
	}

	.elapsed {
		font-family: monospace;
		font-size: 1.125rem;
		color: var(--color-tron-text-secondary);
	}

	.details {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1.5rem;
	}

	.wi-title {
		font-size: 1.125rem;
		color: var(--color-tron-text-primary);
		font-weight: 500;
	}

	.lead-builder {
		font-size: 0.875rem;
		color: var(--color-tron-text-secondary);
	}

	.progress-section {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	.progress-label {
		display: flex;
		justify-content: space-between;
		font-size: 0.875rem;
		color: var(--color-tron-text-secondary);
	}

	.progress-pct {
		color: var(--color-tron-cyan);
		font-weight: 600;
	}

	.progress-breakdown {
		display: flex;
		gap: 1rem;
		font-size: 0.75rem;
	}

	.breakdown-item.cyan {
		color: var(--color-tron-cyan);
	}

	.breakdown-item.muted {
		color: var(--color-tron-text-secondary);
	}
</style>
