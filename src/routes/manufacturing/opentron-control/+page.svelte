<script lang="ts">
	let { data } = $props();

	function robotStatusColor(status: string): string {
		if (status === 'available') return 'border-green-500/50 bg-green-900/10';
		if (status === 'running_wax') return 'border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10';
		if (status === 'running_reagent') return 'border-purple-500/50 bg-purple-900/10';
		return 'border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]';
	}

	function sealUrgencyColor(overdue: boolean, minRemaining: number): string {
		if (overdue) return 'text-red-400';
		if (minRemaining <= 15) return 'text-yellow-400';
		return 'text-green-400';
	}

	/** Compact "MMM D, H:MMa" — e.g. "Apr 20, 1:23p". Falls back to elapsed if null. */
	function formatFinished(iso: string | null, elapsedMin: number): string {
		if (!iso) return `${elapsedMin} min ago`;
		const d = new Date(iso);
		const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
		const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(' ', '').toLowerCase();
		return `${date}, ${time}`;
	}
</script>

<div class="mx-auto max-w-7xl space-y-8 p-4">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan)">Opentron Control</h1>
		<a href="/manufacturing/opentron-control/settings"
			title="View wax + reagent filling settings"
			aria-label="Settings"
			class="inline-flex items-center gap-2 rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs font-medium hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)] transition-colors"
			style="color: var(--color-tron-text)">
			<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<circle cx="12" cy="12" r="3" />
				<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
			</svg>
			Settings
		</a>
	</div>

	<!-- Robot Cards -->
	<section>
		<h2 class="mb-3 text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Robots</h2>
		<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{#each data.robotCards as robot (robot.robotId)}
				<div class="rounded-lg border p-4 transition-all {robotStatusColor(robot.status)}">
					<div class="flex items-center justify-between">
						<div>
							<h3 class="text-lg font-semibold" style="color: var(--color-tron-text)">{robot.name}</h3>
							{#if robot.description}
								<p class="text-xs" style="color: var(--color-tron-text-secondary)">{robot.description}</p>
							{/if}
						</div>
						<div class="rounded-full px-3 py-1 text-xs font-medium
							{robot.status === 'available' ? 'bg-green-500/20 text-green-300' :
							 robot.status === 'running_wax' ? 'bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]' :
							 'bg-purple-500/20 text-purple-300'}">
							{robot.status === 'available' ? 'Available' : 'In Use'}
						</div>
					</div>
					<p class="mt-2 text-sm" style="color: var(--color-tron-text-secondary)">{robot.displayStatus}</p>
					<div class="mt-3 flex gap-2">
						{#if robot.status === 'available'}
							<a href="/manufacturing/wax-filling?robot={robot.robotId}"
								class="rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-3 py-1.5 text-xs font-medium text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/20 transition-colors"
								style="min-height: 36px; display: inline-flex; align-items: center;">
								Start Wax Filling
							</a>
							<a href="/manufacturing/reagent-filling?robot={robot.robotId}"
								class="rounded border border-purple-500/50 bg-purple-900/10 px-3 py-1.5 text-xs font-medium text-purple-300 hover:bg-purple-900/20 transition-colors"
								style="min-height: 36px; display: inline-flex; align-items: center;">
								Start Reagent Filling
							</a>
						{:else if robot.activeRunId}
							<a href="/manufacturing/{robot.activeProcess === 'wax' ? 'wax-filling' : 'reagent-filling'}?robot={robot.robotId}"
								class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs font-medium hover:border-[var(--color-tron-cyan)] transition-colors"
								style="color: var(--color-tron-text); min-height: 36px; display: inline-flex; align-items: center;">
								Go to Run
							</a>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	</section>

	<!-- Wax Queue -->
	<section>
		<div class="flex items-center gap-3 mb-3">
			<h2 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
				Wax Cartridges Requiring Inspection & Storage
			</h2>
			{#if data.waxQueue.length > 0}
				<span class="rounded-full bg-[var(--color-tron-cyan)]/20 px-2.5 py-0.5 text-xs font-bold text-[var(--color-tron-cyan)]">
					{data.waxQueue.length}
				</span>
			{/if}
		</div>
		{#if data.waxQueue.length === 0}
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-6 text-center">
				<p class="text-sm" style="color: var(--color-tron-text-secondary)">No wax runs awaiting post-processing.</p>
			</div>
		{:else}
			<div class="space-y-2">
				{#each data.waxQueue as run (run.runId)}
					<a href="/manufacturing/opentron-control/wax/{run.runId}"
						class="flex items-center justify-between rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 hover:border-[var(--color-tron-cyan)]/50 hover:bg-[var(--color-tron-cyan)]/5 transition-all">
						<div class="flex items-center gap-4">
							<div>
								<span class="font-mono text-sm font-bold" style="color: var(--color-tron-cyan)">{run.runId.slice(-8)}</span>
								<p class="text-xs" style="color: var(--color-tron-text-secondary)">{run.robotName} &middot; {run.operatorName}</p>
								<p class="mt-0.5 text-xs" style="color: var(--color-tron-text-secondary)">
									{#if run.trayId}<span>Tray <span class="font-mono text-[var(--color-tron-text)]">{run.trayId}</span></span>{/if}
									{#if run.trayId && run.fridgeLocation} &middot; {/if}
									{#if run.fridgeLocation}<span>Fridge <span class="font-mono text-[var(--color-tron-text)]">{run.fridgeLocation}</span></span>{/if}
								</p>
							</div>
							<div class="rounded bg-[var(--color-tron-cyan)]/10 px-2 py-1 text-xs font-medium" style="color: var(--color-tron-cyan)">
								{run.status}
							</div>
						</div>
						<div class="flex items-center gap-6 text-right">
							<div>
								<p class="text-sm font-bold" style="color: var(--color-tron-text)">{run.cartridgeCount} cartridges</p>
								<p class="text-xs" style="color: var(--color-tron-text-secondary)">OT-2 done {formatFinished(run.robotReleasedAt, run.elapsedSinceReleasedMin)}</p>
							</div>
							<svg class="h-5 w-5" style="color: var(--color-tron-text-secondary)" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
							</svg>
						</div>
					</a>
				{/each}
			</div>
		{/if}
	</section>

	<!-- Reagent Queue -->
	<section>
		<div class="flex items-center gap-3 mb-3">
			<h2 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
				Reagent Cartridges Requiring Top Sealing & Storage
			</h2>
			{#if data.reagentQueue.length > 0}
				<span class="rounded-full bg-purple-500/20 px-2.5 py-0.5 text-xs font-bold text-purple-300">
					{data.reagentQueue.length}
				</span>
			{/if}
		</div>
		{#if data.reagentQueue.length === 0}
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-6 text-center">
				<p class="text-sm" style="color: var(--color-tron-text-secondary)">No reagent runs awaiting post-processing.</p>
			</div>
		{:else}
			<div class="space-y-2">
				{#each data.reagentQueue as run (run.runId)}
					<a href="/manufacturing/opentron-control/reagent/{run.runId}"
						class="flex items-center justify-between rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 hover:border-purple-500/50 hover:bg-purple-900/5 transition-all">
						<div class="flex items-center gap-4">
							<div>
								<span class="font-mono text-sm font-bold text-purple-300">{run.runId.slice(-8)}</span>
								<p class="text-xs" style="color: var(--color-tron-text-secondary)">{run.robotName} &middot; {run.assayTypeName || 'Unknown assay'} &middot; {run.operatorName}</p>
								<p class="mt-0.5 text-xs" style="color: var(--color-tron-text-secondary)">
									{#if run.trayId}<span>Tray <span class="font-mono text-[var(--color-tron-text)]">{run.trayId}</span></span>{/if}
									{#if run.trayId && run.fridgeLocation} &middot; {/if}
									{#if run.fridgeLocation}<span>Fridge <span class="font-mono text-[var(--color-tron-text)]">{run.fridgeLocation}</span></span>{/if}
								</p>
							</div>
							<div class="rounded bg-purple-500/10 px-2 py-1 text-xs font-medium text-purple-300">
								{run.status}
							</div>
						</div>
						<div class="flex items-center gap-6 text-right">
							<div>
								<p class="text-sm font-bold" style="color: var(--color-tron-text)">{run.sealedCount}/{run.cartridgeCount} sealed</p>
								<p class="text-xs" style="color: var(--color-tron-text-secondary)">OT-2 done {formatFinished(run.robotReleasedAt, run.elapsedSinceReleasedMin)}</p>
								<p class="mt-0.5 text-xs {sealUrgencyColor(run.sealOverdue, run.sealMinRemaining)}">
									{#if run.sealOverdue}
										OVERDUE — seal immediately
									{:else}
										{run.sealMinRemaining} min to seal deadline
									{/if}
								</p>
							</div>
							<svg class="h-5 w-5" style="color: var(--color-tron-text-secondary)" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
							</svg>
						</div>
					</a>
				{/each}
			</div>
		{/if}
	</section>
</div>
