<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';

	let { data } = $props();

	let dismissedAlerts = $state<Set<number>>(new Set());
	let expandedOvens = $state<SvelteSet<string>>(new SvelteSet());
	let expandedLots = $state<SvelteSet<string>>(new SvelteSet());

	// Cartridge search state
	let cartridgeInput = $state('');
	let cartridgeLookupResult = $state<null | {
		cartridgeRecordId: string;
		currentPhase: string;
		nextPhase: string | null;
		isNew: boolean;
		isComplete: boolean;
	}>(null);
	let cartridgeLookupError = $state('');
	let cartridgeLookupBusy = $state(false);

	function toggleOven(id: string) {
		if (expandedOvens.has(id)) expandedOvens.delete(id);
		else expandedOvens.add(id);
	}

	function toggleLot(lotId: string) {
		if (expandedLots.has(lotId)) expandedLots.delete(lotId);
		else expandedLots.add(lotId);
	}

	function robotStatusBorder(status: string): string {
		if (status.startsWith('running')) return 'border-l-[var(--color-tron-yellow)]';
		if (status === 'available') return 'border-l-[var(--color-tron-green)]';
		if (status.startsWith('deck_free')) return 'border-l-[var(--color-tron-cyan)]';
		if (status.startsWith('blocked')) return 'border-l-[var(--color-tron-red)]';
		return 'border-l-[var(--color-tron-border)]';
	}

	function alertBorder(level: string): string {
		if (level === 'red') return 'border-l-[var(--color-tron-red)]';
		if (level === 'orange') return 'border-l-[var(--color-tron-orange)]';
		return 'border-l-[var(--color-tron-yellow)]';
	}

	function alertText(level: string): string {
		if (level === 'red') return 'text-[var(--color-tron-red)]';
		if (level === 'orange') return 'text-[var(--color-tron-orange)]';
		return 'text-[var(--color-tron-yellow)]';
	}

	// Current users: operators tied to active runs
	const currentUsers = $derived.by(() => {
		const map = new Map<string, { username: string; responsibilities: string[] }>();
		for (const r of data.robots ?? []) {
			if (r.activeWaxRun?.operatorUsername) {
				const u = r.activeWaxRun.operatorUsername;
				if (!map.has(u)) map.set(u, { username: u, responsibilities: [] });
				map.get(u)!.responsibilities.push(`Wax Fill on ${r.name} (${r.activeWaxRun.stage}, ${r.activeWaxRun.elapsedMin}m)`);
			}
			if (r.activeReagentRun?.operatorUsername) {
				const u = r.activeReagentRun.operatorUsername;
				if (!map.has(u)) map.set(u, { username: u, responsibilities: [] });
				map.get(u)!.responsibilities.push(`Reagent on ${r.name} (${r.activeReagentRun.stage}, ${r.activeReagentRun.elapsedMin}m)`);
			}
		}
		return [...map.values()];
	});

	const pipelineStages = $derived([
		{ label: 'Backing', count: data.pipeline.backing.backedTotal, sub: `${data.pipeline.backing.totalReadyCartridges} ready`, color: 'text-[var(--color-tron-purple)]' },
		{ label: 'Wax Fill', count: data.pipeline.waxFilling.inProgress + data.pipeline.waxFilling.waxFilled, sub: `${data.pipeline.waxFilling.inProgress} filling`, color: 'text-[var(--color-tron-yellow)]' },
		{ label: 'Cooling', count: data.pipeline.waxFilling.waxStored, sub: 'in fridge', color: 'text-[var(--color-tron-blue)]' },
		{ label: 'Reagent', count: data.pipeline.reagentFilling.inProgress + data.pipeline.reagentFilling.reagentFilled, sub: `${data.pipeline.reagentFilling.inProgress} filling`, color: 'text-[var(--color-tron-orange)]' },
		{ label: 'Seal', count: data.pipeline.reagentFilling.sealed, sub: 'sealed', color: 'text-[var(--color-tron-cyan)]' },
		{ label: 'Store', count: data.pipeline.storage.stored, sub: `${data.pipeline.storage.voided} voided`, color: 'text-[var(--color-tron-green)]' }
	]);

	async function runCartridgeLookup() {
		const code = cartridgeInput.trim();
		if (!code) return;
		cartridgeLookupBusy = true;
		cartridgeLookupError = '';
		cartridgeLookupResult = null;
		try {
			const res = await fetch(`/api/cv/lookup-cartridge?code=${encodeURIComponent(code)}`);
			const body = await res.json();
			if (!res.ok || body.error) {
				cartridgeLookupError = body.error ?? `Cartridge "${code}" not found.`;
			} else {
				cartridgeLookupResult = {
					cartridgeRecordId: body.cartridgeRecordId ?? code,
					currentPhase: body.currentPhase ?? 'unknown',
					nextPhase: body.nextPhase ?? null,
					isNew: !!body.isNew,
					isComplete: !!body.isComplete
				};
			}
		} catch {
			cartridgeLookupError = 'Lookup service unavailable.';
		} finally {
			cartridgeLookupBusy = false;
		}
	}

	function handleCartridgeKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && cartridgeInput.trim()) {
			e.preventDefault();
			runCartridgeLookup();
		}
	}

	function phaseBadgeColor(phase: string): string {
		if (phase === 'voided' || phase === 'scrapped') return 'text-[var(--color-tron-red)] border-[var(--color-tron-red)]/50';
		if (phase === 'stored' || phase === 'released' || phase === 'shipped' || phase === 'completed') return 'text-[var(--color-tron-green)] border-[var(--color-tron-green)]/50';
		if (phase === 'wax_filling' || phase === 'reagent_filling') return 'text-[var(--color-tron-yellow)] border-[var(--color-tron-yellow)]/50';
		return 'text-[var(--color-tron-cyan)] border-[var(--color-tron-cyan)]/50';
	}
</script>

<div class="space-y-6 p-4 lg:p-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold text-[var(--color-tron-cyan)] tracking-wide">CART MFG DASHBOARD</h1>
			<p class="text-sm text-[var(--color-tron-text-secondary)]">Manufacturing Line Master View</p>
		</div>
		<a href="/manufacturing" class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]">↻ Refresh</a>
	</div>

	<!-- Top row: Shift summary stats -->
	<div class="grid grid-cols-2 gap-3 lg:grid-cols-5">
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3 text-center">
			<div class="text-xs font-medium text-[var(--color-tron-text-secondary)] uppercase tracking-wide">Started Today</div>
			<div class="mt-1 text-2xl font-bold text-[var(--color-tron-cyan)]">{data.todayStats.waxRuns.completed + data.todayStats.waxRuns.inProgress + data.todayStats.waxRuns.aborted + data.todayStats.reagentRuns.completed + data.todayStats.reagentRuns.inProgress + data.todayStats.reagentRuns.aborted}</div>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">runs</div>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3 text-center">
			<div class="text-xs font-medium text-[var(--color-tron-text-secondary)] uppercase tracking-wide">Completed</div>
			<div class="mt-1 text-2xl font-bold text-[var(--color-tron-green)]">{data.todayStats.producedToday}</div>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">cartridges</div>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3 text-center">
			<div class="text-xs font-medium text-[var(--color-tron-text-secondary)] uppercase tracking-wide">Failed</div>
			<div class="mt-1 text-2xl font-bold text-[var(--color-tron-red)]">{data.todayStats.rejectedToday}</div>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">rejected</div>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3 text-center">
			<div class="text-xs font-medium text-[var(--color-tron-text-secondary)] uppercase tracking-wide">Yield</div>
			<div class="mt-1 text-2xl font-bold {data.todayStats.yieldPercent >= 90 ? 'text-[var(--color-tron-green)]' : data.todayStats.yieldPercent >= 70 ? 'text-[var(--color-tron-yellow)]' : 'text-[var(--color-tron-red)]'}">{data.todayStats.yieldPercent}%</div>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">{data.todayStats.acceptedToday}/{data.todayStats.producedToday}</div>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3 text-center">
			<div class="text-xs font-medium text-[var(--color-tron-text-secondary)] uppercase tracking-wide">Users</div>
			<div class="mt-1 text-2xl font-bold text-[var(--color-tron-purple)]">{currentUsers.length}</div>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">active</div>
		</div>
	</div>

	<!-- Alerts -->
	{#if data.alerts?.length}
		<div class="space-y-2">
			{#each data.alerts as alert, i}
				{#if !dismissedAlerts.has(i)}
					<div class="flex items-center justify-between rounded-lg border-l-4 {alertBorder(alert.level)} bg-[var(--color-tron-bg-secondary)] px-4 py-2">
						<span class="text-sm font-medium {alertText(alert.level)}">{alert.message}</span>
						<button class="ml-4 text-xs text-[var(--color-tron-text-secondary)] opacity-60 hover:opacity-100" onclick={() => { dismissedAlerts = new Set([...dismissedAlerts, i]); }}>✕</button>
					</div>
				{/if}
			{/each}
		</div>
	{/if}

	<!-- Pipeline Flow Visualization -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
		<h2 class="mb-4 text-xs font-semibold uppercase tracking-widest text-[var(--color-tron-cyan)]">Pipeline Flow</h2>
		<div class="flex items-stretch gap-1 overflow-x-auto">
			{#each pipelineStages as stage, i}
				<div class="flex-1 min-w-[100px] text-center">
					<div class="rounded-lg bg-[var(--color-tron-bg-tertiary)] border border-[var(--color-tron-border)] p-3 h-full flex flex-col justify-center">
						<div class="text-xs font-semibold uppercase tracking-wide text-[var(--color-tron-text-secondary)]">{stage.label}</div>
						<div class="mt-1 text-xl font-bold {stage.color}">{stage.count}</div>
						<div class="text-xs text-[var(--color-tron-text-secondary)]">{stage.sub}</div>
					</div>
				</div>
				{#if i < pipelineStages.length - 1}
					<div class="flex items-center text-[var(--color-tron-cyan)] text-lg font-bold select-none">▶</div>
				{/if}
			{/each}
		</div>
	</div>

	<!-- Robot Status Grid -->
	<div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
		{#each data.robots as robot}
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] border-l-4 {robotStatusBorder(robot.status)} p-4">
				<div class="flex items-center justify-between mb-3">
					<h3 class="text-sm font-bold text-[var(--color-tron-text)] uppercase tracking-wide">{robot.name}</h3>
					<span class="rounded border border-[var(--color-tron-border)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-tron-text-secondary)]">{robot.displayStatus}</span>
				</div>
				<div class="mb-3">
					<div class="flex justify-between text-xs text-[var(--color-tron-text-secondary)] mb-1">
						<span>Utilization</span>
						<span>{robot.utilizationPct}% ({robot.utilizationHours}h)</span>
					</div>
					<div class="h-1.5 rounded-full bg-[var(--color-tron-bg-tertiary)]">
						<div class="h-full rounded-full bg-[var(--color-tron-cyan)]" style="width: {robot.utilizationPct}%"></div>
					</div>
				</div>
				{#if robot.activeWaxRun}
					<div class="space-y-1 text-xs">
						<div class="flex justify-between"><span class="text-[var(--color-tron-text-secondary)]">Run</span><span class="text-[var(--color-tron-text)]">Wax · {robot.activeWaxRun.stage}</span></div>
						<div class="flex justify-between"><span class="text-[var(--color-tron-text-secondary)]">Operator</span><span class="text-[var(--color-tron-text)]">{robot.activeWaxRun.operatorUsername ?? 'Unknown'}</span></div>
						<div class="flex justify-between"><span class="text-[var(--color-tron-text-secondary)]">Elapsed</span><span class="text-[var(--color-tron-text)]">{robot.activeWaxRun.elapsedMin} min</span></div>
						<div class="flex justify-between"><span class="text-[var(--color-tron-text-secondary)]">Cartridges</span><span class="text-[var(--color-tron-text)]">{robot.activeWaxRun.cartridgeCount}</span></div>
					</div>
					<a href="/manufacturing/wax-filling?robot={robot.robotId}" class="mt-3 block text-xs text-[var(--color-tron-cyan)] hover:underline">→ Go to Wax Filling</a>
				{:else if robot.activeReagentRun}
					<div class="space-y-1 text-xs">
						<div class="flex justify-between"><span class="text-[var(--color-tron-text-secondary)]">Run</span><span class="text-[var(--color-tron-text)]">Reagent · {robot.activeReagentRun.stage}</span></div>
						<div class="flex justify-between"><span class="text-[var(--color-tron-text-secondary)]">Operator</span><span class="text-[var(--color-tron-text)]">{robot.activeReagentRun.operatorUsername ?? 'Unknown'}</span></div>
						<div class="flex justify-between"><span class="text-[var(--color-tron-text-secondary)]">Elapsed</span><span class="text-[var(--color-tron-text)]">{robot.activeReagentRun.elapsedMin} min</span></div>
						<div class="flex justify-between"><span class="text-[var(--color-tron-text-secondary)]">Cartridges</span><span class="text-[var(--color-tron-text)]">{robot.activeReagentRun.cartridgeCount}</span></div>
					</div>
					<a href="/manufacturing/reagent-filling?robot={robot.robotId}" class="mt-3 block text-xs text-[var(--color-tron-cyan)] hover:underline">→ Go to Reagent Filling</a>
				{:else}
					<div class="text-xs text-[var(--color-tron-text-secondary)] mb-2">No active run</div>
					<div class="flex gap-3">
						<a href="/manufacturing/wax-filling?robot={robot.robotId}" class="text-xs text-[var(--color-tron-cyan)] hover:underline">▶ Start Wax</a>
						<a href="/manufacturing/reagent-filling?robot={robot.robotId}" class="text-xs text-[var(--color-tron-cyan)] hover:underline">▶ Start Reagent</a>
					</div>
				{/if}
			</div>
		{/each}
	</div>

	<!-- Ovens section — real IDs, collapsible contents, lot IDs collapsed by default -->
	<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
		<h2 class="border-b border-[var(--color-tron-border)] px-4 py-3 text-xs font-semibold uppercase tracking-widest text-[var(--color-tron-cyan)]">Ovens</h2>
		{#if data.ovens.length === 0}
			<p class="px-4 py-6 text-center text-sm text-[var(--color-tron-text-secondary)]">No ovens configured.</p>
		{:else}
			<div class="divide-y divide-[var(--color-tron-border)]">
				{#each data.ovens as oven (oven.id)}
					{@const isOpen = expandedOvens.has(oven.id)}
					<div>
						<button
							type="button"
							class="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-[var(--color-tron-bg-tertiary)]"
							onclick={() => toggleOven(oven.id)}
						>
							<div class="flex items-center gap-3">
								<span class="text-[var(--color-tron-cyan)] text-sm">{isOpen ? '▼' : '▶'}</span>
								<span class="font-mono text-sm font-semibold text-[var(--color-tron-text)]">{oven.displayName}</span>
								<span class="text-xs text-[var(--color-tron-text-secondary)]">({oven.lotCount} lots · {oven.totalCartridges} cartridges)</span>
							</div>
							{#if oven.readyLotCount > 0}
								<span class="rounded border border-[var(--color-tron-green)]/50 bg-[var(--color-tron-green)]/10 px-2 py-0.5 text-[10px] font-bold text-[var(--color-tron-green)]">{oven.readyLotCount} READY</span>
							{/if}
						</button>
						{#if isOpen}
							<div class="bg-[var(--color-tron-bg-tertiary)] px-4 pb-3">
								{#if oven.lots.length === 0}
									<p class="py-2 text-xs text-[var(--color-tron-text-secondary)]">Oven is empty.</p>
								{:else}
									<div class="space-y-1">
										{#each oven.lots as lot (lot.lotId)}
											{@const lotOpen = expandedLots.has(lot.lotId)}
											<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
												<div class="flex items-center justify-between px-3 py-2">
													<div class="flex min-w-0 items-center gap-2">
														<button
															type="button"
															class="text-[var(--color-tron-cyan)] text-xs hover:text-[var(--color-tron-text)]"
															onclick={() => toggleLot(lot.lotId)}
															aria-label={lotOpen ? 'Collapse lot' : 'Expand lot'}
														>{lotOpen ? '▼' : '▶'}</button>
														<a
															href="/manufacturing/lots/{lot.lotId}"
															class="font-mono text-xs font-semibold text-[var(--color-tron-cyan)] hover:underline"
														>{lot.lotId}</a>
														<span class="text-[10px] text-[var(--color-tron-text-secondary)]">· {lot.cartridgeCount} cartridges</span>
													</div>
													{#if lot.isReady}
														<span class="rounded border border-[var(--color-tron-green)]/50 bg-[var(--color-tron-green)]/10 px-1.5 py-0.5 text-[10px] font-bold text-[var(--color-tron-green)]">READY</span>
													{:else}
														<span class="text-[10px] text-[var(--color-tron-yellow)]">{lot.remainingMin} min left</span>
													{/if}
												</div>
												{#if lotOpen}
													<div class="border-t border-[var(--color-tron-border)] px-3 py-2 text-[11px] text-[var(--color-tron-text-secondary)] space-y-0.5">
														<div>Status: <span class="text-[var(--color-tron-text)]">{lot.status}</span></div>
														<div>Operator: <span class="text-[var(--color-tron-text)]">{lot.operatorUsername ?? '—'}</span></div>
														<div>Elapsed: <span class="text-[var(--color-tron-text)]">{lot.elapsedMin} min</span></div>
														<div>Entry: <span class="text-[var(--color-tron-text)]">{lot.ovenEntryTime ? new Date(lot.ovenEntryTime).toLocaleString() : '—'}</span></div>
														<div class="pt-1"><a href="/manufacturing/lots/{lot.lotId}" class="text-[var(--color-tron-cyan)] hover:underline">→ Open lot detail page</a></div>
													</div>
												{/if}
											</div>
										{/each}
									</div>
								{/if}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</section>

	<!-- Cartridge Barcode Search — replaces Register Backing Lot -->
	<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
		<h2 class="border-b border-[var(--color-tron-border)] px-4 py-3 text-xs font-semibold uppercase tracking-widest text-[var(--color-tron-cyan)]">Cartridge Barcode Search</h2>
		<div class="p-4">
			<p class="mb-3 text-xs text-[var(--color-tron-text-secondary)]">Scan or type a cartridge barcode to see its current phase and next required step.</p>
			<div class="flex gap-2">
				<input
					type="text"
					class="tron-input flex-1"
					placeholder="Scan cartridge barcode..."
					bind:value={cartridgeInput}
					onkeydown={handleCartridgeKeydown}
					autocomplete="off"
				/>
				<button
					type="button"
					onclick={runCartridgeLookup}
					disabled={cartridgeLookupBusy || !cartridgeInput.trim()}
					class="rounded-lg border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/15 px-4 py-2 text-xs font-semibold text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/25 disabled:opacity-40"
				>
					{cartridgeLookupBusy ? 'Looking up...' : 'Lookup'}
				</button>
			</div>
			{#if cartridgeLookupError}
				<p class="mt-3 text-sm text-[var(--color-tron-red)]">{cartridgeLookupError}</p>
			{/if}
			{#if cartridgeLookupResult}
				<div class="mt-3 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] p-3 text-sm">
					<div class="flex items-center gap-2">
						<span class="font-mono font-semibold text-[var(--color-tron-cyan)]">{cartridgeLookupResult.cartridgeRecordId}</span>
						{#if cartridgeLookupResult.isNew}
							<span class="rounded border border-[var(--color-tron-yellow)]/50 px-1.5 py-0.5 text-[10px] text-[var(--color-tron-yellow)]">NEW</span>
						{/if}
						{#if cartridgeLookupResult.isComplete}
							<span class="rounded border border-[var(--color-tron-green)]/50 px-1.5 py-0.5 text-[10px] text-[var(--color-tron-green)]">COMPLETE</span>
						{/if}
					</div>
					<div class="mt-2 space-y-1 text-xs">
						<div>Current phase: <span class="rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase {phaseBadgeColor(cartridgeLookupResult.currentPhase)}">{cartridgeLookupResult.currentPhase}</span></div>
						{#if cartridgeLookupResult.nextPhase}
							<div>Should be at: <span class="text-[var(--color-tron-text)] font-medium">{cartridgeLookupResult.nextPhase}</span></div>
						{/if}
					</div>
				</div>
			{/if}
		</div>
	</section>

	<!-- Current Users (renamed from Operator Activity) -->
	<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
		<h2 class="mb-3 text-xs font-semibold uppercase tracking-widest text-[var(--color-tron-cyan)]">Current Users</h2>
		{#if currentUsers.length === 0}
			<p class="text-sm text-[var(--color-tron-text-secondary)]">No active operators on the line.</p>
		{:else}
			<div class="space-y-2">
				{#each currentUsers as user}
					<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] px-3 py-2">
						<div class="text-sm font-semibold text-[var(--color-tron-text)]">{user.username}</div>
						<ul class="mt-1 list-disc pl-5 text-xs text-[var(--color-tron-text-secondary)]">
							{#each user.responsibilities as r}
								<li>{r}</li>
							{/each}
						</ul>
					</div>
				{/each}
			</div>
		{/if}
	</section>

	<!-- This Week (compact) -->
	<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3">
		<div class="flex flex-wrap items-center gap-4 text-xs">
			<span class="font-semibold uppercase tracking-widest text-[var(--color-tron-cyan)]">This Week</span>
			<span><span class="text-[var(--color-tron-text)] font-semibold">{data.weeklyStats.waxRuns}</span> wax</span>
			<span><span class="text-[var(--color-tron-text)] font-semibold">{data.weeklyStats.reagentRuns}</span> reagent</span>
			<span><span class="text-[var(--color-tron-green)] font-semibold">{data.weeklyStats.produced}</span> produced</span>
			<span><span class="text-[var(--color-tron-red)] font-semibold">{data.weeklyStats.rejected}</span> rejected</span>
			<span>Yield <span class="font-semibold {data.weeklyStats.yieldPercent >= 90 ? 'text-[var(--color-tron-green)]' : data.weeklyStats.yieldPercent >= 70 ? 'text-[var(--color-tron-yellow)]' : 'text-[var(--color-tron-red)]'}">{data.weeklyStats.yieldPercent}%</span></span>
		</div>
	</section>
</div>
