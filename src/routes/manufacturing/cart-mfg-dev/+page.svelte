<script lang="ts">
	let { data } = $props();

	let expandedCard = $state<string | null>(null);
	let dismissedAlerts = $state<Set<number>>(new Set());

	function toggleCard(id: string) {
		expandedCard = expandedCard === id ? null : id;
	}

	function handleKeydown(e: KeyboardEvent, id: string) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			toggleCard(id);
		}
	}

	function robotStatusBorder(status: string): string {
		if (status.startsWith('running')) return 'border-tron-yellow';
		if (status === 'available') return 'border-tron-green';
		if (status.startsWith('deck_free')) return 'border-tron-cyan';
		if (status.startsWith('blocked')) return 'border-tron-red';
		return 'border-tron-border';
	}

	function robotStatusBadge(status: string): string {
		if (status.startsWith('running')) return 'tron-badge-warning';
		if (status === 'available') return 'tron-badge-success';
		if (status.startsWith('deck_free')) return 'tron-badge-info';
		if (status.startsWith('blocked')) return 'tron-badge-error';
		return 'tron-badge-neutral';
	}

	function alertBorderColor(level: string): string {
		if (level === 'red') return 'border-tron-red';
		if (level === 'orange') return 'border-tron-orange';
		return 'border-tron-yellow';
	}

	function alertTextColor(level: string): string {
		if (level === 'red') return 'text-tron-red';
		if (level === 'orange') return 'text-tron-orange';
		return 'text-tron-yellow';
	}

	// Derive active operators from robot data
	const activeOperators = $derived(() => {
		const ops = new Set<string>();
		for (const r of data.robots ?? []) {
			if (r.activeWaxRun?.operatorUsername) ops.add(r.activeWaxRun.operatorUsername);
			if (r.activeReagentRun?.operatorUsername) ops.add(r.activeReagentRun.operatorUsername);
		}
		return ops;
	});

	// Pipeline stage data for flow visualization
	const pipelineStages = $derived(() => [
		{ label: 'Backing', count: data.pipeline.backing.backedTotal, sub: `${data.pipeline.backing.totalReadyCartridges} ready`, color: 'tron-purple' },
		{ label: 'Wax Fill', count: data.pipeline.waxFilling.inProgress + data.pipeline.waxFilling.waxFilled, sub: `${data.pipeline.waxFilling.inProgress} filling`, color: 'tron-yellow' },
		{ label: 'Cooling', count: data.pipeline.waxFilling.waxStored, sub: 'in fridge', color: 'tron-blue' },
		{ label: 'Reagent', count: data.pipeline.reagentFilling.inProgress + data.pipeline.reagentFilling.reagentFilled, sub: `${data.pipeline.reagentFilling.inProgress} filling`, color: 'tron-orange' },
		{ label: 'Seal', count: data.pipeline.reagentFilling.sealed, sub: 'sealed', color: 'tron-cyan' },
		{ label: 'QC', count: data.pipeline.reagentFilling.reagentFilled, sub: 'pending', color: 'tron-green' },
		{ label: 'Store', count: data.pipeline.storage.stored, sub: `${data.pipeline.storage.voided} voided`, color: 'tron-green' },
	]);
</script>

<div class="min-h-screen tron-grid-bg p-4 lg:p-6">
	<!-- Header -->
	<div class="mb-6 flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold text-tron-cyan tracking-wide">CART MFG MASTER VIEW</h1>
			<p class="text-sm text-tron-text-secondary">Manufacturing Line Dashboard</p>
		</div>
		<a href="/manufacturing/cart-mfg-dev" class="tron-btn-secondary text-sm">&#8635; Refresh</a>
	</div>

	<!-- ============ SHIFT SUMMARY STATS ============ -->
	<div class="grid grid-cols-2 gap-3 mb-6 lg:grid-cols-5">
		<div class="tron-card text-center">
			<div class="text-xs font-medium text-tron-text-secondary uppercase tracking-wide">Started Today</div>
			<div class="mt-1 text-2xl font-bold text-tron-cyan">{data.todayStats.waxRuns.completed + data.todayStats.waxRuns.inProgress + data.todayStats.waxRuns.aborted + data.todayStats.reagentRuns.completed + data.todayStats.reagentRuns.inProgress + data.todayStats.reagentRuns.aborted}</div>
			<div class="text-xs text-tron-text-secondary">runs</div>
		</div>
		<div class="tron-card text-center">
			<div class="text-xs font-medium text-tron-text-secondary uppercase tracking-wide">Completed</div>
			<div class="mt-1 text-2xl font-bold text-tron-green">{data.todayStats.producedToday}</div>
			<div class="text-xs text-tron-text-secondary">cartridges</div>
		</div>
		<div class="tron-card text-center">
			<div class="text-xs font-medium text-tron-text-secondary uppercase tracking-wide">Failed</div>
			<div class="mt-1 text-2xl font-bold text-tron-red">{data.todayStats.rejectedToday}</div>
			<div class="text-xs text-tron-text-secondary">rejected</div>
		</div>
		<div class="tron-card text-center">
			<div class="text-xs font-medium text-tron-text-secondary uppercase tracking-wide">Yield</div>
			<div class="mt-1 text-2xl font-bold" class:text-tron-green={data.todayStats.yieldPercent >= 90} class:text-tron-yellow={data.todayStats.yieldPercent >= 70 && data.todayStats.yieldPercent < 90} class:text-tron-red={data.todayStats.yieldPercent < 70}>{data.todayStats.yieldPercent}%</div>
			<div class="text-xs text-tron-text-secondary">{data.todayStats.acceptedToday}/{data.todayStats.producedToday}</div>
		</div>
		<div class="tron-card text-center">
			<div class="text-xs font-medium text-tron-text-secondary uppercase tracking-wide">Operators</div>
			<div class="mt-1 text-2xl font-bold text-tron-purple">{activeOperators().size}</div>
			<div class="text-xs text-tron-text-secondary">active</div>
		</div>
	</div>

	<!-- ============ ALERTS ============ -->
	{#if data.alerts?.length}
		<div class="mb-6 space-y-2">
			{#each data.alerts as alert, i}
				{#if !dismissedAlerts.has(i)}
					<div class="flex items-center justify-between rounded-lg border-l-4 px-4 py-2 bg-tron-bg-card {alertBorderColor(alert.level)}">
						<span class="text-sm font-medium {alertTextColor(alert.level)}">{alert.message}</span>
						<button class="ml-4 text-xs text-tron-text-secondary opacity-60 hover:opacity-100" onclick={() => { dismissedAlerts = new Set([...dismissedAlerts, i]); }}>&#10005;</button>
					</div>
				{/if}
			{/each}
		</div>
	{/if}

	<!-- ============ PIPELINE FLOW VISUALIZATION ============ -->
	<div class="tron-card mb-6">
		<h2 class="mb-4 text-xs font-semibold uppercase tracking-widest text-tron-cyan">Pipeline Flow</h2>
		<div class="flex items-stretch gap-1 overflow-x-auto">
			{#each pipelineStages() as stage, i}
				<div class="flex-1 min-w-[100px] text-center">
					<div class="rounded-lg bg-tron-bg-tertiary border border-tron-border p-3 h-full flex flex-col justify-center">
						<div class="text-xs font-semibold uppercase tracking-wide text-tron-text-secondary">{stage.label}</div>
						<div class="mt-1 text-xl font-bold text-{stage.color}">{stage.count}</div>
						<div class="text-xs text-tron-text-secondary">{stage.sub}</div>
					</div>
					{#if i < pipelineStages().length - 1}
						<div class="hidden"></div>
					{/if}
				</div>
				{#if i < pipelineStages().length - 1}
					<div class="flex items-center text-tron-cyan text-lg font-bold select-none">&#9654;</div>
				{/if}
			{/each}
		</div>
	</div>

	<!-- ============ ROBOT STATUS + MATERIALS GRID ============ -->
	<div class="grid grid-cols-1 gap-4 mb-6 lg:grid-cols-3">
		{#each data.robots as robot}
			<div class="tron-card border-l-4 {robotStatusBorder(robot.status)}">
				<div class="flex items-center justify-between mb-3">
					<h3 class="text-sm font-bold text-tron-text uppercase tracking-wide">{robot.name}</h3>
					<span class="tron-badge {robotStatusBadge(robot.status)}">{robot.displayStatus}</span>
				</div>

				<!-- Utilization bar -->
				<div class="mb-3">
					<div class="flex justify-between text-xs text-tron-text-secondary mb-1">
						<span>Utilization</span>
						<span>{robot.utilizationPct}% ({robot.utilizationHours}h)</span>
					</div>
					<div class="tron-progress">
						<div class="tron-progress-bar" style="width: {robot.utilizationPct}%"></div>
					</div>
				</div>

				{#if robot.activeWaxRun}
					<div class="space-y-1 text-xs text-tron-text-secondary">
						<div class="flex justify-between"><span class="text-tron-text-secondary">Run</span><span class="text-tron-text">Wax Fill &middot; {robot.activeWaxRun.stage}</span></div>
						<div class="flex justify-between"><span class="text-tron-text-secondary">Operator</span><span class="text-tron-text">{robot.activeWaxRun.operatorUsername ?? 'Unknown'}</span></div>
						<div class="flex justify-between"><span class="text-tron-text-secondary">Elapsed</span><span class="text-tron-text">{robot.activeWaxRun.elapsedMin} min</span></div>
						<div class="flex justify-between"><span class="text-tron-text-secondary">Cartridges</span><span class="text-tron-text">{robot.activeWaxRun.cartridgeCount}</span></div>
						{#if robot.activeWaxRun.waxSourceLot}
							<div class="flex justify-between"><span class="text-tron-text-secondary">Wax Lot</span><span class="text-tron-text">{robot.activeWaxRun.waxSourceLot}</span></div>
						{/if}
					</div>
					<a href="/manufacturing/wax-filling?robot={robot.robotId}" class="mt-3 block text-xs text-tron-cyan hover:underline">&rarr; Go to Wax Filling</a>
				{:else if robot.activeReagentRun}
					<div class="space-y-1 text-xs text-tron-text-secondary">
						<div class="flex justify-between"><span class="text-tron-text-secondary">Run</span><span class="text-tron-text">Reagent &middot; {robot.activeReagentRun.stage}</span></div>
						<div class="flex justify-between"><span class="text-tron-text-secondary">Operator</span><span class="text-tron-text">{robot.activeReagentRun.operatorUsername ?? 'Unknown'}</span></div>
						<div class="flex justify-between"><span class="text-tron-text-secondary">Elapsed</span><span class="text-tron-text">{robot.activeReagentRun.elapsedMin} min</span></div>
						<div class="flex justify-between"><span class="text-tron-text-secondary">Assay</span><span class="text-tron-text">{robot.activeReagentRun.assayTypeName ?? 'N/A'}</span></div>
						<div class="flex justify-between"><span class="text-tron-text-secondary">Cartridges</span><span class="text-tron-text">{robot.activeReagentRun.cartridgeCount}</span></div>
					</div>
					<a href="/manufacturing/reagent-filling?robot={robot.robotId}" class="mt-3 block text-xs text-tron-cyan hover:underline">&rarr; Go to Reagent Filling</a>
				{:else}
					<div class="text-xs text-tron-text-secondary mb-2">No active run</div>
					<div class="flex gap-3">
						<a href="/manufacturing/wax-filling?robot={robot.robotId}" class="text-xs text-tron-cyan hover:underline">&#9654; Start Wax</a>
						<a href="/manufacturing/reagent-filling?robot={robot.robotId}" class="text-xs text-tron-cyan hover:underline">&#9654; Start Reagent</a>
					</div>
				{/if}

				{#if robot.isStalled}
					<div class="mt-3 rounded-lg bg-tron-red/10 border border-tron-red/30 px-3 py-2 text-xs font-medium text-tron-red">
						Run may be stalled &mdash; last update {robot.minutesSinceUpdate} min ago
					</div>
				{/if}
			</div>
		{/each}
	</div>

	<!-- ============ MATERIALS & OPERATOR ROW ============ -->
	<div class="grid grid-cols-1 gap-4 mb-6 lg:grid-cols-2">

		<!-- Pre-Robot Materials -->
		<div class="tron-card">
			<h2 class="mb-4 text-xs font-semibold uppercase tracking-widest text-tron-cyan">Materials &amp; Inputs</h2>
			<div class="grid grid-cols-2 gap-3">
				<!-- Barcodes -->
				<div class="tron-card-interactive" role="button" tabindex="0"
					onclick={() => toggleCard('barcodes')} onkeydown={(e) => handleKeydown(e, 'barcodes')}>
					<div class="flex items-center justify-between">
						<span class="text-xs font-semibold uppercase text-tron-text-secondary">Barcodes</span>
						{#if data.pipeline.printBarcodes.sheetsOnHand < data.pipeline.printBarcodes.alertThreshold}
							<span class="tron-badge tron-badge-warning">Low</span>
						{/if}
					</div>
					<div class="mt-1 text-lg font-bold text-tron-text">{data.pipeline.printBarcodes.sheetsOnHand} <span class="text-xs font-normal text-tron-text-secondary">sheets</span></div>
					<div class="text-xs text-tron-text-secondary">{data.pipeline.printBarcodes.labelsAvailable} labels</div>
					<!-- Print Barcodes link — route not yet built -->
								<span class="mt-2 block text-xs text-tron-text-secondary opacity-50">Print (coming soon)</span>
					{#if expandedCard === 'barcodes'}
						<div class="mt-3 border-t border-tron-border pt-3">
							<div class="text-xs text-tron-text-secondary mb-1">Recent Batches</div>
							{#each data.pipeline.printBarcodes.recentBatches ?? [] as batch}
								<div class="flex justify-between text-xs text-tron-text-secondary mb-1">
									<span>{new Date(batch.printedAt).toLocaleDateString()} &middot; {batch.printedBy?.username ?? '?'}</span>
									<span>{batch.sheetsUsed} sheets</span>
								</div>
							{:else}
								<div class="text-xs text-tron-text-secondary">None</div>
							{/each}
						</div>
					{/if}
				</div>

				<!-- Top Seal -->
				<div class="tron-card-interactive" role="button" tabindex="0"
					onclick={() => toggleCard('topseal')} onkeydown={(e) => handleKeydown(e, 'topseal')}>
					<div class="flex items-center justify-between">
						<span class="text-xs font-semibold uppercase text-tron-text-secondary">Top Seal</span>
						{#if data.pipeline.topSeal.rollCount === 0}
							<span class="tron-badge tron-badge-warning">None</span>
						{/if}
					</div>
					<div class="mt-1 text-lg font-bold text-tron-text">{data.pipeline.topSeal.rollCount} <span class="text-xs font-normal text-tron-text-secondary">rolls</span></div>
					<div class="text-xs text-tron-text-secondary">~{data.pipeline.topSeal.stripsAvailableApprox} strips</div>
					<a href="/manufacturing/top-seal-cutting" class="mt-2 block text-xs text-tron-cyan hover:underline" onclick={(e) => e.stopPropagation()}>&rarr; Cutting</a>
					{#if expandedCard === 'topseal'}
						<div class="mt-3 border-t border-tron-border pt-3">
							{#each data.pipeline.topSeal.activeRolls ?? [] as roll}
								<div class="flex justify-between text-xs text-tron-text-secondary mb-1">
									<span>{roll.barcode ?? roll._id}</span>
									<span>{roll.remainingLengthFt ?? 0} ft</span>
								</div>
							{:else}
								<div class="text-xs text-tron-text-secondary">No active rolls</div>
							{/each}
						</div>
					{/if}
				</div>

				<!-- Laser Cut -->
				<div class="tron-card-interactive" role="button" tabindex="0"
					onclick={() => toggleCard('lasercut')} onkeydown={(e) => handleKeydown(e, 'lasercut')}>
					<span class="text-xs font-semibold uppercase text-tron-text-secondary">Laser Cut</span>
					<div class="mt-1 text-lg font-bold text-tron-text">{data.pipeline.laserCut.sheetsOnHand} <span class="text-xs font-normal text-tron-text-secondary">sheets</span></div>
					<div class="text-xs text-tron-text-secondary">{data.pipeline.laserCut.individualBacks} backs</div>
					<a href="/manufacturing/laser-cutting" class="mt-2 block text-xs text-tron-cyan hover:underline" onclick={(e) => e.stopPropagation()}>&rarr; Laser Cut</a>
					{#if expandedCard === 'lasercut'}
						<div class="mt-3 border-t border-tron-border pt-3 text-xs text-tron-text-secondary">
							{data.pipeline.laserCut.sheetsOnHand} &times; {data.pipeline.laserCut.cartridgesPerSheet} = {data.pipeline.laserCut.individualBacks}
							{#if data.pipeline.laserCut.recentBatchAt}
								<div class="mt-1">Last batch: {new Date(data.pipeline.laserCut.recentBatchAt).toLocaleString()}</div>
							{/if}
						</div>
					{/if}
				</div>

				<!-- Backing -->
				<div class="tron-card-interactive" role="button" tabindex="0"
					onclick={() => toggleCard('backing')} onkeydown={(e) => handleKeydown(e, 'backing')}>
					<div class="flex items-center justify-between">
						<span class="text-xs font-semibold uppercase text-tron-text-secondary">Backing</span>
						{#if data.pipeline.backing.readyLots?.length}
							<span class="tron-badge tron-badge-success">{data.pipeline.backing.readyLots.length} ready</span>
						{/if}
					</div>
					<div class="mt-1 text-lg font-bold text-tron-text">{data.pipeline.backing.backedTotal} <span class="text-xs font-normal text-tron-text-secondary">backed</span></div>
					<div class="text-xs text-tron-text-secondary">{data.pipeline.backing.totalReadyCartridges} ready &middot; {data.pipeline.backing.inProgressLots?.length ?? 0} in oven</div>
					<a href="/manufacturing/wi-01" class="mt-2 block text-xs text-tron-cyan hover:underline" onclick={(e) => e.stopPropagation()}>&rarr; WI-01</a>
					{#if expandedCard === 'backing'}
						<div class="mt-3 border-t border-tron-border pt-3">
							{#each [...(data.pipeline.backing.readyLots ?? []), ...(data.pipeline.backing.inProgressLots ?? [])] as lot}
								<div class="flex justify-between text-xs text-tron-text-secondary mb-1">
									<span>{lot.lotId} &middot; {lot.cartridgeCount}</span>
									<span class={lot.isReady ? 'text-tron-green font-medium' : 'text-tron-yellow'}>
										{#if lot.isReady}Ready{:else}{lot.remainingMin}m{/if}
									</span>
								</div>
							{:else}
								<div class="text-xs text-tron-text-secondary">No lots</div>
							{/each}
						</div>
					{/if}
				</div>
			</div>
		</div>

		<!-- Operator Activity + Output -->
		<div class="space-y-4">
			<!-- Operator Activity -->
			<div class="tron-card">
				<h2 class="mb-3 text-xs font-semibold uppercase tracking-widest text-tron-cyan">Operator Activity</h2>
				{#if activeOperators().size > 0}
					<div class="space-y-2">
						{#each data.robots as robot}
							{#if robot.activeWaxRun?.operatorUsername}
								<div class="flex items-center justify-between text-sm">
									<span class="text-tron-text font-medium">{robot.activeWaxRun.operatorUsername}</span>
									<span class="text-xs text-tron-text-secondary">Wax Fill on {robot.name} &middot; {robot.activeWaxRun.elapsedMin}m</span>
								</div>
							{/if}
							{#if robot.activeReagentRun?.operatorUsername}
								<div class="flex items-center justify-between text-sm">
									<span class="text-tron-text font-medium">{robot.activeReagentRun.operatorUsername}</span>
									<span class="text-xs text-tron-text-secondary">Reagent on {robot.name} &middot; {robot.activeReagentRun.elapsedMin}m</span>
								</div>
							{/if}
						{/each}
					</div>
				{:else}
					<div class="text-sm text-tron-text-secondary">No active operators</div>
				{/if}
			</div>

			<!-- Post-Robot Output -->
			<div class="tron-card">
				<h2 class="mb-3 text-xs font-semibold uppercase tracking-widest text-tron-cyan">Output &amp; Shipping</h2>
				<div class="grid grid-cols-3 gap-3 text-center">
					<div>
						<div class="text-lg font-bold text-tron-green">{data.pipeline.storage.stored}</div>
						<div class="text-xs text-tron-text-secondary">Stored</div>
					</div>
					<div>
						<div class="text-lg font-bold text-tron-cyan">{data.pipeline.shipped.thisWeek}</div>
						<div class="text-xs text-tron-text-secondary">Shipped (wk)</div>
					</div>
					<div>
						<div class="text-lg font-bold text-tron-blue">{data.pipeline.shipped.thisMonth}</div>
						<div class="text-xs text-tron-text-secondary">Shipped (mo)</div>
					</div>
				</div>
				{#if data.pipeline.shipped.recentShipment}
					<div class="mt-3 border-t border-tron-border pt-3 text-xs text-tron-text-secondary">
						Last shipment: {new Date(data.pipeline.shipped.recentShipment.date).toLocaleDateString()} &rarr; {data.pipeline.shipped.recentShipment.destination} ({data.pipeline.shipped.recentShipment.count} units)
					</div>
				{/if}
			</div>
		</div>
	</div>

	<!-- ============ WEEKLY STATS / HISTORICAL ============ -->
	<div class="tron-card">
		<h2 class="mb-3 text-xs font-semibold uppercase tracking-widest text-tron-cyan">This Week</h2>
		<div class="grid grid-cols-2 gap-4 lg:grid-cols-5 text-center">
			<div>
				<div class="text-lg font-bold text-tron-text">{data.weeklyStats.waxRuns}</div>
				<div class="text-xs text-tron-text-secondary">Wax Runs</div>
			</div>
			<div>
				<div class="text-lg font-bold text-tron-text">{data.weeklyStats.reagentRuns}</div>
				<div class="text-xs text-tron-text-secondary">Reagent Runs</div>
			</div>
			<div>
				<div class="text-lg font-bold text-tron-green">{data.weeklyStats.produced}</div>
				<div class="text-xs text-tron-text-secondary">Produced</div>
			</div>
			<div>
				<div class="text-lg font-bold text-tron-red">{data.weeklyStats.rejected}</div>
				<div class="text-xs text-tron-text-secondary">Rejected</div>
			</div>
			<div>
				<div class="text-lg font-bold" class:text-tron-green={data.weeklyStats.yieldPercent >= 90} class:text-tron-yellow={data.weeklyStats.yieldPercent >= 70 && data.weeklyStats.yieldPercent < 90} class:text-tron-red={data.weeklyStats.yieldPercent < 70}>{data.weeklyStats.yieldPercent}%</div>
				<div class="text-xs text-tron-text-secondary">Yield</div>
			</div>
		</div>
		{#if data.weeklyStats.topRejections?.length}
			<div class="mt-4 border-t border-tron-border pt-3">
				<div class="text-xs text-tron-text-secondary">
					Top rejections: {#each data.weeklyStats.topRejections as reason, i}{#if i > 0} &middot; {/if}<span class="text-tron-text">{reason._id ?? 'Unknown'}</span> ({reason.count}){/each}
				</div>
			</div>
		{/if}
		<!-- Historical chart placeholder -->
		<div class="mt-4 rounded-lg bg-tron-bg-tertiary border border-tron-border h-32 flex items-center justify-center">
			<span class="text-xs text-tron-text-secondary uppercase tracking-wide">Historical trend chart &mdash; coming soon</span>
		</div>
	</div>
</div>
