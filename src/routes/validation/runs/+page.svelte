<script lang="ts">
	import { enhance } from '$app/forms';

	interface RosterSpu {
		id: string;
		udi: string;
		batchNumber: string | null;
		status: string;
		validationStatus: string;
		magStatus: string;
		thermoStatus: string;
		activeRun: { runId: string; runNumber: string } | null;
		createdAt: string | null;
	}

	interface RunSummary {
		id: string;
		runNumber: string;
		name: string | null;
		status: string;
		spuCount: number;
		progress: { passed: number; total: number };
		startedAt: string | null;
		completedAt: string | null;
		createdBy: string | null;
	}

	interface Props {
		data: { spus: RosterSpu[]; runs: RunSummary[] };
		form: { error?: string } | null;
	}

	let { data, form }: Props = $props();

	let selected = $state<Record<string, boolean>>({});
	let runName = $state('');
	let statusFilter = $state<'all' | 'in_progress' | 'completed' | 'aborted'>('all');
	let isSubmitting = $state(false);

	let selectedIds = $derived(Object.entries(selected).filter(([, v]) => v).map(([k]) => k));
	let filteredRuns = $derived(
		statusFilter === 'all' ? data.runs : data.runs.filter(r => r.status === statusFilter)
	);

	function statusChip(status: string): string {
		if (status === 'passed') return 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]';
		if (status === 'failed') return 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]';
		if (status === 'uploaded') return 'bg-[var(--color-tron-orange)]/20 text-[var(--color-tron-orange)]';
		return 'bg-[var(--color-tron-text-secondary)]/20 text-[var(--color-tron-text-secondary)]';
	}

	function runChip(status: string): string {
		if (status === 'in_progress') return 'bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]';
		if (status === 'completed') return 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]';
		return 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]';
	}

	function fmtDate(d: string | null): string {
		return d ? new Date(d).toLocaleString() : '—';
	}
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="tron-heading text-2xl font-bold">Validation Runs</h1>
			<p class="tron-text-muted mt-1">Batch multiple SPUs into one tracked validation run</p>
		</div>
	</div>

	{#if form?.error}
		<div class="rounded-lg bg-[var(--color-tron-red)]/10 p-4 text-[var(--color-tron-red)]">
			{form.error}
		</div>
	{/if}

	<!-- SPUs in Validation -->
	<form
		method="POST"
		action="?/startRun"
		use:enhance={() => {
			isSubmitting = true;
			return async ({ update }) => {
				await update();
				isSubmitting = false;
			};
		}}
	>
		<div class="tron-card">
			<div class="flex items-center justify-between border-b border-[var(--color-tron-border)] p-4">
				<h2 class="tron-heading text-lg font-semibold">SPUs in Validation ({data.spus.length})</h2>
				<div class="flex items-center gap-3">
					<input
						type="text"
						name="name"
						bind:value={runName}
						placeholder="Run name (optional)"
						class="tron-input rounded-lg px-3 py-2 text-sm"
					/>
					<button
						type="submit"
						disabled={selectedIds.length === 0 || isSubmitting}
						class="rounded-lg bg-[var(--color-tron-orange)] px-4 py-2 text-sm font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:bg-[var(--color-tron-orange)]/90 disabled:cursor-not-allowed disabled:opacity-50"
					>
						{isSubmitting ? 'Starting…' : `Start Validation Run (${selectedIds.length})`}
					</button>
				</div>
			</div>

			{#if data.spus.length === 0}
				<p class="tron-text-muted p-6 text-sm">
					No SPUs are currently in validation. Set an SPU's status to <span class="font-medium">validating</span> from its detail page to see it here.
				</p>
			{:else}
				<div class="overflow-x-auto">
					<table class="w-full text-sm">
						<thead>
							<tr class="border-b border-[var(--color-tron-border)] text-left">
								<th class="p-3"></th>
								<th class="tron-text-muted p-3 font-medium">UDI</th>
								<th class="tron-text-muted p-3 font-medium">Batch</th>
								<th class="tron-text-muted p-3 font-medium">Status</th>
								<th class="tron-text-muted p-3 font-medium">Mag</th>
								<th class="tron-text-muted p-3 font-medium">Thermo</th>
								<th class="tron-text-muted p-3 font-medium">Active Run</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-[var(--color-tron-border)]">
							{#each data.spus as spu (spu.id)}
								<tr class={spu.activeRun ? 'opacity-60' : ''}>
									<td class="p-3">
										{#if spu.activeRun}
											<input type="checkbox" disabled title="Already in {spu.activeRun.runNumber}" />
										{:else}
											<input type="checkbox" name="spuIds" value={spu.id} bind:checked={selected[spu.id]} />
										{/if}
									</td>
									<td class="p-3">
										<a href="/spu/{spu.id}" class="tron-heading font-medium hover:text-[var(--color-tron-cyan)] hover:underline">{spu.udi}</a>
									</td>
									<td class="tron-text-muted p-3">{spu.batchNumber ?? '—'}</td>
									<td class="p-3 capitalize">{spu.status}</td>
									<td class="p-3">
										<span class="rounded-full px-2 py-1 text-xs font-medium capitalize {statusChip(spu.magStatus)}">{spu.magStatus}</span>
									</td>
									<td class="p-3">
										<span class="rounded-full px-2 py-1 text-xs font-medium capitalize {statusChip(spu.thermoStatus)}">{spu.thermoStatus}</span>
									</td>
									<td class="p-3">
										{#if spu.activeRun}
											<a href="/validation/runs/{spu.activeRun.runId}" class="text-[var(--color-tron-cyan)] hover:underline">{spu.activeRun.runNumber}</a>
										{:else}
											<span class="tron-text-muted">—</span>
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
	</form>

	<!-- Run history -->
	<div class="tron-card">
		<div class="flex items-center justify-between border-b border-[var(--color-tron-border)] p-4">
			<h2 class="tron-heading text-lg font-semibold">Runs</h2>
			<div class="flex gap-2">
				{#each [['all', 'All'], ['in_progress', 'In Progress'], ['completed', 'Completed'], ['aborted', 'Aborted']] as [value, label] (value)}
					<button
						type="button"
						onclick={() => statusFilter = value as typeof statusFilter}
						class="rounded-lg px-3 py-1 text-xs font-medium transition-colors
							{statusFilter === value
								? 'bg-[var(--color-tron-cyan)] text-[var(--color-tron-bg-primary)]'
								: 'bg-[var(--color-tron-bg-tertiary)] text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]'}"
					>
						{label}
					</button>
				{/each}
			</div>
		</div>

		{#if filteredRuns.length === 0}
			<p class="tron-text-muted p-6 text-sm">No validation runs yet.</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b border-[var(--color-tron-border)] text-left">
							<th class="tron-text-muted p-3 font-medium">Run #</th>
							<th class="tron-text-muted p-3 font-medium">Name</th>
							<th class="tron-text-muted p-3 font-medium">SPUs</th>
							<th class="tron-text-muted p-3 font-medium">Progress</th>
							<th class="tron-text-muted p-3 font-medium">Status</th>
							<th class="tron-text-muted p-3 font-medium">Started</th>
							<th class="tron-text-muted p-3 font-medium">Completed</th>
							<th class="tron-text-muted p-3 font-medium">By</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-[var(--color-tron-border)]">
						{#each filteredRuns as run (run.id)}
							<tr class="transition-colors hover:bg-[var(--color-tron-bg-tertiary)]">
								<td class="p-3">
									<a href="/validation/runs/{run.id}" class="tron-heading font-medium text-[var(--color-tron-cyan)] hover:underline">{run.runNumber}</a>
								</td>
								<td class="p-3">{run.name ?? '—'}</td>
								<td class="p-3">{run.spuCount}</td>
								<td class="p-3">{run.progress.passed}/{run.progress.total} steps passed</td>
								<td class="p-3">
									<span class="rounded-full px-2 py-1 text-xs font-medium {runChip(run.status)}">
										{run.status === 'in_progress' ? 'In Progress' : run.status === 'completed' ? 'Completed' : 'Aborted'}
									</span>
								</td>
								<td class="tron-text-muted p-3">{fmtDate(run.startedAt)}</td>
								<td class="tron-text-muted p-3">{fmtDate(run.completedAt)}</td>
								<td class="tron-text-muted p-3">{run.createdBy ?? '—'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
</div>
