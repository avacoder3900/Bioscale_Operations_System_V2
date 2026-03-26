<script lang="ts">
	let { data } = $props();

	let expandedCard = $state<string | null>(null);

	function toggleCard(id: string) {
		expandedCard = expandedCard === id ? null : id;
	}

	function handleKeydown(e: KeyboardEvent, id: string) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			toggleCard(id);
		}
	}

	function statusColor(status: string): string {
		if (status.startsWith('running')) return 'bg-amber-50 border-amber-300';
		if (status === 'available') return 'bg-green-50 border-green-300';
		if (status.startsWith('deck_free')) return 'bg-blue-50 border-blue-300';
		if (status.startsWith('blocked')) return 'bg-red-50 border-red-300';
		return 'bg-gray-50 border-gray-200';
	}

	function statusIcon(status: string): string {
		if (status.startsWith('running')) return '🟡';
		if (status === 'available') return '✅';
		if (status.startsWith('deck_free')) return '🔵';
		if (status.startsWith('blocked')) return '🔴';
		return '⚪';
	}

	function alertColor(level: string): string {
		if (level === 'red') return 'bg-red-100 border-red-400 text-red-800';
		if (level === 'orange') return 'bg-orange-100 border-orange-400 text-orange-800';
		return 'bg-yellow-100 border-yellow-400 text-yellow-800';
	}

	let dismissedAlerts = $state<Set<number>>(new Set());
</script>

<div class="min-h-screen bg-gray-100 p-4 lg:p-6">
	<!-- Header -->
	<div class="mb-4 flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold text-gray-900">CART MFG In DEVELOPMENT</h1>
			<p class="text-sm text-gray-500">Manufacturing Line Master View</p>
		</div>
		<a href="/manufacturing/cart-mfg-dev" class="rounded bg-gray-200 px-3 py-1.5 text-sm hover:bg-gray-300">↺ Refresh</a>
	</div>

	<!-- Alerts -->
	{#if data.alerts?.length}
		<div class="mb-4 space-y-2">
			{#each data.alerts as alert, i}
				{#if !dismissedAlerts.has(i)}
					<div class="flex items-center justify-between rounded border-l-4 px-4 py-2 {alertColor(alert.level)}">
						<span class="text-sm font-medium">{alert.message}</span>
						<button class="ml-4 text-xs opacity-60 hover:opacity-100" onclick={() => { dismissedAlerts = new Set([...dismissedAlerts, i]); }}>✕</button>
					</div>
				{/if}
			{/each}
		</div>
	{/if}

	<!-- Today's Stats -->
	<div class="mb-6 rounded-lg border bg-white p-4 shadow-sm">
		<h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">Today's Production</h2>
		<div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
			<div class="rounded-lg bg-blue-50 p-3">
				<div class="text-xs font-medium text-blue-600">WAX RUNS</div>
				<div class="mt-1 text-xl font-bold text-blue-900">{data.todayStats.waxRuns.completed} <span class="text-sm font-normal">done</span></div>
				<div class="text-xs text-blue-700">{data.todayStats.waxRuns.inProgress} active · {data.todayStats.waxRuns.aborted} aborted</div>
			</div>
			<div class="rounded-lg bg-purple-50 p-3">
				<div class="text-xs font-medium text-purple-600">REAGENT RUNS</div>
				<div class="mt-1 text-xl font-bold text-purple-900">{data.todayStats.reagentRuns.completed} <span class="text-sm font-normal">done</span></div>
				<div class="text-xs text-purple-700">{data.todayStats.reagentRuns.inProgress} active · {data.todayStats.reagentRuns.aborted} aborted</div>
			</div>
			<div class="rounded-lg bg-green-50 p-3">
				<div class="text-xs font-medium text-green-600">CARTRIDGES</div>
				<div class="mt-1 text-xl font-bold text-green-900">{data.todayStats.producedToday} <span class="text-sm font-normal">produced</span></div>
				<div class="text-xs text-green-700">{data.todayStats.acceptedToday} accepted · {data.todayStats.rejectedToday} rejected</div>
			</div>
			<div class="rounded-lg bg-amber-50 p-3">
				<div class="text-xs font-medium text-amber-600">YIELD RATE</div>
				<div class="mt-1 text-xl font-bold text-amber-900">{data.todayStats.yieldPercent}%</div>
				<div class="text-xs text-amber-700">({data.todayStats.acceptedToday}/{data.todayStats.producedToday})</div>
			</div>
		</div>

		<!-- Robot utilization -->
		{#if data.robots?.length}
			<div class="mt-4">
				<div class="text-xs font-medium uppercase text-gray-500 mb-2">Robot Utilization Today</div>
				{#each data.robots as robot}
					<div class="flex items-center gap-2 mb-1">
						<span class="w-24 text-xs text-gray-600 truncate">{robot.name}</span>
						<div class="flex-1 h-3 bg-gray-200 rounded-full overflow-hidden">
							<div class="h-full bg-blue-500 rounded-full" style="width: {robot.utilizationPct}%"></div>
						</div>
						<span class="w-16 text-xs text-gray-600 text-right">{robot.utilizationPct}% ({robot.utilizationHours}h)</span>
					</div>
				{/each}
			</div>
		{/if}
	</div>

	<!-- Three-Column Pipeline Layout -->
	<div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
		<!-- LEFT COLUMN: Pre-Robot Stages -->
		<div class="space-y-3">
			<h3 class="text-xs font-semibold uppercase tracking-wider text-gray-400">Pre-Robot Inputs</h3>

			<!-- Print Barcodes -->
			<div class="cursor-pointer rounded-lg border-2 p-4 transition-all {data.pipeline.printBarcodes.sheetsOnHand < data.pipeline.printBarcodes.alertThreshold ? 'bg-orange-50 border-orange-300' : 'bg-white border-gray-200'}"
				role="button" tabindex="0"
				onclick={() => toggleCard('barcodes')}
				onkeydown={(e) => handleKeydown(e, 'barcodes')}>
				<div class="flex items-center justify-between">
					<h4 class="text-sm font-semibold uppercase tracking-wide">Print Barcodes</h4>
					<span class="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium">{data.pipeline.printBarcodes.sheetsOnHand} sheets</span>
				</div>
				<div class="mt-1 text-sm text-gray-600">{data.pipeline.printBarcodes.labelsAvailable} labels available</div>
				{#if data.pipeline.printBarcodes.sheetsOnHand < data.pipeline.printBarcodes.alertThreshold}
					<div class="mt-1 text-xs font-medium text-orange-600">⚠ Low stock</div>
				{/if}
				<a href="/manufacturing/print-barcodes" class="mt-2 block text-xs text-blue-600 hover:underline" onclick={(e) => e.stopPropagation()}>→ Print Barcodes</a>

				{#if expandedCard === 'barcodes'}
					<div class="mt-3 border-t border-gray-200 pt-3">
						<div class="text-xs font-medium text-gray-500 mb-2">Recent Print Batches</div>
						{#if data.pipeline.printBarcodes.recentBatches?.length}
							{#each data.pipeline.printBarcodes.recentBatches as batch}
								<div class="flex justify-between text-xs text-gray-600 mb-1">
									<span>{new Date(batch.printedAt).toLocaleDateString()} · {batch.printedBy?.username ?? '?'}</span>
									<span>{batch.sheetsUsed} sheets · {batch.totalLabels} labels</span>
								</div>
							{/each}
						{:else}
							<div class="text-xs text-gray-400">No recent batches</div>
						{/if}
					</div>
				{/if}
			</div>

			<!-- Cut Top Seal -->
			<div class="cursor-pointer rounded-lg border-2 p-4 transition-all {data.pipeline.topSeal.rollCount === 0 ? 'bg-orange-50 border-orange-300' : 'bg-white border-gray-200'}"
				role="button" tabindex="0"
				onclick={() => toggleCard('topseal')}
				onkeydown={(e) => handleKeydown(e, 'topseal')}>
				<div class="flex items-center justify-between">
					<h4 class="text-sm font-semibold uppercase tracking-wide">Cut Top Seal</h4>
					<span class="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium">{data.pipeline.topSeal.rollCount} rolls</span>
				</div>
				<div class="mt-1 text-sm text-gray-600">~{data.pipeline.topSeal.stripsAvailableApprox} strips available</div>
				{#if data.pipeline.topSeal.rollCount === 0}
					<div class="mt-1 text-xs font-medium text-orange-600">⚠ No active rolls</div>
				{/if}
				<a href="/manufacturing/top-seal-cutting" class="mt-2 block text-xs text-blue-600 hover:underline" onclick={(e) => e.stopPropagation()}>→ Top Seal Cutting</a>

				{#if expandedCard === 'topseal'}
					<div class="mt-3 border-t border-gray-200 pt-3">
						<div class="text-xs font-medium text-gray-500 mb-2">Active Rolls</div>
						{#if data.pipeline.topSeal.activeRolls?.length}
							{#each data.pipeline.topSeal.activeRolls as roll}
								<div class="flex justify-between text-xs text-gray-600 mb-1">
									<span>{roll.barcode ?? roll._id}</span>
									<span>{roll.remainingLengthFt ?? 0} ft remaining</span>
								</div>
							{/each}
						{:else}
							<div class="text-xs text-gray-400">No active rolls</div>
						{/if}
					</div>
				{/if}
			</div>

			<!-- Laser Cut -->
			<div class="cursor-pointer rounded-lg border-2 bg-white border-gray-200 p-4 transition-all"
				role="button" tabindex="0"
				onclick={() => toggleCard('lasercut')}
				onkeydown={(e) => handleKeydown(e, 'lasercut')}>
				<div class="flex items-center justify-between">
					<h4 class="text-sm font-semibold uppercase tracking-wide">Laser Cut</h4>
					<span class="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium">{data.pipeline.laserCut.sheetsOnHand} sheets</span>
				</div>
				<div class="mt-1 text-sm text-gray-600">{data.pipeline.laserCut.individualBacks} individual backs</div>
				<a href="/manufacturing/laser-cutting" class="mt-2 block text-xs text-blue-600 hover:underline" onclick={(e) => e.stopPropagation()}>→ Laser Cutting</a>

				{#if expandedCard === 'lasercut'}
					<div class="mt-3 border-t border-gray-200 pt-3">
						<div class="text-xs text-gray-600">
							<div>{data.pipeline.laserCut.sheetsOnHand} sheets × {data.pipeline.laserCut.cartridgesPerSheet} = {data.pipeline.laserCut.individualBacks} individual backs</div>
							{#if data.pipeline.laserCut.recentBatchAt}
								<div class="mt-1">Last batch: {new Date(data.pipeline.laserCut.recentBatchAt).toLocaleString()}</div>
							{/if}
						</div>
					</div>
				{/if}
			</div>

			<!-- WI-01 Backing -->
			<div class="cursor-pointer rounded-lg border-2 p-4 transition-all {data.pipeline.backing.readyLots?.length ? 'bg-green-50 border-green-300' : 'bg-white border-gray-200'}"
				role="button" tabindex="0"
				onclick={() => toggleCard('backing')}
				onkeydown={(e) => handleKeydown(e, 'backing')}>
				<div class="flex items-center justify-between">
					<h4 class="text-sm font-semibold uppercase tracking-wide">WI-01 Backing</h4>
					<span class="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium">{data.pipeline.backing.backedTotal} backed</span>
				</div>
				<div class="mt-1 text-sm text-gray-600">
					{data.pipeline.backing.totalReadyCartridges} ready for wax · {data.pipeline.backing.inProgressLots?.length ?? 0} in oven
				</div>
				<a href="/manufacturing/wi-01" class="mt-2 block text-xs text-blue-600 hover:underline" onclick={(e) => e.stopPropagation()}>→ Backing WI-01</a>

				{#if expandedCard === 'backing'}
					<div class="mt-3 border-t border-gray-200 pt-3">
						<div class="text-xs font-medium text-gray-500 mb-2">Oven Status</div>
						{#each [...(data.pipeline.backing.readyLots ?? []), ...(data.pipeline.backing.inProgressLots ?? [])] as lot}
							<div class="flex justify-between text-xs text-gray-600 mb-1">
								<span>{lot.lotId} · {lot.cartridgeCount} carts{#if lot.operatorUsername} · {lot.operatorUsername}{/if}</span>
								<span class={lot.isReady ? 'text-green-600 font-medium' : 'text-amber-600'}>
									{#if lot.isReady}Ready{:else}{lot.remainingMin}m left{/if}
								</span>
							</div>
						{:else}
							<div class="text-xs text-gray-400">No lots in oven</div>
						{/each}
					</div>
				{/if}
			</div>
		</div>

		<!-- CENTER COLUMN: Robots -->
		<div class="space-y-3">
			<h3 class="text-xs font-semibold uppercase tracking-wider text-gray-400">Robot Axis</h3>

			{#each data.robots as robot}
				<div class="rounded-lg border-2 p-4 {statusColor(robot.status)}">
					<div class="flex items-center justify-between mb-2">
						<h4 class="font-semibold">🤖 {robot.name}</h4>
						<span class="text-sm">{statusIcon(robot.status)}</span>
					</div>
					<div class="text-sm font-medium mb-2">{robot.displayStatus}</div>

					{#if robot.activeWaxRun}
						<div class="space-y-1 text-xs text-gray-700">
							<div>Operator: {robot.activeWaxRun.operatorUsername ?? 'Unknown'}</div>
							<div>Stage: {robot.activeWaxRun.stage} · {robot.activeWaxRun.elapsedMin} min</div>
							<div>Cartridges: {robot.activeWaxRun.cartridgeCount}</div>
							{#if robot.activeWaxRun.waxSourceLot}
								<div>Wax lot: {robot.activeWaxRun.waxSourceLot}</div>
							{/if}
						</div>
						<a href="/manufacturing/wax-filling?robot={robot.robotId}" class="mt-2 block text-xs text-blue-600 hover:underline">→ Go to Wax Filling</a>
					{:else if robot.activeReagentRun}
						<div class="space-y-1 text-xs text-gray-700">
							<div>Operator: {robot.activeReagentRun.operatorUsername ?? 'Unknown'}</div>
							<div>Stage: {robot.activeReagentRun.stage} · {robot.activeReagentRun.elapsedMin} min</div>
							<div>Assay: {robot.activeReagentRun.assayTypeName ?? 'N/A'}</div>
							<div>Cartridges: {robot.activeReagentRun.cartridgeCount}</div>
						</div>
						<a href="/manufacturing/reagent-filling?robot={robot.robotId}" class="mt-2 block text-xs text-blue-600 hover:underline">→ Go to Reagent Filling</a>
					{:else}
						<div class="text-xs text-gray-500">No active run</div>
						<div class="mt-2 flex gap-2">
							<a href="/manufacturing/wax-filling?robot={robot.robotId}" class="text-xs text-blue-600 hover:underline">▶ Start Wax Run</a>
							<a href="/manufacturing/reagent-filling?robot={robot.robotId}" class="text-xs text-blue-600 hover:underline">▶ Start Reagent</a>
						</div>
					{/if}

					{#if robot.isStalled}
						<div class="mt-2 rounded bg-red-100 px-2 py-1 text-xs font-medium text-red-700">
							⚠ Run may be stalled — last update {robot.minutesSinceUpdate} min ago
						</div>
					{/if}
				</div>
			{/each}
		</div>

		<!-- RIGHT COLUMN: Post-Robot Stages -->
		<div class="space-y-3">
			<h3 class="text-xs font-semibold uppercase tracking-wider text-gray-400">Post-Robot Output</h3>

			<!-- Wax QC -->
			<div class="cursor-pointer rounded-lg border-2 bg-white border-gray-200 p-4 transition-all"
				role="button" tabindex="0"
				onclick={() => toggleCard('waxqc')}
				onkeydown={(e) => handleKeydown(e, 'waxqc')}>
				<div class="flex items-center justify-between">
					<h4 class="text-sm font-semibold uppercase tracking-wide">Wax QC</h4>
					<span class="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium">{data.pipeline.waxFilling.waxFilled} pending</span>
				</div>
				<div class="mt-1 text-sm text-gray-600">{data.pipeline.waxFilling.waxFilled} awaiting QC</div>
				<a href="/manufacturing/wax-filling" class="mt-2 block text-xs text-blue-600 hover:underline" onclick={(e) => e.stopPropagation()}>→ Wax Filling (QC)</a>

				{#if expandedCard === 'waxqc'}
					<div class="mt-3 border-t border-gray-200 pt-3 text-xs text-gray-600">
						<div>Pending QC: {data.pipeline.waxFilling.waxFilled}</div>
						<div>In progress (on deck): {data.pipeline.waxFilling.inProgress}</div>
					</div>
				{/if}
			</div>

			<!-- Fridge Storage -->
			<div class="cursor-pointer rounded-lg border-2 p-4 transition-all {data.pipeline.waxFilling.waxStored > 0 ? 'bg-blue-50 border-blue-200' : 'bg-white border-gray-200'}"
				role="button" tabindex="0"
				onclick={() => toggleCard('fridge')}
				onkeydown={(e) => handleKeydown(e, 'fridge')}>
				<div class="flex items-center justify-between">
					<h4 class="text-sm font-semibold uppercase tracking-wide">Fridge Storage</h4>
					<span class="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium">{data.pipeline.waxFilling.waxStored}</span>
				</div>
				<div class="mt-1 text-sm text-gray-600">{data.pipeline.waxFilling.waxStored} wax-stored in fridge</div>
				<a href="/manufacturing/wax-filling" class="mt-2 block text-xs text-blue-600 hover:underline" onclick={(e) => e.stopPropagation()}>→ Wax Filling (Storage)</a>

				{#if expandedCard === 'fridge'}
					<div class="mt-3 border-t border-gray-200 pt-3 text-xs text-gray-600">
						<div>Total in fridge: {data.pipeline.waxFilling.waxStored}</div>
						<div>Ready for reagent filling</div>
					</div>
				{/if}
			</div>

			<!-- Final QC -->
			<div class="cursor-pointer rounded-lg border-2 bg-white border-gray-200 p-4 transition-all"
				role="button" tabindex="0"
				onclick={() => toggleCard('finalqc')}
				onkeydown={(e) => handleKeydown(e, 'finalqc')}>
				<div class="flex items-center justify-between">
					<h4 class="text-sm font-semibold uppercase tracking-wide">Final QC</h4>
					<span class="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium">{data.pipeline.reagentFilling.reagentFilled} pending</span>
				</div>
				<div class="mt-1 text-sm text-gray-600">{data.pipeline.reagentFilling.reagentFilled} pending inspection</div>
				<a href="/manufacturing/reagent-filling" class="mt-2 block text-xs text-blue-600 hover:underline" onclick={(e) => e.stopPropagation()}>→ Reagent Filling (Inspection)</a>

				{#if expandedCard === 'finalqc'}
					<div class="mt-3 border-t border-gray-200 pt-3 text-xs text-gray-600">
						<div>Reagent filled: {data.pipeline.reagentFilling.reagentFilled}</div>
						<div>Sealed: {data.pipeline.reagentFilling.sealed}</div>
					</div>
				{/if}
			</div>

			<!-- Storage -->
			<div class="cursor-pointer rounded-lg border-2 p-4 transition-all {data.pipeline.storage.stored > 0 ? 'bg-green-50 border-green-200' : 'bg-white border-gray-200'}"
				role="button" tabindex="0"
				onclick={() => toggleCard('storage')}
				onkeydown={(e) => handleKeydown(e, 'storage')}>
				<div class="flex items-center justify-between">
					<h4 class="text-sm font-semibold uppercase tracking-wide">Storage</h4>
					<span class="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium">{data.pipeline.storage.stored} stored</span>
				</div>
				<div class="mt-1 text-sm text-gray-600">{data.pipeline.storage.stored} in final storage</div>
				<a href="/manufacturing/reagent-filling" class="mt-2 block text-xs text-blue-600 hover:underline" onclick={(e) => e.stopPropagation()}>→ Reagent Filling (Storage)</a>

				{#if expandedCard === 'storage'}
					<div class="mt-3 border-t border-gray-200 pt-3 text-xs text-gray-600">
						<div>Stored: {data.pipeline.storage.stored}</div>
						<div>Sealed (pending storage): {data.pipeline.reagentFilling.sealed}</div>
						<div>Voided: {data.pipeline.storage.voided}</div>
					</div>
				{/if}
			</div>

			<!-- Shipped -->
			<div class="cursor-pointer rounded-lg border-2 bg-gray-50 border-gray-200 p-4 transition-all"
				role="button" tabindex="0"
				onclick={() => toggleCard('shipped')}
				onkeydown={(e) => handleKeydown(e, 'shipped')}>
				<div class="flex items-center justify-between">
					<h4 class="text-sm font-semibold uppercase tracking-wide">Shipped</h4>
					<span class="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium">{data.pipeline.shipped.thisWeek} this week</span>
				</div>
				<div class="mt-1 text-sm text-gray-600">{data.pipeline.shipped.thisMonth} this month</div>

				{#if expandedCard === 'shipped'}
					<div class="mt-3 border-t border-gray-200 pt-3 text-xs text-gray-600">
						<div>This week: {data.pipeline.shipped.thisWeek}</div>
						<div>This month: {data.pipeline.shipped.thisMonth}</div>
						{#if data.pipeline.shipped.recentShipment}
							<div class="mt-1">Last: {new Date(data.pipeline.shipped.recentShipment.date).toLocaleDateString()} → {data.pipeline.shipped.recentShipment.destination} ({data.pipeline.shipped.recentShipment.count} units)</div>
						{/if}
					</div>
				{/if}
			</div>
		</div>
	</div>

	<!-- Weekly Stats Footer -->
	<div class="mt-6 rounded-lg border bg-white p-4 shadow-sm">
		<h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">This Week</h2>
		<div class="flex flex-wrap gap-4 text-sm text-gray-700">
			<span>Wax runs: <strong>{data.weeklyStats.waxRuns}</strong></span>
			<span>·</span>
			<span>Reagent runs: <strong>{data.weeklyStats.reagentRuns}</strong></span>
			<span>·</span>
			<span>Produced: <strong>{data.weeklyStats.produced}</strong></span>
			<span>·</span>
			<span>Rejected: <strong>{data.weeklyStats.rejected}</strong></span>
			<span>·</span>
			<span>Yield: <strong>{data.weeklyStats.yieldPercent}%</strong></span>
		</div>
		{#if data.weeklyStats.topRejections?.length}
			<div class="mt-2 text-xs text-gray-500">
				Top rejections: {#each data.weeklyStats.topRejections as reason, i}{#if i > 0} · {/if}{reason._id ?? 'Unknown'} ({reason.count}){/each}
			</div>
		{/if}
	</div>
</div>
