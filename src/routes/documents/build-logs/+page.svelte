<script lang="ts">
	import { resolve } from '$app/paths';

	interface Run {
		id: string;
		runNumber: string;
		status: string;
		quantity: number;
		startedAt: Date | null;
		completedAt: Date | null;
		createdAt: Date;
		workInstructionId: string;
		documentNumber: string;
		workInstructionTitle: string;
		leadBuilderName: string;
		unitCount: number;
		completedUnitCount: number;
		cancelReason: string | null;
		cancelledBy: string | null;
	}

	interface Props {
		data: {
			runs: Run[];
		};
	}

	let { data }: Props = $props();

	let statusFilter = $state('all');

	let filteredRuns = $derived(
		statusFilter === 'all'
			? data.runs
			: data.runs.filter((r) => r.status === statusFilter)
	);

	function formatDate(date: Date | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
	}

	function getStatusLabel(status: string): string {
		switch (status) {
			case 'in_progress':
				return 'In Progress';
			case 'inventory_check':
				return 'Inv. Check';
			default:
				return status.charAt(0).toUpperCase() + status.slice(1);
		}
	}

	function getStatusColor(status: string): string {
		switch (status) {
			case 'completed':
				return 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]';
			case 'cancelled':
				return 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]';
			case 'in_progress':
				return 'bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]';
			case 'paused':
				return 'bg-[var(--color-tron-orange)]/20 text-[var(--color-tron-orange)]';
			case 'approved':
				return 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]';
			default:
				return 'bg-[var(--color-tron-bg-tertiary)] text-[var(--color-tron-text-secondary)]';
		}
	}

	// Collect unique statuses for filter dropdown
	const statuses = ['all', 'completed', 'cancelled', 'in_progress', 'paused', 'approved', 'planning'];
</script>

<svelte:head>
	<title>Build Logs | Documents</title>
</svelte:head>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="tron-heading text-2xl font-bold">Build Logs</h1>
			<p class="tron-text-muted text-sm mt-1">Production run history across all work instructions</p>
		</div>
		<div class="flex items-center gap-3">
			<label for="status-filter" class="tron-text-muted text-sm">Status</label>
			<select
				id="status-filter"
				bind:value={statusFilter}
				class="tron-input px-3 py-2 text-sm"
				style="min-height: 44px; min-width: 150px;"
			>
				{#each statuses as s}
					<option value={s}>{s === 'all' ? 'All Statuses' : getStatusLabel(s)}</option>
				{/each}
			</select>
		</div>
	</div>

	{#if filteredRuns.length === 0}
		<div class="tron-card p-8 text-center">
			<svg
				class="mx-auto h-12 w-12 text-[var(--color-tron-text-secondary)]"
				fill="none"
				viewBox="0 0 24 24"
				stroke="currentColor"
			>
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width="2"
					d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
				/>
			</svg>
			<p class="tron-text-muted mt-4">No production runs found</p>
		</div>
	{:else}
		<div class="tron-card overflow-hidden">
			<div class="overflow-x-auto">
				<table class="tron-table w-full">
					<thead>
						<tr>
							<th>Run #</th>
							<th>Work Instruction</th>
							<th>Status</th>
							<th>Units</th>
							<th>Lead Builder</th>
							<th>Started</th>
							<th>Completed</th>
							<th></th>
						</tr>
					</thead>
					<tbody>
						{#each filteredRuns as run (run.id)}
							<tr>
								<td>
									<span class="font-mono font-bold text-[var(--color-tron-cyan)]">
										{run.runNumber}
									</span>
								</td>
								<td>
									<a
										href={resolve(`/documents/instructions/${run.workInstructionId}`)}
										class="text-[var(--color-tron-text-primary)] hover:text-[var(--color-tron-cyan)] transition-colors"
									>
										<span class="font-mono text-xs tron-text-muted">{run.documentNumber}</span>
										<br />
										{run.workInstructionTitle}
									</a>
								</td>
								<td>
									<span
										class="inline-flex rounded-full px-2 py-0.5 text-xs font-semibold capitalize {getStatusColor(run.status)}"
									>
										{getStatusLabel(run.status)}
									</span>
									{#if run.status === 'cancelled' && run.cancelReason}
										<p class="text-xs text-[var(--color-tron-red)] mt-1 max-w-[200px] truncate" title={run.cancelReason}>
											{run.cancelReason}
										</p>
										{#if run.cancelledBy}
											<p class="text-xs tron-text-muted">by {run.cancelledBy}</p>
										{/if}
									{/if}
								</td>
								<td>
									<span class="font-mono">
										{run.completedUnitCount}/{run.quantity}
									</span>
								</td>
								<td class="tron-text-primary">{run.leadBuilderName}</td>
								<td class="tron-text-muted text-sm">{formatDate(run.startedAt)}</td>
								<td class="tron-text-muted text-sm">{formatDate(run.completedAt)}</td>
								<td>
									<a
										href={resolve(`/documents/instructions/${run.workInstructionId}/run/${run.id}`)}
										class="text-[var(--color-tron-cyan)] text-sm hover:underline"
										style="min-height: 44px; display: inline-flex; align-items: center;"
									>
										View
									</a>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>

		<p class="tron-text-muted text-sm text-center">
			Showing {filteredRuns.length} of {data.runs.length} runs
		</p>
	{/if}
</div>
