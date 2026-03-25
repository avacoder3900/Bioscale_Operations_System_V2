<script lang="ts">
	import { goto } from '$app/navigation';

	interface Cartridge {
		id: string;
		currentPhase: string | null;
		lotId: string | null;
		robotName: string | null;
		deckId: string | null;
		waxRunStart: string | null;
		waxRunEnd: string | null;
		waxQcStatus: string | null;
		assayType: string | null;
		topSealAt: string | null;
		storedAt: string | null;
		operator: string | null;
		storageType: 'wax' | 'reagent' | 'unknown';
	}

	interface WaxRun {
		id: string;
		status: string | null;
		operatorName: string | null;
		runStartTime: string | null;
		runEndTime: string | null;
		createdAt: string | null;
		cartridgeCount: number;
	}

	interface Props {
		data: {
			location: {
				id: string;
				name: string;
				barcode: string | null;
				locationType: string;
				capacity: number | null;
				isActive: boolean;
				createdAt: string | null;
			};
			cartridges: Cartridge[];
			waxRuns: WaxRun[];
			stats: {
				total: number;
				waxCount: number;
				reagentCount: number;
				utilization: number | null;
			};
		};
	}

	let { data }: Props = $props();

	type SortKey = 'id' | 'phase' | 'lotId' | 'assayType' | 'waxQcStatus' | 'storedAt' | 'operator';
	let sortKey = $state<SortKey>('storedAt');
	let sortDir = $state<1 | -1>(-1);
	let filterType = $state<'all' | 'wax' | 'reagent'>('all');

	function toggleSort(key: SortKey) {
		if (sortKey === key) {
			sortDir = sortDir === 1 ? -1 : 1;
		} else {
			sortKey = key;
			sortDir = -1;
		}
	}

	let filteredCartridges = $derived.by(() => {
		let list = data.cartridges.slice();
		if (filterType !== 'all') {
			list = list.filter((c) => c.storageType === filterType);
		}
		list.sort((a, b) => {
			const av = (a as any)[sortKey] ?? '';
			const bv = (b as any)[sortKey] ?? '';
			if (av < bv) return -sortDir;
			if (av > bv) return sortDir;
			return 0;
		});
		return list;
	});

	const isFridge = $derived(data.location.locationType === 'fridge');
	const utilizationPct = $derived(data.stats.utilization ?? 0);

	function phaseBadge(phase: string | null): string {
		switch (phase) {
			case 'wax_stored': return 'bg-amber-900/30 text-amber-300 border-amber-500/30';
			case 'wax_filled': return 'bg-yellow-900/30 text-yellow-300 border-yellow-500/30';
			case 'reagent_filled': return 'bg-purple-900/30 text-purple-300 border-purple-500/30';
			case 'stored': return 'bg-green-900/30 text-green-300 border-green-500/30';
			case 'inspected': return 'bg-blue-900/30 text-blue-300 border-blue-500/30';
			case 'sealed': return 'bg-cyan-900/30 text-cyan-300 border-cyan-500/30';
			case 'cured': return 'bg-orange-900/30 text-orange-300 border-orange-500/30';
			default: return 'bg-slate-800 text-slate-300 border-slate-600';
		}
	}

	function qcBadge(status: string | null): string {
		switch (status) {
			case 'Accepted': return 'text-green-300 bg-green-900/30 border-green-500/30';
			case 'Rejected': return 'text-red-300 bg-red-900/30 border-red-500/30';
			case 'Pending': return 'text-amber-300 bg-amber-900/30 border-amber-500/30';
			default: return 'text-slate-400 bg-slate-800 border-slate-600';
		}
	}

	function formatDate(iso: string | null): string {
		if (!iso) return '—';
		const d = new Date(iso);
		return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
	}

	function shortId(id: string): string {
		return id.slice(-8).toUpperCase();
	}

	function sortIcon(key: SortKey): string {
		if (sortKey !== key) return '↕';
		return sortDir === 1 ? '↑' : '↓';
	}

	function runStatusBadge(status: string | null): string {
		switch (status) {
			case 'completed': return 'text-green-300 bg-green-900/30';
			case 'running': return 'text-cyan-300 bg-cyan-900/30';
			case 'aborted': return 'text-red-300 bg-red-900/30';
			default: return 'text-slate-400 bg-slate-800';
		}
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
		<div class="flex items-center gap-4">
			<!-- Icon -->
			<div class="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl {isFridge ? 'bg-blue-500/20 shadow-[0_0_20px_rgba(59,130,246,0.15)]' : 'bg-orange-500/20 shadow-[0_0_20px_rgba(249,115,22,0.15)]'}">
				{#if isFridge}
					<svg class="h-8 w-8 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
						<path stroke-linecap="round" stroke-linejoin="round" d="M6 2h12a1 1 0 011 1v18a1 1 0 01-1 1H6a1 1 0 01-1-1V3a1 1 0 011-1zm0 12h12M10 6h1" />
					</svg>
				{:else}
					<svg class="h-8 w-8 text-orange-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
						<path stroke-linecap="round" stroke-linejoin="round" d="M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z" />
						<path stroke-linecap="round" stroke-linejoin="round" d="M9.879 16.121A3 3 0 1012.015 11L11 14H9c0 .768.293 1.536.879 2.121z" />
					</svg>
				{/if}
			</div>
			<div>
				<div class="flex items-center gap-2">
					<h1 class="text-2xl font-bold {isFridge ? 'text-blue-100' : 'text-orange-100'}">{data.location.name}</h1>
					<span class="inline-flex rounded border px-2 py-0.5 text-[10px] font-bold uppercase {isFridge ? 'border-blue-500/40 bg-blue-900/30 text-blue-300' : 'border-orange-500/40 bg-orange-900/30 text-orange-300'}">
						{data.location.locationType}
					</span>
					{#if !data.location.isActive}
						<span class="inline-flex rounded border border-red-500/40 bg-red-900/30 px-2 py-0.5 text-[10px] font-bold uppercase text-red-300">Inactive</span>
					{/if}
				</div>
				{#if data.location.barcode}
					<p class="mt-0.5 font-mono text-sm text-[var(--color-tron-text-secondary)]">{data.location.barcode}</p>
				{/if}
			</div>
		</div>
		<a href="/equipment/fridges-ovens" class="flex items-center gap-1 text-sm text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-cyan)]">
			<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
			</svg>
			All Locations
		</a>
	</div>

	<!-- Stats row -->
	<div class="grid grid-cols-2 gap-3 sm:grid-cols-5">
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 text-center">
			<div class="text-3xl font-bold text-[var(--color-tron-text)]">{data.stats.total}</div>
			<div class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">Total Stored</div>
		</div>
		{#if data.location.capacity}
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 text-center">
				<div class="text-3xl font-bold text-[var(--color-tron-text)]">{data.location.capacity}</div>
				<div class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">Capacity</div>
			</div>
			<div class="rounded-lg border {utilizationPct >= 90 ? 'border-red-500/30 bg-red-900/10' : utilizationPct >= 70 ? 'border-amber-500/30 bg-amber-900/10' : 'border-green-500/30 bg-green-900/10'} p-4 text-center">
				<div class="text-3xl font-bold {utilizationPct >= 90 ? 'text-red-400' : utilizationPct >= 70 ? 'text-amber-400' : 'text-green-400'}">{utilizationPct}%</div>
				<div class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">Utilization</div>
			</div>
		{/if}
		<div class="rounded-lg border border-amber-500/30 bg-amber-900/10 p-4 text-center">
			<div class="text-3xl font-bold text-amber-400">{data.stats.waxCount}</div>
			<div class="mt-1 text-xs text-amber-300/70">Wax Stored</div>
		</div>
		<div class="rounded-lg border border-purple-500/30 bg-purple-900/10 p-4 text-center">
			<div class="text-3xl font-bold text-purple-400">{data.stats.reagentCount}</div>
			<div class="mt-1 text-xs text-purple-300/70">Reagent Stored</div>
		</div>
	</div>

	<!-- Utilization bar (if capacity set) -->
	{#if data.location.capacity && data.stats.total > 0}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
			<div class="mb-2 flex items-center justify-between text-xs text-[var(--color-tron-text-secondary)]">
				<span>Capacity utilization</span>
				<span class="font-mono font-bold">{data.stats.total}/{data.location.capacity}</span>
			</div>
			<div class="h-3 overflow-hidden rounded-full bg-[var(--color-tron-bg)]">
				<div
					class="h-full rounded-full transition-all"
					style="width: {Math.min(utilizationPct, 100)}%; background: {utilizationPct >= 90 ? '#f87171' : utilizationPct >= 70 ? '#fbbf24' : isFridge ? '#60a5fa' : '#fb923c'};"
				></div>
			</div>
		</div>
	{/if}

	<!-- Inventory table -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
		<div class="flex flex-col gap-3 border-b border-[var(--color-tron-border)] p-4 sm:flex-row sm:items-center sm:justify-between">
			<h2 class="text-sm font-semibold text-[var(--color-tron-text)]">
				Inventory
				<span class="ml-1 text-[var(--color-tron-text-secondary)]">({filteredCartridges.length})</span>
			</h2>
			<div class="flex items-center gap-2">
				<span class="text-xs text-[var(--color-tron-text-secondary)]">Show:</span>
				<button type="button" onclick={() => (filterType = 'all')}
					class="rounded px-2.5 py-1 text-xs font-medium transition-colors {filterType === 'all' ? 'bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]' : 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}">
					All
				</button>
				<button type="button" onclick={() => (filterType = 'wax')}
					class="rounded px-2.5 py-1 text-xs font-medium transition-colors {filterType === 'wax' ? 'bg-amber-900/30 text-amber-300' : 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}">
					Wax
				</button>
				<button type="button" onclick={() => (filterType = 'reagent')}
					class="rounded px-2.5 py-1 text-xs font-medium transition-colors {filterType === 'reagent' ? 'bg-purple-900/30 text-purple-300' : 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}">
					Reagent
				</button>
			</div>
		</div>

		{#if filteredCartridges.length === 0}
			<div class="p-8 text-center">
				<div class="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-tron-surface)]">
					<svg class="h-6 w-6 text-[var(--color-tron-text-secondary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
						<path stroke-linecap="round" stroke-linejoin="round" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
					</svg>
				</div>
				<p class="text-sm text-[var(--color-tron-text-secondary)]">No cartridges stored here</p>
			</div>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-xs">
					<thead>
						<tr class="border-b border-[var(--color-tron-border)]/50 text-[var(--color-tron-text-secondary)]">
							<th class="cursor-pointer select-none px-4 py-2 text-left font-medium uppercase tracking-wider hover:text-[var(--color-tron-text)]" onclick={() => toggleSort('id')}>
								ID <span class="font-mono text-[10px]">{sortIcon('id')}</span>
							</th>
							<th class="cursor-pointer select-none px-4 py-2 text-left font-medium uppercase tracking-wider hover:text-[var(--color-tron-text)]" onclick={() => toggleSort('phase')}>
								Phase <span class="font-mono text-[10px]">{sortIcon('phase')}</span>
							</th>
							<th class="cursor-pointer select-none px-4 py-2 text-left font-medium uppercase tracking-wider hover:text-[var(--color-tron-text)]" onclick={() => toggleSort('lotId')}>
								Lot ID <span class="font-mono text-[10px]">{sortIcon('lotId')}</span>
							</th>
							<th class="cursor-pointer select-none px-4 py-2 text-left font-medium uppercase tracking-wider hover:text-[var(--color-tron-text)]" onclick={() => toggleSort('assayType')}>
								Assay <span class="font-mono text-[10px]">{sortIcon('assayType')}</span>
							</th>
							<th class="cursor-pointer select-none px-4 py-2 text-left font-medium uppercase tracking-wider hover:text-[var(--color-tron-text)]" onclick={() => toggleSort('waxQcStatus')}>
								QC <span class="font-mono text-[10px]">{sortIcon('waxQcStatus')}</span>
							</th>
							<th class="cursor-pointer select-none px-4 py-2 text-left font-medium uppercase tracking-wider hover:text-[var(--color-tron-text)]" onclick={() => toggleSort('storedAt')}>
								Stored <span class="font-mono text-[10px]">{sortIcon('storedAt')}</span>
							</th>
							<th class="cursor-pointer select-none px-4 py-2 text-left font-medium uppercase tracking-wider hover:text-[var(--color-tron-text)]" onclick={() => toggleSort('operator')}>
								Operator <span class="font-mono text-[10px]">{sortIcon('operator')}</span>
							</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-[var(--color-tron-border)]/30">
						{#each filteredCartridges as cart (cart.id)}
							<tr
								class="cursor-pointer transition-colors hover:bg-[var(--color-tron-cyan)]/5"
								onclick={() => goto(`/cartridges/${cart.id}`)}
								role="link"
								tabindex="0"
								onkeydown={(e) => e.key === 'Enter' && goto(`/cartridges/${cart.id}`)}
							>
								<td class="px-4 py-2.5">
									<span class="font-mono text-[var(--color-tron-cyan)]">…{shortId(cart.id)}</span>
								</td>
								<td class="px-4 py-2.5">
									{#if cart.currentPhase}
										<span class="inline-flex rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase {phaseBadge(cart.currentPhase)}">
											{cart.currentPhase.replace(/_/g, ' ')}
										</span>
									{:else}
										<span class="text-[var(--color-tron-text-secondary)]">—</span>
									{/if}
								</td>
								<td class="px-4 py-2.5">
									<span class="font-mono text-[var(--color-tron-text)]">{cart.lotId ?? '—'}</span>
								</td>
								<td class="px-4 py-2.5 text-[var(--color-tron-text)]">{cart.assayType ?? '—'}</td>
								<td class="px-4 py-2.5">
									{#if cart.waxQcStatus}
										<span class="inline-flex rounded border px-1.5 py-0.5 text-[10px] font-bold {qcBadge(cart.waxQcStatus)}">
											{cart.waxQcStatus}
										</span>
									{:else}
										<span class="text-[var(--color-tron-text-secondary)]">—</span>
									{/if}
								</td>
								<td class="px-4 py-2.5 text-[var(--color-tron-text-secondary)]">{formatDate(cart.storedAt)}</td>
								<td class="px-4 py-2.5 text-[var(--color-tron-text)]">{cart.operator ?? '—'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>

	<!-- History section -->
	{#if data.waxRuns.length > 0}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
			<div class="border-b border-[var(--color-tron-border)] p-4">
				<h2 class="text-sm font-semibold text-[var(--color-tron-text)]">Recent Run History</h2>
				<p class="mt-0.5 text-xs text-[var(--color-tron-text-secondary)]">Wax filling runs associated with this location</p>
			</div>
			<div class="divide-y divide-[var(--color-tron-border)]/30">
				{#each data.waxRuns as run (run.id)}
					<div class="flex items-start gap-4 p-4">
						<!-- Timeline dot -->
						<div class="relative mt-1 flex flex-col items-center">
							<div class="h-2.5 w-2.5 rounded-full {run.status === 'completed' ? 'bg-green-400' : run.status === 'aborted' ? 'bg-red-400' : 'bg-cyan-400'}"></div>
						</div>
						<div class="min-w-0 flex-1">
							<div class="flex flex-wrap items-center gap-2">
								<span class="font-mono text-xs text-[var(--color-tron-text-secondary)]">…{run.id.slice(-8).toUpperCase()}</span>
								<span class="inline-flex rounded px-1.5 py-0.5 text-[10px] font-bold uppercase {runStatusBadge(run.status)}">
									{run.status ?? 'unknown'}
								</span>
								{#if run.cartridgeCount > 0}
									<span class="text-xs text-[var(--color-tron-text-secondary)]">{run.cartridgeCount} cartridges</span>
								{/if}
							</div>
							<div class="mt-1 flex flex-wrap gap-3 text-xs text-[var(--color-tron-text-secondary)]">
								{#if run.runStartTime}
									<span>Started: {formatDate(run.runStartTime)}</span>
								{/if}
								{#if run.runEndTime}
									<span>Ended: {formatDate(run.runEndTime)}</span>
								{/if}
								{#if run.operatorName}
									<span>Operator: <span class="text-[var(--color-tron-text)]">{run.operatorName}</span></span>
								{/if}
							</div>
						</div>
						<div class="shrink-0 text-xs text-[var(--color-tron-text-secondary)]">
							{formatDate(run.createdAt)}
						</div>
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Location metadata -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
		<h2 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Location Details</h2>
		<dl class="grid grid-cols-2 gap-3 sm:grid-cols-4 text-xs">
			<div>
				<dt class="text-[var(--color-tron-text-secondary)]">Location ID</dt>
				<dd class="mt-0.5 font-mono text-[var(--color-tron-text)]">{data.location.id}</dd>
			</div>
			<div>
				<dt class="text-[var(--color-tron-text-secondary)]">Barcode</dt>
				<dd class="mt-0.5 font-mono text-[var(--color-tron-text)]">{data.location.barcode ?? '—'}</dd>
			</div>
			<div>
				<dt class="text-[var(--color-tron-text-secondary)]">Capacity</dt>
				<dd class="mt-0.5 text-[var(--color-tron-text)]">{data.location.capacity ?? '—'}</dd>
			</div>
			<div>
				<dt class="text-[var(--color-tron-text-secondary)]">Registered</dt>
				<dd class="mt-0.5 text-[var(--color-tron-text)]">{formatDate(data.location.createdAt)}</dd>
			</div>
		</dl>
	</div>
</div>
