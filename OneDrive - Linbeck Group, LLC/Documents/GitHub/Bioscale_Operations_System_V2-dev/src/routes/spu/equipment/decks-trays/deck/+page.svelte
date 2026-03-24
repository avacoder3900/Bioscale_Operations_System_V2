<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';

	interface Cartridge {
		cartridgeId: string;
		waxRunId: string | null;
		deckPosition: number | null;
		qcStatus: string;
		rejectionReason: string | null;
		transferTimeSeconds: number | null;
		currentInventory: string;
	}

	interface PositionStat {
		position: number;
		totalFills: number;
		acceptedCount: number;
		rejectedCount: number;
		successRate: number;
	}

	interface Run {
		runId: string;
		robotId: string;
		operatorName: string;
		status: string;
		waxSourceLot: string | null;
		waxTubeId: string | null;
		plannedCartridgeCount: number;
		coolingTrayId: string | null;
		abortReason: string | null;
		durationMinutes: number | null;
		runStartTime: string | null;
		createdAt: string;
	}

	interface HeatingEvent {
		id: string;
		eventType: string;
		temperatureC: number | null;
		notes: string | null;
		createdAt: string;
	}

	interface Operator {
		operatorName: string;
		runCount: number;
		lastRunDate: string | null;
	}

	interface Props {
		data: {
			deckId: string;
			deck: {
				status: string;
				lockoutUntil: string | null;
				lastUsed: string | null;
				createdAt: string;
			} | null;
			runs: Run[];
			cartridgesByRun: Record<string, Cartridge[]>;
			positionStats: PositionStat[];
			heatingHistory: HeatingEvent[];
			operators: Operator[];
			stats: {
				totalRuns: number;
				totalFills: number;
				acceptanceRate: number;
				uniqueOperators: number;
				heatingEvents: number;
			};
		};
	}

	let { data }: Props = $props();

	let expandedRun = $state<string | null>(null);

	const GRID_ROWS = [
		[1, 16, 17],
		[2, 15, 18],
		[3, 14, 19],
		[4, 13, 20],
		[5, 12, 21],
		[6, 11, 22],
		[7, 10, 23],
		[8,  9, 24]
	];

	function posStatMap(): SvelteMap<number, PositionStat> {
		const m = new SvelteMap<number, PositionStat>();
		for (const s of data.positionStats) m.set(s.position, s);
		return m;
	}

	const statsMap = $derived(posStatMap());

	function cellColor(stat: PositionStat | undefined): string {
		if (!stat || stat.totalFills === 0) return 'border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)]';
		if (stat.successRate >= 0.9) return 'border-green-500/50 bg-green-900/20';
		if (stat.successRate >= 0.7) return 'border-amber-500/50 bg-amber-900/20';
		return 'border-red-500/50 bg-red-900/20';
	}

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

	function toggleExpand(runId: string) {
		expandedRun = expandedRun === runId ? null : runId;
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center gap-3">
		<!-- eslint-disable svelte/no-navigation-without-resolve -->
		<a href="/spu/equipment/decks-trays" class="text-sm text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]">&larr; Back</a>
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
		<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">Deck: <span class="font-mono text-[var(--color-tron-cyan)]">{data.deckId}</span></h1>
		{#if data.deck}
			<span class="tron-badge {data.deck.status === 'Available' ? 'tron-badge-success' : data.deck.status === 'In Use' ? 'tron-badge-warning' : 'tron-badge-error'}">{data.deck.status}</span>
		{/if}
	</div>

	{#if data.deck}
		<div class="flex flex-wrap gap-4 text-xs text-[var(--color-tron-text-secondary)]">
			<span>Registered: {new Date(data.deck.createdAt).toLocaleDateString()}</span>
			{#if data.deck.lastUsed}
				<span>Last used: {new Date(data.deck.lastUsed).toLocaleString()}</span>
			{/if}
			{#if data.deck.lockoutUntil && new Date(data.deck.lockoutUntil) > new Date()}
				<span class="text-red-400">Lockout expires: {new Date(data.deck.lockoutUntil).toLocaleString()}</span>
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
			<p class="text-xs text-green-400/70">Total Fills</p>
			<p class="text-xl font-bold text-green-400">{data.stats.totalFills}</p>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-center">
			<p class="text-xs text-[var(--color-tron-text-secondary)]">Acceptance Rate</p>
			<p class="text-xl font-bold {data.stats.acceptanceRate >= 0.9 ? 'text-green-400' : data.stats.acceptanceRate >= 0.7 ? 'text-amber-400' : 'text-red-400'}">{(data.stats.acceptanceRate * 100).toFixed(1)}%</p>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-center">
			<p class="text-xs text-[var(--color-tron-text-secondary)]">Unique Operators</p>
			<p class="text-xl font-bold text-[var(--color-tron-text)]">{data.stats.uniqueOperators}</p>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-center">
			<p class="text-xs text-[var(--color-tron-text-secondary)]">Heating Events</p>
			<p class="text-xl font-bold text-[var(--color-tron-text)]">{data.stats.heatingEvents}</p>
		</div>
	</div>

	<!-- Position stats grid -->
	<section>
		<h2 class="mb-3 text-lg font-medium text-[var(--color-tron-cyan)]">Position Statistics</h2>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
			<div class="mb-2 text-xs text-[var(--color-tron-text-secondary)]">Green = &gt;90% success, Amber = 70-90%, Red = &lt;70%</div>
			<div class="grid gap-1.5">
				{#each GRID_ROWS as row, rowIndex (rowIndex)}
					<div class="grid grid-cols-3 gap-1.5">
						{#each row as pos (pos)}
							{@const stat = statsMap.get(pos)}
							<div class="flex min-h-[50px] flex-col items-center justify-center rounded border text-center text-xs {cellColor(stat)}">
								<span class="font-mono text-[10px] text-[var(--color-tron-text-secondary)]">{pos}</span>
								{#if stat && stat.totalFills > 0}
									<span class="font-bold text-[var(--color-tron-text)]">{stat.totalFills}</span>
									<span class="text-[9px] {stat.successRate >= 0.9 ? 'text-green-400' : stat.successRate >= 0.7 ? 'text-amber-400' : 'text-red-400'}">
										{(stat.successRate * 100).toFixed(0)}%
									</span>
								{:else}
									<span class="text-[9px] text-[var(--color-tron-text-secondary)]">-</span>
								{/if}
							</div>
						{/each}
					</div>
				{/each}
			</div>
		</div>
	</section>

	<!-- Run history with expandable rows -->
	{#if data.runs.length > 0}
		<section>
			<h2 class="mb-3 text-lg font-medium text-[var(--color-tron-cyan)]">Run History</h2>
			<div class="overflow-x-auto">
				<table class="tron-table w-full text-sm">
					<thead>
						<tr>
							<th></th>
							<th>Run ID</th>
							<th>Robot</th>
							<th>Operator</th>
							<th>Status</th>
							<th>Wax Source</th>
							<th>Tube ID</th>
							<th>Cartridges</th>
							<th>Duration</th>
							<th>Cooling Tray</th>
							<th>Date</th>
						</tr>
					</thead>
					<tbody>
						{#each data.runs as run (run.runId)}
							<tr class="cursor-pointer hover:bg-[var(--color-tron-surface-hover)]" onclick={() => toggleExpand(run.runId)}>
								<td class="w-8 text-center">
									<span class="inline-block transition-transform {expandedRun === run.runId ? 'rotate-90' : ''}">&rsaquo;</span>
								</td>
								<td class="font-mono text-[var(--color-tron-cyan)]">{run.runId}</td>
								<td class="font-mono text-xs">{run.robotId}</td>
								<td>{run.operatorName}</td>
								<td><span class={runStatusBadge(run.status)}>{run.status}</span></td>
								<td class="text-xs text-[var(--color-tron-text-secondary)]">{run.waxSourceLot ?? '-'}</td>
								<td class="font-mono text-xs">{run.waxTubeId ?? '-'}</td>
								<td>{run.plannedCartridgeCount}</td>
								<td class="text-xs">{run.durationMinutes != null ? `${run.durationMinutes}m` : '-'}</td>
								<td class="font-mono text-xs">{run.coolingTrayId ?? '-'}</td>
								<td class="text-xs text-[var(--color-tron-text-secondary)]">{new Date(run.createdAt).toLocaleDateString()}</td>
							</tr>
							{#if run.abortReason && expandedRun === run.runId}
								<tr>
									<td></td>
									<td colspan="10" class="text-xs text-red-400">Abort reason: {run.abortReason}</td>
								</tr>
							{/if}
							{#if expandedRun === run.runId && data.cartridgesByRun[run.runId]?.length}
								<tr>
									<td></td>
									<td colspan="10">
										<div class="my-2 rounded border border-[var(--color-tron-border)]/50 bg-[var(--color-tron-bg-tertiary)] p-3">
											<p class="mb-2 text-xs font-medium text-[var(--color-tron-text-secondary)]">Cartridges ({data.cartridgesByRun[run.runId].length})</p>
											<table class="w-full text-xs">
												<thead>
													<tr class="text-[var(--color-tron-text-secondary)]">
														<th class="pb-1 text-left">Cartridge ID</th>
														<th class="pb-1 text-left">Position</th>
														<th class="pb-1 text-left">QC Status</th>
														<th class="pb-1 text-left">Rejection Reason</th>
														<th class="pb-1 text-left">Transfer Time</th>
														<th class="pb-1 text-left">Inventory</th>
													</tr>
												</thead>
												<tbody>
													{#each data.cartridgesByRun[run.runId] as cart (cart.cartridgeId)}
														<tr>
															<td class="font-mono text-[var(--color-tron-cyan)]">{cart.cartridgeId}</td>
															<td>{cart.deckPosition ?? '-'}</td>
															<td><span class={qcBadgeClass(cart.qcStatus)}>{cart.qcStatus}</span></td>
															<td class="text-[var(--color-tron-text-secondary)]">{cart.rejectionReason ?? '-'}</td>
															<td>{cart.transferTimeSeconds != null ? `${cart.transferTimeSeconds}s` : '-'}</td>
															<td class="text-[var(--color-tron-text-secondary)]">{cart.currentInventory}</td>
														</tr>
													{/each}
												</tbody>
											</table>
										</div>
									</td>
								</tr>
							{/if}
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

	<!-- Heating history -->
	{#if data.heatingHistory.length > 0}
		<section>
			<h2 class="mb-3 text-lg font-medium text-[var(--color-tron-cyan)]">Heating History</h2>
			<div class="space-y-2">
				{#each data.heatingHistory as event (event.id)}
					<div class="flex items-center justify-between rounded border border-[var(--color-tron-border)]/50 bg-[var(--color-tron-surface)] px-4 py-2 text-sm">
						<div class="flex items-center gap-3">
							<span class="text-[var(--color-tron-text)]">{event.eventType}</span>
							{#if event.temperatureC != null}
								<span class="font-mono text-xs text-amber-400">{event.temperatureC}°C</span>
							{/if}
							{#if event.notes}
								<span class="text-xs text-[var(--color-tron-text-secondary)]">{event.notes}</span>
							{/if}
						</div>
						<span class="text-xs text-[var(--color-tron-text-secondary)]">{new Date(event.createdAt).toLocaleString()}</span>
					</div>
				{/each}
			</div>
		</section>
	{/if}
</div>
