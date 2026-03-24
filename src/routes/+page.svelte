<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { TronCard, TronButton, TronBadge } from '$lib/components/ui';
	import SpuStatusBadge from '$lib/components/spu/SpuStatusBadge.svelte';
	import SpuDeviceStateBadge from '$lib/components/spu/SpuDeviceStateBadge.svelte';
	import type { Spu } from '$lib/server/db/schema';
	import { SvelteSet } from 'svelte/reactivity';

	let { data, form } = $props();

	// Panel collapse state
	let spuCollapsed = $state(false);
	let cartCollapsed = $state(false);

	// Phase colors for manufacturing pipeline
	const phaseColors: Record<string, string> = {
		backing: '#6366f1', wax_filled: '#8b5cf6', wax_qc: '#a78bfa', wax_stored: '#7c3aed',
		reagent_filled: '#06b6d4', inspected: '#22d3ee', sealed: '#14b8a6', cured: '#10b981',
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

	function getCartStatusColor(status: string): string {
		switch (status?.toLowerCase()) {
			case 'active': case 'available': return 'var(--color-tron-green)';
			case 'in_use': case 'in use': return 'var(--color-tron-cyan)';
			case 'depleted': case 'expired': return 'var(--color-tron-orange)';
			case 'quarantine': case 'disposed': return 'var(--color-tron-red)';
			default: return 'var(--color-tron-text-secondary)';
		}
	}

	function formatDate(date: string | Date | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleDateString();
	}

	let barcodeInput = $state('');
	let udiInput = $state('');
	let showRegisterForm = $state(false);
	let registering = $state(false);
	let registerSuccess = $state<{ spuId: string } | null>(null);
	let showCreateModal = $state(false);
	let creating = $state(false);
	let syncing = $state(false);
	let assigning = $state(false);
	let expiringExpanded = $state(false);
	let costExpanded = $state(false);
	let expandedSpuId = $state<string | null>(null);
	let collapsedSections = $state<Record<string, boolean>>({});
	let selectedSpus = new SvelteSet<string>();
	let bulkState = $state('');
	let bulkUpdating = $state(false);

	const STATUS_OPTIONS = [
		'draft', 'assembling', 'assembled', 'validating', 'validated',
		'released-rnd', 'released-manufacturing', 'released-field',
		'deployed', 'servicing', 'retired', 'voided'
	] as const;

	function statusColor(status: string): string {
		if (['released-rnd', 'released-manufacturing', 'released-field', 'deployed'].includes(status)) return 'var(--color-tron-green)';
		if (['assembling', 'assembled'].includes(status)) return 'var(--color-tron-cyan)';
		if (['validating', 'validated'].includes(status)) return 'var(--color-tron-yellow, #fbbf24)';
		if (status === 'servicing') return 'var(--color-tron-orange)';
		if (status === 'voided') return 'var(--color-tron-red)';
		return 'var(--color-tron-text-secondary)';
	}

	// Barcode scan → lookup or register
	async function handleBarcodeScan() {
		const barcode = barcodeInput.trim();
		if (!barcode) return;

		const existing = data.spus.find(
			(s) => (s.barcode && s.barcode.toLowerCase() === barcode.toLowerCase()) ||
				s.udi.toLowerCase() === barcode.toLowerCase()
		);
		if (existing) {
			goto(`/spu/${existing.id}`);
		} else {
			showRegisterForm = true;
		}
	}

	// Handle successful registration
	$effect(() => {
		if (form?.success && form?.spuId) {
			registerSuccess = { spuId: form.spuId };
			showRegisterForm = false;
			barcodeInput = '';
			udiInput = '';
		}
	});

	// Clear selections on data reload
	$effect(() => {
		data.spus;
		selectedSpus.clear();
	});

	// SITE-22: Filtering and sorting state
	let searchQuery = $state('');
	let filterQcStatus = $state('all');
	// filterAssignment removed — release statuses replace assignment
	let filterAssemblyStatus = $state('all');
	let filterDateAfter = $state('');
	let filterDateBefore = $state('');
	let sortBy = $state<'createdAt' | 'qcStatus' | 'status'>('createdAt');
	let sortDir = $state<'asc' | 'desc'>('desc');

	const ASSEMBLY_STATUSES = [
		'created',
		'in_progress',
		'assembled',
		'tested',
		'released',
		'on_hold',
		'scrapped'
	] as const;

	const stateTabs = [
		{ key: null, label: 'All' },
		{ key: 'draft', label: 'Draft' },
		{ key: 'assembling', label: 'Assembling' },
		{ key: 'assembled', label: 'Assembled' },
		{ key: 'validating', label: 'Validating' },
		{ key: 'validated', label: 'Validated' },
		{ key: 'released-rnd', label: 'Released R&D' },
		{ key: 'released-manufacturing', label: 'Released Mfg' },
		{ key: 'released-field', label: 'Released Field' },
		{ key: 'deployed', label: 'Deployed' },
		{ key: 'servicing', label: 'Servicing' },
		{ key: 'retired', label: 'Retired' },
		{ key: 'voided', label: 'Voided' }
	] as const;

	let activeTab = $derived(data.stateFilter);

	let totalCount = $derived(
		Object.values(data.stateCounts).reduce((sum, c) => sum + c, 0)
	);

	function getTabCount(key: string | null): number {
		if (key === null) return totalCount;
		return data.stateCounts[key] ?? 0;
	}

	let filteredSpus = $derived.by(() => {
		let result = data.spus;

		// Search by UDI or short ID
		if (searchQuery.trim()) {
			const q = searchQuery.trim().toLowerCase();
			result = result.filter(
				(s) => s.udi.toLowerCase().includes(q) ||
					extractShortId(s.udi).toLowerCase().includes(q) ||
					(s.batchNumber && s.batchNumber.toLowerCase().includes(q)) ||
					(s.owner && s.owner.toLowerCase().includes(q))
			);
		}

		// QC Status filter
		if (filterQcStatus !== 'all') {
			result = result.filter((s) => s.qcStatus === filterQcStatus);
		}

		// Assembly Status filter
		if (filterAssemblyStatus !== 'all') {
			result = result.filter((s) => s.assemblyStatus === filterAssemblyStatus);
		}

		// Date range filters
		if (filterDateAfter) {
			const after = new Date(filterDateAfter);
			result = result.filter((s) => new Date(s.createdAt) >= after);
		}
		if (filterDateBefore) {
			const beforeMs = Date.parse(filterDateBefore) + 86399999;
			result = result.filter((s) => Date.parse(String(s.createdAt)) <= beforeMs);
		}

		// Sort
		result = [...result].sort((a, b) => {
			const dir = sortDir === 'asc' ? 1 : -1;
			if (sortBy === 'createdAt') {
				return dir * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
			}
			if (sortBy === 'qcStatus') {
				return dir * a.qcStatus.localeCompare(b.qcStatus);
			}
			// status
			return dir * (a.status ?? '').localeCompare(b.status ?? '');
		});

		return result;
	});

	let hasActiveFilters = $derived(
		searchQuery.trim() !== '' ||
			filterQcStatus !== 'all' ||
			filterAssemblyStatus !== 'all' ||
			filterDateAfter !== '' ||
			filterDateBefore !== ''
	);

	function clearFilters() {
		searchQuery = '';
		filterQcStatus = 'all';
		filterAssemblyStatus = 'all';
		filterDateAfter = '';
		filterDateBefore = '';
		sortBy = 'createdAt';
		sortDir = 'desc';
	}

	function extractShortId(udi: string): string {
		const match = udi.match(/\(21\)(.+)/);
		if (!match) return udi.slice(0, 8).toUpperCase();
		return `SPU-${match[1].slice(0, 8).toUpperCase()}`;
	}

	function qcColor(status: string): string {
		if (status === 'pass') return 'var(--color-tron-green)';
		if (status === 'fail') return 'var(--color-tron-red)';
		return 'var(--color-tron-orange)';
	}

	// assignmentLabel removed — status badge handles display

	function toggleSelect(id: string) {
		if (selectedSpus.has(id)) {
			selectedSpus.delete(id);
		} else {
			selectedSpus.add(id);
		}
	}

	function toggleSelectAll() {
		if (selectedSpus.size === filteredSpus.length) {
			selectedSpus.clear();
		} else {
			for (const s of filteredSpus) {
				selectedSpus.add(s.id);
			}
		}
	}

	function formatCurrency(value: string): string {
		const num = parseFloat(value);
		if (isNaN(num)) return '$0.00';
		return new Intl.NumberFormat('en-US', {
			style: 'currency',
			currency: 'USD',
			minimumFractionDigits: 0,
			maximumFractionDigits: 0
		}).format(num);
	}

	function formatRelativeTime(date: Date): string {
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffMins = Math.floor(diffMs / 60000);
		const diffHours = Math.floor(diffMs / 3600000);
		const diffDays = Math.floor(diffMs / 86400000);

		if (diffMins < 1) return 'Just now';
		if (diffMins < 60) return `${diffMins}m ago`;
		if (diffHours < 24) return `${diffHours}h ago`;
		if (diffDays < 7) return `${diffDays}d ago`;
		return date.toLocaleDateString();
	}
</script>

<div class="flex gap-4 items-start">
	<!-- ═══════════════ CARTRIDGE DASHBOARD (LEFT) ═══════════════ -->
	<div class="flex-1 min-w-0 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)]">
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

				<!-- Assay Inventory -->
				{#if cd.assayInventory && cd.assayInventory.length > 0}
					<TronCard>
						<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Assay Inventory</h3>
						<div class="space-y-1.5">
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
					</TronCard>
				{/if}

				<!-- Daily Throughput (7-day bar chart) -->
				{#if cd.dailyThroughput && cd.dailyThroughput.length > 0}
					{@const maxDay = Math.max(...cd.dailyThroughput.map((d: any) => d.count), 1)}
					<TronCard>
						<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Daily Throughput (7d)</h3>
						<div class="flex items-end gap-1 h-20">
							{#each cd.dailyThroughput as day}
								<div class="flex-1 flex flex-col items-center gap-1">
									<span class="text-[9px] font-mono text-[var(--color-tron-text-secondary)]">{day.count}</span>
									<div class="w-full rounded-t" style="height: {Math.max((day.count / maxDay) * 56, 2)}px; background: var(--color-tron-cyan);"></div>
									<span class="text-[8px] text-[var(--color-tron-text-secondary)]">{day.date.slice(5)}</span>
								</div>
							{/each}
						</div>
					</TronCard>
				{/if}

				<!-- Recent Wax Filling Runs -->
				{#if cd.recentRuns && cd.recentRuns.length > 0}
					<TronCard>
						<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Recent Wax Runs</h3>
						<div class="space-y-1.5">
							{#each cd.recentRuns as run}
								<div class="flex items-center justify-between text-xs">
									<div class="flex items-center gap-2 min-w-0">
										<span class="rounded px-1.5 py-0.5 text-[10px] font-medium {run.status === 'completed' ? 'bg-[rgba(34,197,94,0.15)] text-green-400' : run.status === 'running' ? 'bg-[rgba(0,255,255,0.15)] text-[var(--color-tron-cyan)]' : run.status === 'aborted' ? 'bg-[rgba(239,68,68,0.15)] text-red-400' : 'bg-[rgba(255,255,255,0.05)] text-[var(--color-tron-text-secondary)]'}">{run.status}</span>
										<span class="text-[var(--color-tron-text)] truncate">{run.robotName}</span>
									</div>
									<div class="flex items-center gap-2 shrink-0">
										<span class="font-mono text-[var(--color-tron-cyan)]">{run.cartridgeCount}</span>
										<span class="text-[var(--color-tron-text-secondary)]">{formatDate(run.date)}</span>
									</div>
								</div>
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

				{#if cd.lab && cd.lab.total > 0}
					<TronCard>
						<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Lab Cartridges</h3>
						<div class="grid gap-3 sm:grid-cols-3">
							<div class="text-center">
								<div class="text-xl font-bold text-[var(--color-tron-cyan)]">{cd.lab.total}</div>
								<div class="text-[10px] text-[var(--color-tron-text-secondary)] uppercase">Total</div>
							</div>
							{#each cd.lab.statusCounts as s}
								<div class="text-center">
									<div class="text-xl font-bold text-[var(--color-tron-text)]">{s.count}</div>
									<div class="text-[10px] text-[var(--color-tron-text-secondary)] capitalize">{s.status?.replace(/_/g, ' ') ?? '—'}</div>
								</div>
							{/each}
						</div>
					</TronCard>
				{/if}
			</div>
		{:else if !cartCollapsed}
			<div class="px-4 pb-4">
				<p class="text-sm text-[var(--color-tron-text-secondary)]">Cartridge data unavailable.</p>
			</div>
		{/if}
	</div>

	<!-- ═══════════════ SPU DASHBOARD (RIGHT) ═══════════════ -->
	<div class="flex-1 min-w-0 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)]">
		<button type="button" onclick={() => { spuCollapsed = !spuCollapsed; }} class="flex w-full items-center justify-between p-4">
			<h2 class="text-lg font-bold text-[var(--color-tron-text)]">SPU Dashboard</h2>
			<svg class="h-4 w-4 text-[var(--color-tron-cyan)] transition-transform {spuCollapsed ? '' : 'rotate-180'}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
			</svg>
		</button>
		{#if !spuCollapsed}
			<div class="px-4 pb-4">

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h2 class="tron-text-primary text-2xl font-bold">SPU Dashboard</h2>
	</div>

	<!-- Barcode Scan / Lookup -->
	<TronCard>
		<h3 class="tron-text-primary mb-3 text-lg font-bold">Barcode Scan / Lookup</h3>
		<div class="flex gap-3">
			<input
				type="text"
				class="tron-input flex-1"
				placeholder="Scan barcode to find or register a new SPU..."
				bind:value={barcodeInput}
				onkeydown={(e) => {
					if (e.key === 'Enter') handleBarcodeScan();
				}}
				style="min-height: 44px;"
			/>
			<TronButton variant="primary" onclick={handleBarcodeScan} style="min-height: 44px;">
				Lookup
			</TronButton>
		</div>

		{#if registerSuccess}
			<div
				class="mt-3 rounded border border-[var(--color-tron-green)] bg-[rgba(0,255,128,0.1)] p-3"
			>
				<p class="text-sm text-[var(--color-tron-green)]">
					SPU registered successfully!
					<a
						href="/spu/{registerSuccess.spuId}"
						class="underline hover:text-[var(--color-tron-cyan)]"
					>
						View SPU
					</a>
				</p>
			</div>
		{/if}

		{#if showRegisterForm}
			<div class="mt-4 rounded border border-[var(--color-tron-cyan)] bg-[rgba(0,255,255,0.03)] p-4">
				<h4 class="tron-text-primary mb-3 font-medium">Register New SPU</h4>
				<p class="tron-text-muted mb-4 text-sm">
					No SPU found with this barcode. Fill in the details to register it.
				</p>
				<form
					method="POST"
					action="?/register"
					use:enhance={() => {
						registering = true;
						return async ({ result, update }) => {
							registering = false;
							await update();
						};
					}}
					class="space-y-4"
				>
					<div>
						<label for="reg-barcode" class="tron-label">Barcode</label>
						<input
							id="reg-barcode"
							name="barcode"
							type="text"
							class="tron-input"
							value={barcodeInput}
							readonly
							style="min-height: 44px;"
						/>
					</div>

					<div>
						<label for="reg-udi" class="tron-label">UDI (Unique Device Identifier)</label>
						<input
							id="reg-udi"
							name="udi"
							type="text"
							class="tron-input"
							placeholder="Enter the Unique Device Identifier"
							bind:value={udiInput}
							disabled={registering}
							required
							style="min-height: 44px;"
						/>
					</div>

					<div>
						<label for="reg-deviceState" class="tron-label">Device State</label>
						<select
							id="reg-deviceState"
							name="deviceState"
							class="tron-select"
							required
							disabled={registering}
							style="min-height: 44px;"
						>
							<option value="draft">Draft</option>
							<option value="assembling">Assembling</option>
							<option value="assembled">Assembled</option>
							<option value="validating">Validating</option>
							<option value="validated">Validated</option>
							<option value="released-rnd">Released R&D</option>
							<option value="released-manufacturing">Released Mfg</option>
							<option value="released-field">Released Field</option>
							<option value="deployed">Deployed</option>
							<option value="servicing">Servicing</option>
							<option value="retired">Retired</option>
							<option value="voided">Voided</option>
						</select>
					</div>

					<div>
						<label for="reg-owner" class="tron-label">
							Owner (Optional)
							{#if data.fieldHints.ownerRecommended}
								<span class="ml-2 text-xs text-[var(--color-tron-cyan)]">Recommended</span>
							{/if}
						</label>
						<input
							id="reg-owner"
							name="owner"
							type="text"
							class="tron-input {data.fieldHints.ownerRecommended ? 'border-[var(--color-tron-cyan)]' : ''}"
							placeholder="Person, team, or customer"
							disabled={registering}
							style="min-height: 44px;"
						/>
					</div>

					<div>
						<label for="reg-ownerNotes" class="tron-label">Owner Notes (Optional)</label>
						<input
							id="reg-ownerNotes"
							name="ownerNotes"
							type="text"
							class="tron-input"
							placeholder="Context about assignment"
							disabled={registering}
							style="min-height: 44px;"
						/>
					</div>

					<div>
						<label for="reg-batchId" class="tron-label">
							Batch (Optional)
							{#if data.fieldHints.batchRecommended}
								<span class="ml-2 text-xs text-[var(--color-tron-cyan)]">Recommended</span>
							{/if}
						</label>
						<select
							id="reg-batchId"
							name="batchId"
							class="tron-select {data.fieldHints.batchRecommended ? 'border-[var(--color-tron-cyan)]' : ''}"
							disabled={registering}
							style="min-height: 44px;"
						>
							<option value="">No batch</option>
							{#each data.batches as batchOption (batchOption.id)}
								<option value={batchOption.id}>{batchOption.batchNumber}</option>
							{/each}
						</select>
					</div>

					{#if form?.error}
						<div
							class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-3"
						>
							<p class="text-sm text-[var(--color-tron-red)]">{form.error}</p>
						</div>
					{/if}

					<div class="flex gap-3 pt-2">
						<TronButton
							type="button"
							class="flex-1"
							onclick={() => (showRegisterForm = false)}
							disabled={registering}
						>
							Cancel
						</TronButton>
						<TronButton type="submit" variant="primary" class="flex-1" disabled={registering}>
							{#if registering}
								Registering...
							{:else}
								Register SPU
							{/if}
						</TronButton>
					</div>
				</form>
			</div>
		{/if}
	</TronCard>

	<!-- BOM Summary Widget -->
	<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
		<!-- Total Parts card -->
		<a href={resolve('/bom')} class="block">
			<TronCard interactive>
				<div class="text-center">
					<div class="tron-text-primary mb-1 text-3xl font-bold">{data.bomSummary.activeItems}</div>
					<div class="tron-text-muted text-sm">Total Parts</div>
				</div>
			</TronCard>
		</a>

		<!-- Total BOM Cost card (expandable for cost breakdown) -->
		<div>
			<TronCard>
				<button
					type="button"
					class="w-full text-center"
					onclick={() => (costExpanded = !costExpanded)}
				>
					<div class="mb-1 text-3xl font-bold text-[var(--color-tron-cyan)]">
						<a
							href={resolve('/parts')}
							class="hover:underline"
							onclick={(e: MouseEvent) => e.stopPropagation()}
						>
							{formatCurrency(data.bomSummary.totalCost)}
						</a>
					</div>
					<div class="tron-text-muted flex items-center justify-center gap-1 text-sm">
						Total BOM Cost
						<svg
							class="h-3 w-3 transition-transform {costExpanded ? 'rotate-180' : ''}"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M19 9l-7 7-7-7"
							/>
						</svg>
					</div>
				</button>
				{#if costExpanded && data.costBreakdown}
					<div class="mt-3 border-t border-[var(--color-tron-border)] pt-3">
						<div class="flex justify-between text-sm">
							<span class="text-[var(--color-tron-cyan)]">Material</span>
							<span class="tron-text-primary font-mono"
								>{formatCurrency(data.costBreakdown.materialSubtotal.toString())}</span
							>
						</div>
						<div class="mt-1 flex justify-between text-sm">
							<span class="text-[var(--color-tron-orange)]">Labor</span>
							<span class="tron-text-primary font-mono"
								>{formatCurrency(data.costBreakdown.laborSubtotal.toString())}</span
							>
						</div>
						{#if data.costBreakdown.lineItems.length > 0}
							<div class="mt-2 max-h-40 space-y-1 overflow-y-auto">
								{#each data.costBreakdown.lineItems as item (item.partName)}
									<div class="flex justify-between text-xs">
										<span class="tron-text-muted truncate" title={item.partName}
											>{item.partName}</span
										>
										<span class="tron-text-muted shrink-0 pl-2 font-mono">
											{formatCurrency(item.materialCost.toString())}
											{#if item.laborCost > 0}
												<span class="text-[var(--color-tron-orange)]"
													>+{formatCurrency(item.laborCost.toString())}</span
												>
											{/if}
										</span>
									</div>
								{/each}
							</div>
						{/if}
						{#if data.costBreakdown.laborSubtotal === 0}
							<p class="tron-text-muted mt-2 text-xs italic">No labor entries recorded</p>
						{/if}
					</div>
				{/if}
			</TronCard>
		</div>

		<!-- Expiring in 30 Days card (expandable) -->
		<div>
			<TronCard>
				<button
					type="button"
					class="w-full text-center"
					onclick={() => (expiringExpanded = !expiringExpanded)}
				>
					<div
						class="mb-1 text-3xl font-bold {data.bomSummary.expiringWithin30Days > 0
							? 'text-[var(--color-tron-orange)]'
							: 'tron-text-primary'}"
					>
						{data.bomSummary.expiringWithin30Days}
					</div>
					<div class="tron-text-muted flex items-center justify-center gap-1 text-sm">
						Expiring in 30 Days
						<svg
							class="h-3 w-3 transition-transform {expiringExpanded ? 'rotate-180' : ''}"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M19 9l-7 7-7-7"
							/>
						</svg>
					</div>
				</button>
				{#if expiringExpanded}
					<div class="mt-3 border-t border-[var(--color-tron-border)] pt-3">
						{#if data.expiringItems.length > 0}
							<div class="max-h-40 space-y-2 overflow-y-auto">
								{#each data.expiringItems as item (item.partNumber)}
									<div class="flex items-center justify-between text-xs">
										<div>
											<span class="tron-text-primary font-mono">{item.partNumber}</span>
											<span class="tron-text-muted ml-1">{item.name}</span>
										</div>
										<span class="shrink-0 text-[var(--color-tron-orange)]">
											{new Date(item.expirationDate).toLocaleDateString()}
										</span>
									</div>
								{/each}
							</div>
						{:else}
							<p class="tron-text-muted text-center text-xs italic">No items expiring</p>
						{/if}
					</div>
				{/if}
			</TronCard>
		</div>

		<!-- Last Box Sync card with error badge and retry -->
		<div>
			<TronCard>
				<div class="text-center">
					{#if data.bomSummary.lastSyncAt}
						<div
							class="mb-1 text-lg font-bold {data.bomSummary.lastSyncStatus === 'success'
								? 'text-[var(--color-tron-green)]'
								: data.bomSummary.lastSyncStatus === 'error'
									? 'text-[var(--color-tron-red)]'
									: 'tron-text-primary'}"
						>
							{formatRelativeTime(new Date(data.bomSummary.lastSyncAt))}
						</div>
						<div class="tron-text-muted text-sm">Last Box Sync</div>
						{#if data.bomSummary.lastSyncStatus === 'error'}
							<div class="mt-2">
								<TronBadge variant="error">Sync Error</TronBadge>
								{#if data.syncErrorDetail}
									<p class="mt-1 text-xs text-[var(--color-tron-error)]">
										{data.syncErrorDetail.message}
									</p>
								{/if}
								<form
									method="POST"
									action="?/retrySync"
									class="mt-2"
									use:enhance={() => {
										syncing = true;
										return async ({ update }) => {
											syncing = false;
											await update();
										};
									}}
								>
									<TronButton type="submit" variant="primary" class="text-xs" disabled={syncing}>
										{syncing ? 'Syncing...' : 'Retry Sync'}
									</TronButton>
								</form>
							</div>
						{/if}
					{:else}
						<div class="tron-text-muted mb-1 text-lg font-bold">Not Connected</div>
						<div class="tron-text-muted text-sm">Box.com Sync</div>
					{/if}
				</div>
			</TronCard>
		</div>
	</div>

	<!-- Active Production Runs -->
	<TronCard>
		<h3 class="tron-text-primary mb-4 text-lg font-bold">Active Production Runs</h3>
		{#if data.activeRuns.length === 0}
			<p class="tron-text-muted py-4 text-center text-sm">No active runs</p>
		{:else}
			<div class="space-y-2">
				{#each data.activeRuns as run (run.id)}
					<a
						href="/documents/instructions/{run.workInstructionId}/run/{run.id}"
						class="flex items-center justify-between rounded border border-[var(--color-tron-border)] p-3 transition-colors hover:border-[var(--color-tron-cyan)] hover:bg-[rgba(0,255,255,0.05)]"
						style="min-height: 44px;"
					>
						<div class="flex items-center gap-3">
							<span class="font-mono text-sm text-[var(--color-tron-cyan)]">{run.runNumber}</span>
							<span class="tron-text-muted text-sm">{run.workInstructionTitle}</span>
						</div>
						<div class="flex items-center gap-3">
							<span class="tron-text-primary text-sm font-medium"
								>{run.completedUnits}/{run.quantity} units</span
							>
							<span
								class="rounded px-2 py-0.5 text-xs font-medium {run.status === 'in_progress'
									? 'bg-[rgba(0,255,255,0.15)] text-[var(--color-tron-cyan)]'
									: 'bg-[rgba(255,165,0,0.15)] text-[var(--color-tron-orange)]'}"
							>
								{run.status === 'in_progress' ? 'In Progress' : 'Paused'}
							</span>
						</div>
					</a>
				{/each}
			</div>
		{/if}
	</TronCard>

	<!-- Fleet Organizer -->
	{#if data.fleetSummary}
		{@const fleet = data.fleetSummary}
		<div>
			<h3 class="tron-text-primary mb-3 text-lg font-bold">Fleet Organizer</h3>

			{#snippet fleetSpuCard(s: Spu)}
				<div
					class="flex items-center justify-between gap-2 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2"
				>
					<div class="min-w-0">
						<div class="text-xs font-bold text-[var(--color-tron-cyan)]">
							{extractShortId(s.udi)}
						</div>
						<div class="tron-text-muted truncate font-mono text-xs" title={s.udi}>{s.udi}</div>
					</div>
					<div class="flex items-center gap-2">
						<span
							class="rounded px-1.5 py-0.5 text-xs font-medium"
							style="background: color-mix(in srgb, {qcColor(
								s.qcStatus
							)} 20%, transparent); color: {qcColor(s.qcStatus)};"
						>
							{s.qcStatus.charAt(0).toUpperCase() + s.qcStatus.slice(1)}
						</span>
						<SpuStatusBadge status={s.status} />
					</div>
				</div>
			{/snippet}

			{#snippet fleetSection(key: string, label: string, spuList: Spu[], badge?: string)}
				{@const collapsed = collapsedSections[key] ?? false}
				<TronCard>
					<button
						type="button"
						class="flex w-full items-center justify-between"
						onclick={() => (collapsedSections[key] = !collapsed)}
					>
						<div class="flex items-center gap-2">
							<span class="tron-text-primary font-medium">{label}</span>
							{#if badge}
								<TronBadge variant="neutral">{badge}</TronBadge>
							{/if}
							<span
								class="rounded-full bg-[var(--color-tron-cyan)] px-2 py-0.5 text-xs font-bold text-black"
							>
								{spuList.length}
							</span>
						</div>
						<svg
							class="h-4 w-4 text-[var(--color-tron-cyan)] transition-transform {collapsed
								? ''
								: 'rotate-180'}"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M19 9l-7 7-7-7"
							/>
						</svg>
					</button>
					{#if !collapsed}
						<div class="mt-3 space-y-2">
							{#if spuList.length > 0}
								{#each spuList as s (s.id)}
									{@render fleetSpuCard(s)}
								{/each}
							{:else}
								<p class="tron-text-muted py-2 text-center text-sm italic">
									No SPUs in this category
								</p>
							{/if}
						</div>
					{/if}
				</TronCard>
			{/snippet}

			<div class="space-y-3">
				{@render fleetSection('rnd', 'R&D', fleet.rnd)}
				{@render fleetSection('manufacturing', 'Manufacturing', fleet.manufacturing)}
				{#each fleet.customers as group (group.customer.id)}
					{@render fleetSection(
						`customer-${group.customer.id}`,
						group.customer.name,
						group.spus,
						group.customer.customerType.toUpperCase()
					)}
				{/each}
			</div>
		</div>
	{/if}

	<!-- Device State Tabs -->
	<div class="flex flex-wrap gap-2">
		{#each stateTabs as tab (tab.key)}
			<a
				href={tab.key ? `?state=${tab.key}` : '?'}
				class="rounded-lg border px-4 py-2 text-sm font-medium transition-colors {activeTab === tab.key
					? 'border-[var(--color-tron-cyan)] bg-[rgba(0,255,255,0.15)] text-[var(--color-tron-cyan)]'
					: 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]'}"
				style="min-height: 44px; display: inline-flex; align-items: center;"
			>
				{tab.label}
				<span
					class="ml-2 rounded-full px-2 py-0.5 text-xs {activeTab === tab.key
						? 'bg-[rgba(0,255,255,0.2)]'
						: 'bg-[rgba(255,255,255,0.05)]'}"
				>
					{getTabCount(tab.key)}
				</span>
			</a>
		{/each}
	</div>

	<!-- SITE-22: Filter and Sort Controls -->
	{#if data.spus.length > 0}
		<TronCard>
			<div class="space-y-3">
				<!-- Search box -->
				<div>
					<input
						type="text"
						class="tron-input w-full"
						placeholder="Search by UDI, short ID (SPU-xxxx), batch, or owner..."
						bind:value={searchQuery}
						style="min-height: 44px;"
					/>
				</div>

				<!-- Filter dropdowns row -->
				<div class="flex flex-wrap items-end gap-3">
					<div>
						<label for="filter-qc" class="tron-label text-xs">QC Status</label>
						<select id="filter-qc" class="tron-select text-sm" bind:value={filterQcStatus}>
							<option value="all">All</option>
							<option value="pass">Pass</option>
							<option value="fail">Fail</option>
							<option value="pending">Pending</option>
						</select>
					</div>

					<div>
						<label for="filter-assembly" class="tron-label text-xs">Assembly Status</label>
						<select
							id="filter-assembly"
							class="tron-select text-sm"
							bind:value={filterAssemblyStatus}
						>
							<option value="all">All</option>
							{#each ASSEMBLY_STATUSES as s (s)}
								<option value={s}>{s.replace('_', ' ')}</option>
							{/each}
						</select>
					</div>

					<div>
						<label for="filter-after" class="tron-label text-xs">Created After</label>
						<input
							id="filter-after"
							type="date"
							class="tron-input text-sm"
							bind:value={filterDateAfter}
						/>
					</div>

					<div>
						<label for="filter-before" class="tron-label text-xs">Created Before</label>
						<input
							id="filter-before"
							type="date"
							class="tron-input text-sm"
							bind:value={filterDateBefore}
						/>
					</div>

					<!-- Sort controls -->
					<div>
						<label for="sort-by" class="tron-label text-xs">Sort By</label>
						<select id="sort-by" class="tron-select text-sm" bind:value={sortBy}>
							<option value="createdAt">Creation Date</option>
							<option value="qcStatus">QC Status</option>
							<option value="status">Status</option>
						</select>
					</div>

					<button
						type="button"
						class="rounded border border-[var(--color-tron-border)] p-2 text-[var(--color-tron-cyan)] transition-colors hover:bg-[var(--color-tron-surface)]"
						title={sortDir === 'desc' ? 'Sorted descending' : 'Sorted ascending'}
						onclick={() => (sortDir = sortDir === 'desc' ? 'asc' : 'desc')}
					>
						<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							{#if sortDir === 'desc'}
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M19 9l-7 7-7-7"
								/>
							{:else}
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M5 15l7-7 7 7"
								/>
							{/if}
						</svg>
					</button>

					{#if hasActiveFilters}
						<TronButton class="text-xs" onclick={clearFilters}>Clear All</TronButton>
					{/if}
				</div>

				<!-- Result count -->
				{#if hasActiveFilters || filteredSpus.length !== data.spus.length}
					<p class="tron-text-muted text-xs">
						Showing {filteredSpus.length} of {data.spus.length} SPUs
					</p>
				{/if}
			</div>
		</TronCard>
	{/if}

	<!-- Bulk Actions Bar -->
	{#if selectedSpus.size > 0}
		<div
			class="flex items-center gap-4 rounded border border-[var(--color-tron-cyan)] bg-[rgba(0,255,255,0.05)] p-3"
		>
			<span class="text-sm text-[var(--color-tron-cyan)]">
				{selectedSpus.size} selected
			</span>
			<form
				method="POST"
				action="?/bulkUpdateState"
				use:enhance={() => {
					bulkUpdating = true;
					return async ({ update }) => {
						bulkUpdating = false;
						selectedSpus.clear();
						bulkState = '';
						await update();
					};
				}}
				class="flex items-center gap-3"
			>
				<input type="hidden" name="spuIds" value={Array.from(selectedSpus).join(',')} />
				<select
					name="deviceState"
					class="tron-select text-sm"
					bind:value={bulkState}
					disabled={bulkUpdating}
					style="min-height: 44px;"
				>
					<option value="">Change State...</option>
					<option value="draft">Draft</option>
					<option value="assembling">Assembling</option>
					<option value="assembled">Assembled</option>
					<option value="validating">Validating</option>
					<option value="validated">Validated</option>
					<option value="released-rnd">Released R&D</option>
							<option value="released-manufacturing">Released Mfg</option>
							<option value="released-field">Released Field</option>
					<option value="deployed">Deployed</option>
					<option value="servicing">Servicing</option>
					<option value="retired">Retired</option>
					<option value="voided">Voided</option>
				</select>
				<TronButton
					type="submit"
					variant="primary"
					disabled={!bulkState || bulkUpdating}
					style="min-height: 44px;"
				>
					{#if bulkUpdating}
						Updating...
					{:else}
						Apply
					{/if}
				</TronButton>
			</form>
			<button
				type="button"
				class="tron-text-muted ml-auto text-sm hover:text-[var(--color-tron-cyan)]"
				onclick={() => selectedSpus.clear()}
				style="min-height: 44px;"
			>
				Clear
			</button>
		</div>
	{/if}

	{#if data.spus.length === 0}
		<TronCard>
			<div class="py-12 text-center">
				<svg
					class="mx-auto mb-4 h-16 w-16 text-[var(--color-tron-text-secondary)]"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="1.5"
						d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"
					/>
				</svg>
				<h3 class="tron-text-primary mb-2 text-lg font-medium">No SPUs Found</h3>
				<p class="tron-text-muted mb-4">
					{#if activeTab}
						No SPUs in this category. Use the UDI lookup above to register a new SPU.
					{:else}
						Get started by registering your first Sample Processing Unit using the UDI lookup above.
					{/if}
				</p>
			</div>
		</TronCard>
	{:else if filteredSpus.length === 0}
		<TronCard>
			<div class="py-8 text-center">
				<p class="tron-text-muted">No SPUs match the current filters.</p>
				<button
					type="button"
					class="mt-2 text-sm text-[var(--color-tron-cyan)] hover:underline"
					onclick={clearFilters}
				>
					Clear all filters
				</button>
			</div>
		</TronCard>
	{:else}
		<!-- Select All -->
		<div class="flex items-center gap-2">
			<button
				type="button"
				class="flex items-center gap-2 text-sm text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]"
				onclick={toggleSelectAll}
				style="min-height: 44px;"
			>
				<input
					type="checkbox"
					checked={selectedSpus.size === filteredSpus.length && filteredSpus.length > 0}
					class="h-4 w-4 accent-[var(--color-tron-cyan)]"
					tabindex={-1}
				/>
				Select All
			</button>
		</div>

		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{#each filteredSpus as spuItem (spuItem.id)}
				<div class="relative">
					<button
						type="button"
						class="absolute left-2 top-2 z-10 flex h-6 w-6 items-center justify-center"
						onclick={() => toggleSelect(spuItem.id)}
						aria-label="Select SPU"
					>
						<input
							type="checkbox"
							checked={selectedSpus.has(spuItem.id)}
							class="h-4 w-4 accent-[var(--color-tron-cyan)]"
							tabindex={-1}
						/>
					</button>
					<TronCard interactive>
						<button
							type="button"
							class="w-full text-left"
							onclick={() => (expandedSpuId = expandedSpuId === spuItem.id ? null : spuItem.id)}
						>
							<div class="mb-3 flex items-start justify-between pl-6">
								<div>
									<div class="text-sm font-bold text-[var(--color-tron-cyan)]">
										{extractShortId(spuItem.udi)}
									</div>
									<div
										class="tron-text-muted mt-0.5 max-w-[200px] truncate font-mono text-xs"
										title={spuItem.udi}
									>
										{spuItem.udi}
									</div>
								</div>
								<div class="flex gap-1.5">
									<SpuDeviceStateBadge deviceState={spuItem.deviceState} />
									<SpuStatusBadge status={spuItem.status} />
								</div>
							</div>
							{#if spuItem.owner}
								<div class="mb-2 text-sm text-[var(--color-tron-cyan)]">
									Owner: {spuItem.owner}
								</div>
							{/if}
							{#if spuItem.batchNumber}
								<div class="tron-text-muted mb-2 text-sm">
									Batch: {spuItem.batchNumber}
								</div>
							{/if}
							<div class="tron-text-muted text-xs">
								Created: {new Date(spuItem.createdAt).toLocaleDateString()}
							</div>
						</button>

						{#if expandedSpuId === spuItem.id}
							<div class="mt-3 border-t border-[var(--color-tron-border)] pt-3">
								<div class="space-y-2 text-sm">
									<div class="flex justify-between">
										<span class="tron-text-muted">Created By</span>
										<span class="tron-text-primary">{spuItem.createdByUsername ?? 'Unknown'}</span>
									</div>
									<!-- Assignment row removed -->
									<div class="flex items-center justify-between">
										<span class="tron-text-muted">QC Status</span>
										<span
											class="rounded px-2 py-0.5 text-xs font-medium"
											style="background: color-mix(in srgb, {qcColor(
												spuItem.qcStatus
											)} 20%, transparent); color: {qcColor(spuItem.qcStatus)};"
										>
											{spuItem.qcStatus.charAt(0).toUpperCase() + spuItem.qcStatus.slice(1)}
										</span>
									</div>
									<div class="flex justify-between">
										<span class="tron-text-muted">QC Document</span>
										<!-- eslint-disable svelte/no-navigation-without-resolve -->
										{#if spuItem.qcDocumentUrl}
											<a
												href={spuItem.qcDocumentUrl}
												target="_blank"
												rel="noopener noreferrer"
												class="text-xs text-[var(--color-tron-cyan)] hover:underline"
												onclick={(e: MouseEvent) => e.stopPropagation()}
											>
												View QC Report
											</a>
										{:else}
											<span class="tron-text-muted text-xs italic">Not yet available</span>
										{/if}
									</div>
								</div>
								<a
									href="/spu/{spuItem.id}"
									class="mt-3 block text-center text-xs text-[var(--color-tron-cyan)] hover:underline"
									onclick={(e: MouseEvent) => e.stopPropagation()}
								>
									View Full Details →
								</a>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
							</div>
						{/if}
					</TronCard>
				</div>
			{/each}
		</div>
	{/if}
</div>

<!-- Create SPU Modal -->
{#if showCreateModal}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
		<div class="w-full max-w-md">
			<TronCard>
				<div class="mb-6 flex items-center justify-between">
					<h3 class="tron-text-primary text-xl font-bold">Create New SPU</h3>
					<button
						type="button"
						class="tron-text-muted hover:tron-text-primary"
						onclick={() => (showCreateModal = false)}
						aria-label="Close modal"
					>
						<svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M6 18L18 6M6 6l12 12"
							/>
						</svg>
					</button>
				</div>

				<form
					method="POST"
					action="?/create"
					use:enhance={() => {
						creating = true;
						return async ({ result, update }) => {
							creating = false;
							await update();
							if (result.type === 'success') {
								showCreateModal = false;
							}
						};
					}}
					class="space-y-4"
				>
					<div>
						<label for="serialNumber" class="tron-label">Serial Number</label>
						<input
							id="serialNumber"
							name="serialNumber"
							type="text"
							class="tron-input"
							placeholder="Enter serial number"
							required
							disabled={creating}
						/>
						<p class="tron-text-muted mt-1 text-xs">This will be used to generate the UDI</p>
					</div>

					<div>
						<label for="batchId" class="tron-label">Batch (Optional)</label>
						<select id="batchId" name="batchId" class="tron-select" disabled={creating}>
							<option value="">No batch</option>
							{#each data.batches as batch (batch.id)}
								<option value={batch.id}>{batch.batchNumber}</option>
							{/each}
						</select>
					</div>

					{#if form?.error}
						<div
							class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-3"
						>
							<p class="text-sm text-[var(--color-tron-red)]">{form.error}</p>
						</div>
					{/if}

					<div class="flex gap-3 pt-2">
						<TronButton
							type="button"
							class="flex-1"
							onclick={() => (showCreateModal = false)}
							disabled={creating}
						>
							Cancel
						</TronButton>
						<TronButton type="submit" variant="primary" class="flex-1" disabled={creating}>
							{#if creating}
								Creating...
							{:else}
								Create SPU
							{/if}
						</TronButton>
					</div>
				</form>
			</TronCard>
		</div>
	</div>
{/if}

			</div><!-- end SPU panel-content -->
		{/if}
	</div><!-- end SPU panel -->
</div><!-- end stacked container -->
