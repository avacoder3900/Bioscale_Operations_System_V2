<script lang="ts">
	interface Run {
		runId: string;
		robotId: string;
		deckId: string | null;
		operatorName: string;
		status: string;
		plannedCartridgeCount: number;
		coolingConfirmed: boolean;
		durationMinutes: number | null;
		createdAt: string;
	}

	interface CoolingCartridge {
		cartridgeId: string;
		waxRunId: string | null;
		deckPosition: number | null;
		transferTimeSeconds: number | null;
		qcStatus: string;
		rejectionReason: string | null;
		currentInventory: string;
	}

	interface Operator {
		operatorName: string;
		runCount: number;
		lastRunDate: string | null;
	}

	interface Props {
		data: {
			trayId: string;
			tray: {
				status: string;
				assignedRunId: string | null;
				createdAt: string;
			} | null;
			runs: Run[];
			coolingCartridges: CoolingCartridge[];
			operators: Operator[];
			stats: {
				totalRuns: number;
				totalCooled: number;
				acceptanceRate: number;
				avgTransferTime: number | null;
				rejections: number;
			};
		};
	}

	let { data }: Props = $props();

	function qcBadgeClass(status: string): string {
		if (status === 'Accepted') return 'tron-badge tron-badge-success';
		if (status === 'Rejected') return 'tron-badge tron-badge-error';
		return 'tron-badge tron-badge-neutral';
	}

	function runStatusBadge(status: string): string {
		if (status === 'Completed') return 'tron-badge tron-badge-success';
		if (status === 'Aborted') return 'tron-badge tron-badge-error';
		return 'tron-badge tron-badge-neutral';
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center gap-3">
		<!-- eslint-disable svelte/no-navigation-without-resolve -->
		<a href="/spu/equipment/decks-trays" class="text-sm text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]">&larr; Back</a>
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
		<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">Tray: <span class="font-mono text-[var(--color-tron-cyan)]">{data.trayId}</span></h1>
		{#if data.tray}
			<span class="tron-badge {data.tray.status === 'Available' ? 'tron-badge-success' : data.tray.status === 'In Use' ? 'tron-badge-warning' : 'tron-badge-neutral'}">{data.tray.status}</span>
		{/if}
	</div>

	{#if data.tray}
		<div class="flex flex-wrap gap-4 text-xs text-[var(--color-tron-text-secondary)]">
			<span>Registered: {new Date(data.tray.createdAt).toLocaleDateString()}</span>
			{#if data.tray.assignedRunId}
				<span>Assigned run: <span class="font-mono text-[var(--color-tron-cyan)]">{data.tray.assignedRunId}</span></span>
			{/if}
		</div>
	{/if}

	<!-- Summary stats -->
	<div class="grid grid-cols-2 gap-3 sm:grid-cols-5">
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-center">
			<p class="text-xs text-[var(--color-tron-text-secondary)]">Total Runs</p>
			<p class="text-xl font-bold text-[var(--color-tron-cyan)]">{data.stats.totalRuns}</p>
		</div>
		<div class="rounded-lg border border-green-500/30 bg-green-900/10 px-3 py-2 text-center">
			<p class="text-xs text-green-400/70">Cartridges Cooled</p>
			<p class="text-xl font-bold text-green-400">{data.stats.totalCooled}</p>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-center">
			<p class="text-xs text-[var(--color-tron-text-secondary)]">Acceptance Rate</p>
			<p class="text-xl font-bold {data.stats.acceptanceRate >= 0.9 ? 'text-green-400' : data.stats.acceptanceRate >= 0.7 ? 'text-amber-400' : 'text-red-400'}">{(data.stats.acceptanceRate * 100).toFixed(1)}%</p>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-center">
			<p class="text-xs text-[var(--color-tron-text-secondary)]">Avg Transfer Time</p>
			<p class="text-xl font-bold text-[var(--color-tron-text)]">{data.stats.avgTransferTime != null ? `${data.stats.avgTransferTime}s` : '-'}</p>
		</div>
		<div class="rounded-lg border border-red-500/30 bg-red-900/10 px-3 py-2 text-center">
			<p class="text-xs text-red-400/70">Rejections</p>
			<p class="text-xl font-bold text-red-400">{data.stats.rejections}</p>
		</div>
	</div>

	<!-- Run history -->
	{#if data.runs.length > 0}
		<section>
			<h2 class="mb-3 text-lg font-medium text-[var(--color-tron-cyan)]">Run History</h2>
			<div class="overflow-x-auto">
				<table class="tron-table w-full text-sm">
					<thead>
						<tr>
							<th>Run ID</th>
							<th>Robot</th>
							<th>Deck</th>
							<th>Operator</th>
							<th>Status</th>
							<th>Duration</th>
							<th>Cooling Confirmed</th>
							<th>Cartridges</th>
							<th>Date</th>
						</tr>
					</thead>
					<tbody>
						{#each data.runs as run (run.runId)}
							<tr>
								<td class="font-mono text-[var(--color-tron-cyan)]">{run.runId}</td>
								<td class="font-mono text-xs">{run.robotId}</td>
								<td class="font-mono text-xs">{run.deckId ?? '-'}</td>
								<td>{run.operatorName}</td>
								<td><span class={runStatusBadge(run.status)}>{run.status}</span></td>
								<td class="text-xs">{run.durationMinutes != null ? `${run.durationMinutes}m` : '-'}</td>
								<td>
									{#if run.coolingConfirmed}
										<span class="text-green-400">Yes</span>
									{:else}
										<span class="text-[var(--color-tron-text-secondary)]">No</span>
									{/if}
								</td>
								<td>{run.plannedCartridgeCount}</td>
								<td class="text-xs text-[var(--color-tron-text-secondary)]">{new Date(run.createdAt).toLocaleDateString()}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{:else}
		<p class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-6 text-center text-sm text-[var(--color-tron-text-secondary)]">No runs recorded for this tray.</p>
	{/if}

	<!-- Cartridge cooling details -->
	{#if data.coolingCartridges.length > 0}
		<section>
			<h2 class="mb-3 text-lg font-medium text-[var(--color-tron-cyan)]">Cartridge Cooling Details</h2>
			<div class="overflow-x-auto">
				<table class="tron-table w-full text-sm">
					<thead>
						<tr>
							<th>Cartridge ID</th>
							<th>Run ID</th>
							<th>Position</th>
							<th>Transfer Time</th>
							<th>QC Status</th>
							<th>Rejection Reason</th>
							<th>Inventory</th>
						</tr>
					</thead>
					<tbody>
						{#each data.coolingCartridges as cart (cart.cartridgeId)}
							<tr>
								<td class="font-mono text-[var(--color-tron-cyan)]">{cart.cartridgeId}</td>
								<td class="font-mono text-xs">{cart.waxRunId ?? '-'}</td>
								<td>{cart.deckPosition ?? '-'}</td>
								<td>{cart.transferTimeSeconds != null ? `${cart.transferTimeSeconds}s` : '-'}</td>
								<td><span class={qcBadgeClass(cart.qcStatus)}>{cart.qcStatus}</span></td>
								<td class="text-xs text-[var(--color-tron-text-secondary)]">{cart.rejectionReason ?? '-'}</td>
								<td class="text-xs text-[var(--color-tron-text-secondary)]">{cart.currentInventory}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{/if}

	<!-- Operator history -->
	{#if data.operators.length > 0}
		<section>
			<h2 class="mb-3 text-lg font-medium text-[var(--color-tron-cyan)]">Operator History</h2>
			<div class="overflow-x-auto">
				<table class="tron-table w-full text-sm">
					<thead><tr><th>Operator</th><th>Run Count</th><th>Last Run</th></tr></thead>
					<tbody>
						{#each data.operators as op (op.operatorName)}
							<tr>
								<td>{op.operatorName}</td>
								<td>{op.runCount}</td>
								<td class="text-[var(--color-tron-text-secondary)]">{op.lastRunDate ? new Date(op.lastRunDate).toLocaleDateString() : '-'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{/if}
</div>
