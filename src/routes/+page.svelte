<script lang="ts">
	import { TronCard, TronBadge } from '$lib/components/ui';

	let { data } = $props();

	// Panel collapse state
	let cartCollapsed = $state(false);
	let showAssayInventory = $state(false);

	// Phase colors for manufacturing pipeline
	const phaseColors: Record<string, string> = {
		backing: '#6366f1', wax_filled: '#8b5cf6', wax_stored: '#7c3aed', wax_qc: '#a78bfa',
		wax_ready: '#16a34a', wax_rejected: '#dc2626',
		reagent_filled: '#06b6d4', inspected: '#22d3ee', sealed: '#14b8a6',
		reagent_qc: '#f59e0b', reagent_ready: '#16a34a', reagent_rejected: '#dc2626',
		cured: '#10b981',
		stored: '#059669', released: '#34d399', shipped: '#4ade80', assay_loaded: '#f59e0b',
		testing: '#f97316', completed: '#22c55e'
	};

	function phaseColor(phase: string): string {
		return phaseColors[phase] ?? 'var(--color-tron-text-secondary)';
	}

	function formatRelative(date: string | Date | null): string {
		if (!date) return '—';
		const diff = Date.now() - new Date(date).getTime();
		const h = Math.floor(diff / 3600000);
		if (h < 1) return 'Just now';
		if (h < 24) return `${h}h ago`;
		const d = Math.floor(h / 24);
		return d === 1 ? 'Yesterday' : `${d}d ago`;
	}

	function daysUntil(date: string | Date | null): number {
		if (!date) return 999;
		return Math.ceil((new Date(date).getTime() - Date.now()) / 86400000);
	}

	function formatDate(date: string | Date | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleDateString();
	}
</script>

<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)]">
		<button type="button" onclick={() => { cartCollapsed = !cartCollapsed; }} class="flex w-full items-center justify-between p-4">
			<h2 class="text-lg font-bold text-[var(--color-tron-text)]">Cartridge Dashboard</h2>
			<svg class="h-4 w-4 text-[var(--color-tron-cyan)] transition-transform {cartCollapsed ? '' : 'rotate-180'}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
			</svg>
		</button>
		{#if !cartCollapsed && data.cartridgeDashboard}
			{@const cd = data.cartridgeDashboard}
			{@const pipelineTotal = cd.pipeline.reduce((s, p) => s + p.count, 0)}
			{@const maxPhaseCount = Math.max(...cd.pipeline.map(p => p.count), 1)}
			{@const waxTotal = (cd.waxQc['Accepted'] ?? 0) + (cd.waxQc['Rejected'] ?? 0)}
			{@const reagentTotal = (cd.reagentInspection['Accepted'] ?? 0) + (cd.reagentInspection['Rejected'] ?? 0)}
			{@const waxYieldVal = waxTotal > 0 ? (((cd.waxQc['Accepted'] ?? 0) / waxTotal) * 100).toFixed(1) : '—'}
			{@const reagentYieldVal = reagentTotal > 0 ? (((cd.reagentInspection['Accepted'] ?? 0) / reagentTotal) * 100).toFixed(1) : '—'}
			<div class="px-4 pb-4 space-y-5">
				<p class="text-xs text-[var(--color-tron-text-secondary)]">Manufacturing pipeline &amp; inventory at a glance</p>

				<!-- Top Stats Row -->
				<div class="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
					<TronCard>
						<div class="text-center">
							<div class="text-2xl font-bold text-[var(--color-tron-cyan)]">{cd.totalMfg}</div>
							<div class="text-[10px] text-[var(--color-tron-text-secondary)] uppercase tracking-wider">Total Active</div>
						</div>
					</TronCard>
					<TronCard>
						<div class="text-center">
							<div class="text-2xl font-bold text-green-400">{cd.weeklyProduction}</div>
							<div class="text-[10px] text-[var(--color-tron-text-secondary)] uppercase tracking-wider">This Week</div>
						</div>
					</TronCard>
					<TronCard>
						<div class="text-center">
							<div class="text-2xl font-bold" style="color: {(waxYieldVal !== '—' && parseFloat(waxYieldVal) >= 90) ? 'var(--color-tron-green)' : 'var(--color-tron-orange)'}">
								{waxYieldVal}{waxYieldVal !== '—' ? '%' : ''}
							</div>
							<div class="text-[10px] text-[var(--color-tron-text-secondary)] uppercase tracking-wider">Wax QC Yield</div>
						</div>
					</TronCard>
					<TronCard>
						<div class="text-center">
							<div class="text-2xl font-bold" style="color: {(reagentYieldVal !== '—' && parseFloat(reagentYieldVal) >= 90) ? 'var(--color-tron-green)' : 'var(--color-tron-orange)'}">
								{reagentYieldVal}{reagentYieldVal !== '—' ? '%' : ''}
							</div>
							<div class="text-[10px] text-[var(--color-tron-text-secondary)] uppercase tracking-wider">Reagent Yield</div>
						</div>
					</TronCard>
					{#if cd.expiringCount > 0}
						<TronCard>
							<div class="text-center">
								<div class="text-2xl font-bold text-amber-400">{cd.expiringCount}</div>
								<div class="text-[10px] text-[var(--color-tron-text-secondary)] uppercase tracking-wider">Expiring &lt;30d</div>
							</div>
						</TronCard>
					{:else}
						<TronCard>
							<div class="text-center">
								<div class="text-2xl font-bold text-red-400">{cd.totalVoided}</div>
								<div class="text-[10px] text-[var(--color-tron-text-secondary)] uppercase tracking-wider">Voided</div>
							</div>
						</TronCard>
					{/if}
				</div>

				<!-- Pipeline + QC Row -->
				<div class="grid gap-4 lg:grid-cols-3">
					<div class="lg:col-span-2">
						<TronCard>
							<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Manufacturing Pipeline</h3>
							<div class="space-y-1.5">
								{#each cd.pipeline.filter(p => p.count > 0) as stage}
									<div class="flex items-center gap-2">
										<span class="w-24 truncate text-xs text-[var(--color-tron-text-secondary)]">{stage.label}</span>
										<div class="flex-1 h-5 rounded-sm bg-[var(--color-tron-surface)] overflow-hidden">
											<div class="h-full rounded-sm flex items-center px-1.5 transition-all" style="width: {Math.max((stage.count / maxPhaseCount) * 100, 3)}%; background: {phaseColor(stage.phase)};">
												{#if stage.count > 0}
													<span class="text-[10px] font-bold text-white drop-shadow-sm">{stage.count}</span>
												{/if}
											</div>
										</div>
									</div>
								{/each}
							</div>
							{#if pipelineTotal === 0}
								<p class="text-center text-xs text-[var(--color-tron-text-secondary)] py-4">No cartridges in pipeline yet.</p>
							{/if}
						</TronCard>
					</div>

					<div class="space-y-4">
						<TronCard>
							<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">QC Summary</h3>
							<div class="space-y-3">
								<div>
									<div class="flex items-center justify-between mb-1">
										<span class="text-xs text-[var(--color-tron-text-secondary)]">Wax QC</span>
										<span class="text-xs font-mono text-[var(--color-tron-text)]">
											<span class="text-green-400">{cd.waxQc['Accepted'] ?? 0}✓</span>
											<span class="text-red-400 ml-1">{cd.waxQc['Rejected'] ?? 0}✕</span>
											{#if cd.waxQc['Pending']}
												<span class="text-amber-400 ml-1">{cd.waxQc['Pending']}?</span>
											{/if}
										</span>
									</div>
									{#if waxTotal > 0}
										<div class="flex h-2 rounded-full overflow-hidden bg-[var(--color-tron-surface)]">
											<div class="bg-green-500" style="width: {((cd.waxQc['Accepted'] ?? 0) / waxTotal) * 100}%"></div>
											<div class="bg-red-500" style="width: {((cd.waxQc['Rejected'] ?? 0) / waxTotal) * 100}%"></div>
										</div>
									{/if}
								</div>
								<div>
									<div class="flex items-center justify-between mb-1">
										<span class="text-xs text-[var(--color-tron-text-secondary)]">Reagent Insp.</span>
										<span class="text-xs font-mono text-[var(--color-tron-text)]">
											<span class="text-green-400">{cd.reagentInspection['Accepted'] ?? 0}✓</span>
											<span class="text-red-400 ml-1">{cd.reagentInspection['Rejected'] ?? 0}✕</span>
											{#if cd.reagentInspection['Pending']}
												<span class="text-amber-400 ml-1">{cd.reagentInspection['Pending']}?</span>
											{/if}
										</span>
									</div>
									{#if reagentTotal > 0}
										<div class="flex h-2 rounded-full overflow-hidden bg-[var(--color-tron-surface)]">
											<div class="bg-green-500" style="width: {((cd.reagentInspection['Accepted'] ?? 0) / reagentTotal) * 100}%"></div>
											<div class="bg-red-500" style="width: {((cd.reagentInspection['Rejected'] ?? 0) / reagentTotal) * 100}%"></div>
										</div>
									{/if}
								</div>
							</div>
						</TronCard>

						{#if cd.assayBreakdown.length > 0}
							<TronCard>
								<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">By Assay</h3>
								<div class="space-y-2">
									{#each cd.assayBreakdown as assay}
										<div class="flex items-center justify-between">
											<span class="text-xs text-[var(--color-tron-text)] truncate">{assay.name}</span>
											<span class="text-xs font-mono font-bold text-[var(--color-tron-cyan)] ml-2">{assay.count}</span>
										</div>
									{/each}
								</div>
							</TronCard>
						{/if}

						<!-- Fridge storage data moved to Fridge Capacity icon cards below -->
					</div>
				</div>

				<!-- Fridge Capacity Utilization -->
				{#if cd.fridgeCapacity && cd.fridgeCapacity.length > 0}
					<TronCard>
						<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Fridge Capacity</h3>
						<div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
							{#each cd.fridgeCapacity as fridge}
								{@const pct = Math.min((fridge.used / fridge.capacity) * 100, 100)}
								{@const href = fridge.dbLocationId ? `/equipment/location/${fridge.dbLocationId}` : null}
								<svelte:element
									this={href ? 'a' : 'div'}
									{href}
									class="group flex flex-col items-center gap-1.5 rounded-lg border border-blue-500/20 bg-blue-950/30 p-3 text-center transition-colors {href ? 'hover:border-blue-400/40 hover:bg-blue-950/50 cursor-pointer' : ''}"
								>
									<div class="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-500/20 transition-colors {href ? 'group-hover:bg-blue-500/30' : ''}">
										<svg class="h-5 w-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
											<path stroke-linecap="round" stroke-linejoin="round" d="M6 2h12a1 1 0 011 1v18a1 1 0 01-1 1H6a1 1 0 01-1-1V3a1 1 0 011-1zm0 12h12M10 6h1" />
										</svg>
									</div>
									<span class="text-xs font-medium text-blue-100 leading-tight truncate w-full">{fridge.locationName}</span>
									<span class="font-mono text-xs font-bold {pct >= 90 ? 'text-red-400' : pct >= 70 ? 'text-amber-400' : 'text-blue-300'}">{fridge.used}/{fridge.capacity}</span>
									<div class="h-1.5 w-full overflow-hidden rounded-full bg-blue-950/60">
										<div class="h-full rounded-full transition-all" style="width: {pct}%; background: {pct >= 90 ? '#f87171' : pct >= 70 ? '#fbbf24' : '#60a5fa'};"></div>
									</div>
								</svelte:element>
							{/each}
						</div>
					</TronCard>
				{/if}

				<!-- Robot Status -->
				{#if cd.robotStatus && cd.robotStatus.length > 0}
					<TronCard>
						<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Robot Status</h3>
						<div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
							{#each cd.robotStatus as robot}
								<div class="rounded border border-[var(--color-tron-border)] p-2 text-center">
									<div class="text-xs font-bold text-[var(--color-tron-text)] truncate">{robot.name}</div>
									<div class="mt-1">
										{#if robot.busy}
											<span class="inline-block rounded px-1.5 py-0.5 text-[10px] font-medium bg-[rgba(0,255,255,0.15)] text-[var(--color-tron-cyan)]">Running</span>
										{:else if robot.healthy}
											<span class="inline-block rounded px-1.5 py-0.5 text-[10px] font-medium bg-[rgba(34,197,94,0.15)] text-green-400">Idle</span>
										{:else}
											<span class="inline-block rounded px-1.5 py-0.5 text-[10px] font-medium bg-[rgba(239,68,68,0.15)] text-red-400">Offline</span>
										{/if}
									</div>
								</div>
							{/each}
						</div>
					</TronCard>
				{/if}

				<!-- Oven Status -->
				{#if cd.ovenList && cd.ovenList.length > 0}
					<TronCard>
						<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">🔥 Ovens</h3>
						<div class="space-y-1.5">
							{#each cd.ovenList as oven}
								<a href="/equipment/location/{oven.id}" class="flex items-center justify-between rounded px-2 py-1.5 hover:bg-[var(--color-tron-surface)] transition-colors">
									<span class="text-xs text-[var(--color-tron-text)]">{oven.name}</span>
									<span class="text-xs font-mono text-amber-400">{oven.currentTemperatureC != null ? oven.currentTemperatureC.toFixed(1) + '°C' : '—'}</span>
								</a>
							{/each}
						</div>
					</TronCard>
				{/if}

				<!-- Assay Inventory (collapsible) -->
				{#if cd.assayInventory && cd.assayInventory.length > 0}
					<TronCard>
						<button type="button" class="w-full flex items-center justify-between mb-1" onclick={() => { showAssayInventory = !showAssayInventory; }}>
							<h3 class="text-sm font-semibold text-[var(--color-tron-text)]">Assay Inventory ({cd.assayInventory.length})</h3>
							<svg class="w-4 h-4 text-[var(--color-tron-cyan)] transition-transform {showAssayInventory ? 'rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
						</button>
						{#if showAssayInventory}
							<div class="space-y-1.5 mt-2">
								{#each cd.assayInventory as assay}
									<div class="flex items-center justify-between">
										<div class="min-w-0 flex-1">
											<span class="text-xs text-[var(--color-tron-text)] truncate block">{assay.name}</span>
											<span class="text-[10px] font-mono text-[var(--color-tron-text-secondary)]">{assay.skuCode}</span>
										</div>
										<span class="text-xs font-mono font-bold text-[var(--color-tron-cyan)] ml-2">{assay.fillCount}</span>
									</div>
								{/each}
							</div>
						{/if}
					</TronCard>
				{/if}

				<!-- Daily Throughput (7-day bar chart) -->
				{#if cd.dailyThroughput && cd.dailyThroughput.length > 0}
					{@const maxDay = Math.max(...cd.dailyThroughput.map((d: any) => d.count), 1)}
					<TronCard>
						<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Daily Throughput (7d)</h3>
						<div class="flex items-end gap-1 h-24">
							{#each cd.dailyThroughput as day}
								<div class="flex-1 flex flex-col items-center gap-1">
									<span class="text-[9px] font-mono text-[var(--color-tron-text-secondary)]">{day.count}</span>
									<div class="w-full flex flex-col-reverse rounded-t overflow-hidden" style="height: {Math.max((day.count / maxDay) * 64, 2)}px;">
										{#if day.passed > 0}
											<div style="height: {(day.passed / day.count) * 100}%; background: rgb(34, 197, 94);"></div>
										{/if}
										{#if day.failed > 0}
											<div style="height: {(day.failed / day.count) * 100}%; background: rgb(239, 68, 68);"></div>
										{/if}
										{#if day.pending > 0 || (day.count > 0 && day.passed === 0 && day.failed === 0)}
											<div style="height: {((day.pending || day.count) / day.count) * 100}%; background: var(--color-tron-cyan);"></div>
										{/if}
									</div>
									<span class="text-[8px] text-[var(--color-tron-text-secondary)]">{day.date.slice(5)}</span>
								</div>
							{/each}
						</div>
						<div class="mt-2 flex items-center justify-center gap-4 text-[9px]">
							<div class="flex items-center gap-1"><span class="inline-block h-2 w-2 rounded-sm" style="background: rgb(34, 197, 94);"></span><span class="text-[var(--color-tron-text-secondary)]">Passed</span></div>
							<div class="flex items-center gap-1"><span class="inline-block h-2 w-2 rounded-sm" style="background: rgb(239, 68, 68);"></span><span class="text-[var(--color-tron-text-secondary)]">Failed</span></div>
							<div class="flex items-center gap-1"><span class="inline-block h-2 w-2 rounded-sm" style="background: var(--color-tron-cyan);"></span><span class="text-[var(--color-tron-text-secondary)]">Pending</span></div>
						</div>
					</TronCard>
				{/if}

				<!-- Recent Wax Filling Runs -->
				{#if cd.recentRuns && cd.recentRuns.length > 0}
					<TronCard>
						<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Recent Wax Runs</h3>
						<div class="space-y-1.5">
							{#each cd.recentRuns as run}
								<a href="/cartridge-admin?runId={run.id}" class="block rounded px-1 py-0.5 hover:bg-[var(--color-tron-surface)]/40">
									<div class="flex items-center justify-between text-xs">
										<div class="flex items-center gap-2 min-w-0">
											<span class="rounded px-1.5 py-0.5 text-[10px] font-medium {run.status === 'completed' ? 'bg-[rgba(34,197,94,0.15)] text-green-400' : run.status === 'running' ? 'bg-[rgba(0,255,255,0.15)] text-[var(--color-tron-cyan)]' : run.status === 'aborted' ? 'bg-[rgba(239,68,68,0.15)] text-red-400' : 'bg-[rgba(255,255,255,0.05)] text-[var(--color-tron-text-secondary)]'}">{run.status}</span>
											<span class="text-[var(--color-tron-text)] truncate">{run.robotName}</span>
										</div>
										<div class="flex items-center gap-3 shrink-0">
											{#if run.passedCount > 0 || run.failedCount > 0}
												<div class="flex items-center gap-1.5">
													{#if run.passedCount > 0}
														<span class="text-[10px] font-medium text-green-400">✓{run.passedCount}</span>
													{/if}
													{#if run.failedCount > 0}
														<span class="text-[10px] font-medium text-red-400">✗{run.failedCount}</span>
													{/if}
												</div>
											{/if}
											<span class="font-mono text-[var(--color-tron-cyan)]">{run.cartridgeCount}</span>
											<span class="text-[var(--color-tron-text-secondary)]">{formatDate(run.date)}</span>
										</div>
									</div>
									{#if run.noteCount && run.noteCount > 0}
										<div class="mt-1 flex items-start gap-1.5 text-[10px]">
											<span class="shrink-0 rounded border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-cyan)]/10 px-1 py-0.5 text-[var(--color-tron-cyan)]">
												{run.noteCount} note{run.noteCount === 1 ? '' : 's'}
											</span>
											<span class="truncate text-[var(--color-tron-text-secondary)]" title={run.lastNoteBody}>
												{run.lastNoteBody}
											</span>
										</div>
									{/if}
								</a>
							{/each}
						</div>
					</TronCard>
				{/if}

				<!-- Recent Reagent Filling Runs -->
				{#if cd.recentReagentRuns && cd.recentReagentRuns.length > 0}
					<TronCard>
						<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Recent Reagent Runs</h3>
						<div class="space-y-1.5">
							{#each cd.recentReagentRuns as run}
								<a href="/cartridge-admin?runId={run.id}" class="block rounded px-1 py-0.5 hover:bg-[var(--color-tron-surface)]/40">
									<div class="flex items-center justify-between text-xs">
										<div class="flex items-center gap-2 min-w-0">
											<span class="rounded px-1.5 py-0.5 text-[10px] font-medium {run.status === 'Completed' || run.status === 'completed' ? 'bg-[rgba(34,197,94,0.15)] text-green-400' : run.status === 'Running' || run.status === 'running' ? 'bg-[rgba(0,255,255,0.15)] text-[var(--color-tron-cyan)]' : run.status === 'Aborted' || run.status === 'aborted' || run.status === 'Cancelled' ? 'bg-[rgba(239,68,68,0.15)] text-red-400' : 'bg-[rgba(255,255,255,0.05)] text-[var(--color-tron-text-secondary)]'}">{run.status}</span>
											<span class="text-[var(--color-tron-text)] truncate">{run.robotName}</span>
											<span class="rounded border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/10 px-1 py-0.5 text-[9px] text-[var(--color-tron-cyan)]">{run.assayName}</span>
										</div>
										<div class="flex items-center gap-3 shrink-0">
											{#if run.passedCount > 0 || run.failedCount > 0}
												<div class="flex items-center gap-1.5">
													{#if run.passedCount > 0}
														<span class="text-[10px] font-medium text-green-400">✓{run.passedCount}</span>
													{/if}
													{#if run.failedCount > 0}
														<span class="text-[10px] font-medium text-red-400">✗{run.failedCount}</span>
													{/if}
												</div>
											{/if}
											<span class="font-mono text-[var(--color-tron-cyan)]">{run.cartridgeCount}</span>
											<span class="text-[var(--color-tron-text-secondary)]">{formatDate(run.date)}</span>
										</div>
									</div>
									{#if run.noteCount && run.noteCount > 0}
										<div class="mt-1 flex items-start gap-1.5 text-[10px]">
											<span class="shrink-0 rounded border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-cyan)]/10 px-1 py-0.5 text-[var(--color-tron-cyan)]">
												{run.noteCount} note{run.noteCount === 1 ? '' : 's'}
											</span>
											<span class="truncate text-[var(--color-tron-text-secondary)]" title={run.lastNoteBody}>
												{run.lastNoteBody}
											</span>
										</div>
									{/if}
								</a>
							{/each}
						</div>
					</TronCard>
				{/if}

				<!-- BOM Cost Per Cartridge -->
				{#if cd.bomCostPerCartridge && cd.bomCostPerCartridge.items.length > 0}
					<TronCard>
						<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">BOM Cost / Cartridge</h3>
						<div class="text-center mb-3">
							<span class="text-2xl font-bold text-[var(--color-tron-cyan)]">${cd.bomCostPerCartridge.total.toFixed(2)}</span>
							<div class="text-[10px] text-[var(--color-tron-text-secondary)] uppercase tracking-wider">Total CRT Parts</div>
						</div>
						<div class="space-y-1">
							{#each cd.bomCostPerCartridge.items as item}
								<div class="flex items-center justify-between text-xs">
									<span class="text-[var(--color-tron-text-secondary)] truncate">{item.partNumber}</span>
									<span class="font-mono text-[var(--color-tron-text)] ml-2">${item.unitCost.toFixed(2)}</span>
								</div>
							{/each}
						</div>
					</TronCard>
				{/if}

				<!-- Consumable Stock -->
				{#if cd.consumableStock && cd.consumableStock.length > 0}
					<TronCard>
						<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Consumable Stock</h3>
						<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
							{#each cd.consumableStock as item}
								<div class="text-center">
									<div class="text-xl font-bold text-[var(--color-tron-cyan)]">{item.count}</div>
									<div class="text-[10px] text-[var(--color-tron-text-secondary)] capitalize">{item.type?.replace(/_/g, ' ') ?? '—'}</div>
								</div>
							{/each}
						</div>
					</TronCard>
				{/if}

				<!-- Expiring + Recent Row -->
				<div class="grid gap-4 lg:grid-cols-2">
					{#if cd.expiringSoon.length > 0}
						<TronCard>
							<h3 class="mb-3 text-sm font-semibold text-amber-400">⚠ Expiring Soon</h3>
							<div class="space-y-1.5">
								{#each cd.expiringSoon as c}
									{@const days = daysUntil(c.expirationDate)}
									<a href="/cartridges/{c.id}" class="flex items-center justify-between rounded px-2 py-1.5 hover:bg-[var(--color-tron-surface)] transition-colors">
										<div class="flex items-center gap-2">
											<span class="font-mono text-xs text-[var(--color-tron-text)]">{c.id.slice(-8)}</span>
											<span class="text-xs text-[var(--color-tron-text-secondary)]">{c.assay}</span>
										</div>
										<span class="text-xs font-mono {days <= 7 ? 'text-red-400 font-bold' : 'text-amber-400'}">{days}d</span>
									</a>
								{/each}
							</div>
						</TronCard>
					{/if}

					<TronCard>
						<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Recent Activity</h3>
						<div class="space-y-1">
							{#each cd.recentActivity as c}
								<a href="/cartridges/{c.id}" class="flex items-center justify-between rounded px-2 py-1.5 hover:bg-[var(--color-tron-surface)] transition-colors">
									<div class="flex items-center gap-2">
										<div class="h-2 w-2 rounded-full" style="background: {phaseColor(c.phase)}"></div>
										<span class="font-mono text-xs text-[var(--color-tron-text)]">{c.id.slice(-8)}</span>
									</div>
									<div class="flex items-center gap-2">
										<span class="text-[10px] text-[var(--color-tron-text-secondary)] capitalize">{c.phase?.replace(/_/g, ' ') ?? '—'}</span>
										{#if c.waxQc}
											<TronBadge variant={c.waxQc === 'Accepted' ? 'success' : c.waxQc === 'Rejected' ? 'error' : 'neutral'}>
												{c.waxQc === 'Accepted' ? '✓' : c.waxQc === 'Rejected' ? '✕' : '?'}
											</TronBadge>
										{/if}
										<span class="text-[10px] text-[var(--color-tron-text-secondary)]">{formatRelative(c.updatedAt)}</span>
									</div>
								</a>
							{:else}
								<p class="text-center text-xs text-[var(--color-tron-text-secondary)] py-4">No activity yet.</p>
							{/each}
						</div>
					</TronCard>
				</div>

			</div>
		{:else if !cartCollapsed}
			<div class="px-4 pb-4">
				<p class="text-sm text-[var(--color-tron-text-secondary)]">Cartridge data unavailable.</p>
			</div>
		{/if}
</div>
