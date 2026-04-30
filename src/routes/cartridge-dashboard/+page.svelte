<script lang="ts">
	import { TronCard, TronBadge } from '$lib/components/ui';

	let { data } = $props();

	const phaseColors: Record<string, string> = {
		backing: '#6366f1',
		wax_filled: '#8b5cf6',
		wax_qc: '#a78bfa',
		wax_stored: '#7c3aed',
		reagent_filled: '#06b6d4',
		inspected: '#22d3ee',
		sealed: '#14b8a6',
		cured: '#10b981',
		stored: '#059669',
		released: '#34d399',
		shipped: '#4ade80',
		assay_loaded: '#f59e0b',
		testing: '#f97316',
		completed: '#22c55e'
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

	function formatDate(date: string | Date | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
	}

	function daysUntil(date: string | Date | null): number {
		if (!date) return 999;
		return Math.ceil((new Date(date).getTime() - Date.now()) / 86400000);
	}

	// Pipeline total for percentage calc
	const pipelineTotal = $derived(data.pipeline.reduce((s: number, p: { count: number }) => s + p.count, 0));
	const maxPhaseCount = $derived(Math.max(...data.pipeline.map((p: { count: number }) => p.count), 1));

	// QC totals
	const waxTotal = $derived((data.waxQc['Accepted'] ?? 0) + (data.waxQc['Rejected'] ?? 0));
	const reagentTotal = $derived((data.reagentInspection['Accepted'] ?? 0) + (data.reagentInspection['Rejected'] ?? 0));

	// Assay section toggle
	let assayExpanded = $state(false);

	// QC yield rates
	const waxYield = $derived(() => {
		return waxTotal > 0 ? (((data.waxQc['Accepted'] ?? 0) / waxTotal) * 100).toFixed(1) : '—';
	});
	const reagentYield = $derived(() => {
		return reagentTotal > 0 ? (((data.reagentInspection['Accepted'] ?? 0) / reagentTotal) * 100).toFixed(1) : '—';
	});

	function runStatusClass(status: string): string {
		const s = status.toLowerCase();
		if (s === 'completed' || s === 'complete') return 'text-emerald-300 bg-emerald-900/40 border-emerald-500/30';
		if (s === 'aborted' || s === 'cancelled') return 'text-red-300 bg-red-900/40 border-red-500/30';
		if (s === 'running' || s === 'in progress') return 'text-green-300 bg-green-900/40 border-green-500/30';
		return 'text-[var(--color-tron-text-secondary)] bg-[var(--color-tron-surface)] border-[var(--color-tron-border)]';
	}
</script>

<div class="space-y-5">
	<!-- Header -->
	<div>
		<h2 class="text-xl font-bold text-[var(--color-tron-text)]">Cartridge Dashboard</h2>
		<p class="text-xs text-[var(--color-tron-text-secondary)]">Manufacturing pipeline &amp; inventory at a glance</p>
	</div>

	<!-- Top Stats Row -->
	<div class="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
		<TronCard>
			<div class="text-center">
				<div class="text-2xl font-bold text-[var(--color-tron-cyan)]">{data.totalMfg}</div>
				<div class="text-[10px] text-[var(--color-tron-text-secondary)] uppercase tracking-wider">Total Active</div>
			</div>
		</TronCard>
		<TronCard>
			<div class="text-center">
				<div class="text-2xl font-bold text-green-400">{data.weeklyProduction}</div>
				<div class="text-[10px] text-[var(--color-tron-text-secondary)] uppercase tracking-wider">This Week</div>
			</div>
		</TronCard>
		<TronCard>
			<div class="text-center">
				<div class="text-2xl font-bold" style="color: {(waxYield() !== '—' && parseFloat(waxYield()) >= 90) ? 'var(--color-tron-green)' : 'var(--color-tron-orange)'}">
					{waxYield()}{waxYield() !== '—' ? '%' : ''}
				</div>
				<div class="text-[10px] text-[var(--color-tron-text-secondary)] uppercase tracking-wider">Wax QC Yield</div>
			</div>
		</TronCard>
		<TronCard>
			<div class="text-center">
				<div class="text-2xl font-bold" style="color: {(reagentYield() !== '—' && parseFloat(reagentYield()) >= 90) ? 'var(--color-tron-green)' : 'var(--color-tron-orange)'}">
					{reagentYield()}{reagentYield() !== '—' ? '%' : ''}
				</div>
				<div class="text-[10px] text-[var(--color-tron-text-secondary)] uppercase tracking-wider">Reagent Yield</div>
			</div>
		</TronCard>
		{#if data.expiringCount > 0}
			<TronCard>
				<div class="text-center">
					<div class="text-2xl font-bold text-amber-400">{data.expiringCount}</div>
					<div class="text-[10px] text-[var(--color-tron-text-secondary)] uppercase tracking-wider">Expiring &lt;30d</div>
				</div>
			</TronCard>
		{:else}
			<TronCard>
				<div class="text-center">
					<div class="text-2xl font-bold text-red-400">{data.totalVoided}</div>
					<div class="text-[10px] text-[var(--color-tron-text-secondary)] uppercase tracking-wider">Voided</div>
				</div>
			</TronCard>
		{/if}
	</div>

	<!-- Pipeline + QC Row -->
	<div class="grid gap-4 lg:grid-cols-3">
		<!-- Manufacturing Pipeline (spans 2 cols) -->
		<div class="lg:col-span-2">
			<TronCard>
				<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Manufacturing Pipeline</h3>
				<div class="space-y-1.5">
					{#each data.pipeline.filter((p: { count: number }) => p.count > 0) as stage}
						<div class="flex items-center gap-2">
							<span class="w-24 truncate text-xs text-[var(--color-tron-text-secondary)]">{stage.label}</span>
							<div class="flex-1 h-5 rounded-sm bg-[var(--color-tron-surface)] overflow-hidden">
								<div
									class="h-full rounded-sm flex items-center px-1.5 transition-all"
									style="width: {Math.max((stage.count / maxPhaseCount) * 100, 3)}%; background: {phaseColor(stage.phase)};"
								>
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

		<!-- QC & Assay Breakdown -->
		<div class="space-y-4">
			<!-- QC Summary -->
			<TronCard>
				<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">QC Summary</h3>
				<div class="space-y-3">
					<div>
						<div class="flex items-center justify-between mb-1">
							<span class="text-xs text-[var(--color-tron-text-secondary)]">Wax QC</span>
							<span class="text-xs font-mono text-[var(--color-tron-text)]">
								<span class="text-green-400">{data.waxQc['Accepted'] ?? 0}✓</span>
								<span class="text-red-400 ml-1">{data.waxQc['Rejected'] ?? 0}✕</span>
								{#if data.waxQc['Pending']}
									<span class="text-amber-400 ml-1">{data.waxQc['Pending']}?</span>
								{/if}
							</span>
						</div>
						{#if waxTotal > 0}
							<div class="flex h-2 rounded-full overflow-hidden bg-[var(--color-tron-surface)]">
								<div class="bg-green-500" style="width: {((data.waxQc['Accepted'] ?? 0) / waxTotal) * 100}%"></div>
								<div class="bg-red-500" style="width: {((data.waxQc['Rejected'] ?? 0) / waxTotal) * 100}%"></div>
							</div>
						{/if}
					</div>
					<div>
						<div class="flex items-center justify-between mb-1">
							<span class="text-xs text-[var(--color-tron-text-secondary)]">Reagent Insp.</span>
							<span class="text-xs font-mono text-[var(--color-tron-text)]">
								<span class="text-green-400">{data.reagentInspection['Accepted'] ?? 0}✓</span>
								<span class="text-red-400 ml-1">{data.reagentInspection['Rejected'] ?? 0}✕</span>
								{#if data.reagentInspection['Pending']}
									<span class="text-amber-400 ml-1">{data.reagentInspection['Pending']}?</span>
								{/if}
							</span>
						</div>
						{#if reagentTotal > 0}
							<div class="flex h-2 rounded-full overflow-hidden bg-[var(--color-tron-surface)]">
								<div class="bg-green-500" style="width: {((data.reagentInspection['Accepted'] ?? 0) / reagentTotal) * 100}%"></div>
								<div class="bg-red-500" style="width: {((data.reagentInspection['Rejected'] ?? 0) / reagentTotal) * 100}%"></div>
							</div>
						{/if}
					</div>
				</div>
			</TronCard>

			<!-- Assay Breakdown (collapsible) -->
			{#if data.assayBreakdown.length > 0}
				<TronCard>
					<button
						class="w-full flex items-center justify-between text-left"
						onclick={() => assayExpanded = !assayExpanded}
					>
						<h3 class="text-sm font-semibold text-[var(--color-tron-text)]">Assay Inventory ({data.assayBreakdown.length} types)</h3>
						<span class="text-xs text-[var(--color-tron-text-secondary)] transition-transform" style="display:inline-block; transform: rotate({assayExpanded ? 180 : 0}deg)">▼</span>
					</button>
					{#if assayExpanded}
						<div class="space-y-2 mt-3">
							{#each data.assayBreakdown as assay}
								<div class="flex items-center justify-between">
									<span class="text-xs text-[var(--color-tron-text)] truncate">{assay.name}</span>
									<span class="text-xs font-mono font-bold text-[var(--color-tron-cyan)] ml-2">{assay.count}</span>
								</div>
							{/each}
						</div>
					{/if}
				</TronCard>
			{/if}

			<!-- Fridge Storage -->
			{#if data.storageDistribution.length > 0}
				<TronCard>
					<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Fridge Storage</h3>
					<div class="space-y-1.5">
						{#each data.storageDistribution as loc}
							<a href="/equipment/location/{loc.locationId}" class="flex items-center justify-between rounded px-2 py-1.5 hover:bg-[var(--color-tron-surface)] transition-colors">
								<div class="flex items-center gap-2">
									<span class="text-sm">🧊</span>
									<span class="text-xs text-[var(--color-tron-text)]">{loc.locationName}</span>
								</div>
								<div class="flex items-center gap-2">
									<span class="text-xs font-mono font-bold text-[var(--color-tron-cyan)]">{loc.count}</span>
									{#if loc.capacity}
										<span class="text-[10px] text-[var(--color-tron-text-secondary)]">/ {loc.capacity}</span>
									{/if}
								</div>
							</a>
						{/each}
					</div>
				</TronCard>
			{/if}

			<!-- Oven Storage -->
			{#if data.ovenDistribution.length > 0}
				<TronCard>
					<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Ovens</h3>
					<div class="space-y-1.5">
						{#each data.ovenDistribution as loc}
							<a href="/equipment/location/{loc.locationId}" class="flex items-center justify-between rounded px-2 py-1.5 hover:bg-[var(--color-tron-surface)] transition-colors">
								<div class="flex items-center gap-2">
									<span class="text-sm">🔥</span>
									<span class="text-xs text-[var(--color-tron-text)]">{loc.locationName}</span>
								</div>
								<div class="flex items-center gap-2">
									<span class="text-xs font-mono font-bold text-[var(--color-tron-cyan)]">{loc.count}</span>
									{#if loc.capacity}
										<span class="text-[10px] text-[var(--color-tron-text-secondary)]">/ {loc.capacity}</span>
									{/if}
								</div>
							</a>
						{/each}
					</div>
				</TronCard>
			{/if}
		</div>
	</div>

	<!-- Last 7 days run history -->
	<TronCard>
		<div class="mb-3 flex items-center justify-between">
			<div>
				<h3 class="text-sm font-semibold text-[var(--color-tron-text)]">Recent Runs (last 7 days)</h3>
				<p class="text-[10px] text-[var(--color-tron-text-secondary)]">Click a run ID to see every cartridge in it</p>
			</div>
			<a href="/manufacturing/opentrons/history" class="text-xs text-[var(--color-tron-cyan)] hover:underline">
				Full history →
			</a>
		</div>
		{#if data.recentRuns.length === 0}
			<p class="text-center text-xs text-[var(--color-tron-text-secondary)] py-4">No wax or reagent runs in the last 7 days.</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-xs">
					<thead>
						<tr class="border-b border-[var(--color-tron-border)] text-left text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">
							<th class="px-2 py-1.5 font-medium">Run ID</th>
							<th class="px-2 py-1.5 font-medium">Type</th>
							<th class="px-2 py-1.5 font-medium">Status</th>
							<th class="px-2 py-1.5 font-medium">Robot</th>
							<th class="px-2 py-1.5 font-medium">Operator</th>
							<th class="px-2 py-1.5 font-medium">Assay</th>
							<th class="px-2 py-1.5 text-right font-medium">Carts</th>
							<th class="px-2 py-1.5 font-medium">Started</th>
						</tr>
					</thead>
					<tbody>
						{#each data.recentRuns as run (run.runId + run.processType)}
							<tr class="border-b border-[var(--color-tron-border)]/30 hover:bg-[var(--color-tron-surface)]/40">
								<td class="px-2 py-1.5 font-mono">
									<a href="/cartridge-admin?runId={run.runId}"
										class="text-[var(--color-tron-cyan)] hover:underline"
										title="Show all cartridges in this run"
									>{run.runId}</a>
								</td>
								<td class="px-2 py-1.5">
									<span class="rounded border px-1.5 py-0.5 text-[10px] font-medium {run.processType === 'wax' ? 'border-amber-500/30 bg-amber-900/40 text-amber-300' : 'border-blue-500/30 bg-blue-900/40 text-blue-300'}">
										{run.processType === 'wax' ? 'Wax' : 'Reagent'}
									</span>
								</td>
								<td class="px-2 py-1.5">
									<span class="rounded border px-1.5 py-0.5 text-[10px] font-medium {runStatusClass(run.status)}">
										{run.status}
									</span>
								</td>
								<td class="px-2 py-1.5 text-[var(--color-tron-text-secondary)]">{run.robotName ?? '—'}</td>
								<td class="px-2 py-1.5 text-[var(--color-tron-text-secondary)]">{run.operatorName ?? '—'}</td>
								<td class="px-2 py-1.5 text-[var(--color-tron-text-secondary)]">{run.assayName ?? '—'}</td>
								<td class="px-2 py-1.5 text-right font-mono text-[var(--color-tron-text)]">{run.cartridgeCount}</td>
								<td class="px-2 py-1.5 text-[var(--color-tron-text-secondary)]">{formatRelative(run.startTime ?? run.createdAt)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</TronCard>

	<!-- Expiring + Recent Row -->
	<div class="grid gap-4 lg:grid-cols-2">
		<!-- Expiring Soon -->
		{#if data.expiringSoon.length > 0}
			<TronCard>
				<h3 class="mb-3 text-sm font-semibold text-amber-400">⚠ Expiring Soon</h3>
				<div class="space-y-1.5">
					{#each data.expiringSoon as c}
						{@const days = daysUntil(c.expirationDate)}
						<a href="/cartridges/{c.id}" class="flex items-center justify-between rounded px-2 py-1.5 hover:bg-[var(--color-tron-surface)] transition-colors">
							<div class="flex items-center gap-2">
								<span class="font-mono text-xs text-[var(--color-tron-text)]">{c.id.slice(-8)}</span>
								<span class="text-xs text-[var(--color-tron-text-secondary)]">{c.assay}</span>
							</div>
							<span class="text-xs font-mono {days <= 7 ? 'text-red-400 font-bold' : 'text-amber-400'}">
								{days}d
							</span>
						</a>
					{/each}
				</div>
			</TronCard>
		{/if}

		<!-- Recent Activity -->
		<TronCard>
			<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Recent Activity</h3>
			<div class="space-y-1">
				{#each data.recentActivity as c}
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

	<!-- Lab Cartridges (if any) -->
	{#if data.lab.total > 0}
		<TronCard>
			<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Lab Cartridges</h3>
			<div class="grid gap-3 sm:grid-cols-3">
				<div class="text-center">
					<div class="text-xl font-bold text-[var(--color-tron-cyan)]">{data.lab.total}</div>
					<div class="text-[10px] text-[var(--color-tron-text-secondary)] uppercase">Total</div>
				</div>
				{#each data.lab.statusCounts as s}
					<div class="text-center">
						<div class="text-xl font-bold text-[var(--color-tron-text)]">{s.count}</div>
						<div class="text-[10px] text-[var(--color-tron-text-secondary)] capitalize">{s.status?.replace(/_/g, ' ') ?? '—'}</div>
					</div>
				{/each}
			</div>
		</TronCard>
	{/if}
</div>
