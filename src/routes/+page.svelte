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

<style>
	.dash-panel {
		transition: flex 0.2s ease, width 0.2s ease, opacity 0.15s ease;
		overflow: hidden;
	}
	.dash-panel.collapsed {
		flex: 0 0 36px !important;
		min-width: 36px;
		max-width: 36px;
	}
	.dash-panel.collapsed .panel-content {
		opacity: 0;
		pointer-events: none;
	}
	.collapsed-label {
		writing-mode: vertical-rl;
		text-orientation: mixed;
		transform: rotate(180deg);
	}
</style>

<div class="flex gap-3">
	<!-- SPU Dashboard Panel -->
	<div class="dash-panel flex-1 min-w-0 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)]" class:collapsed={spuCollapsed}>
		{#if spuCollapsed}
			<button type="button" onclick={() => { spuCollapsed = false; }} class="flex h-full w-full flex-col items-center justify-start pt-3 gap-2">
				<svg class="h-4 w-4 text-[var(--color-tron-cyan)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 5l7 7-7 7" />
				</svg>
				<span class="collapsed-label text-xs font-semibold text-[var(--color-tron-cyan)] tracking-wider">SPU DASHBOARD</span>
			</button>
		{:else}
			<div class="panel-content p-4">
				<div class="mb-4 flex items-center justify-between">
					<h2 class="text-lg font-bold text-[var(--color-tron-text)]">SPU Dashboard</h2>
					<button type="button" onclick={() => { spuCollapsed = true; }} class="rounded p-1 text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)] transition-colors" title="Collapse">
						<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 19l-7-7 7-7" />
						</svg>
					</button>
				</div>

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

			</div><!-- end panel-content -->
		{/if}
	</div><!-- end SPU panel -->

	<!-- Cartridge Dashboard Panel -->
	<div class="dash-panel flex-1 min-w-0 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)]" class:collapsed={cartCollapsed}>
		{#if cartCollapsed}
			<button type="button" onclick={() => { cartCollapsed = false; }} class="flex h-full w-full flex-col items-center justify-start pt-3 gap-2">
				<svg class="h-4 w-4 text-[var(--color-tron-cyan)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 19l-7-7 7-7" />
				</svg>
				<span class="collapsed-label text-xs font-semibold text-[var(--color-tron-cyan)] tracking-wider">CARTRIDGE DASHBOARD</span>
			</button>
		{:else}
			<div class="panel-content p-4">
				<div class="mb-4 flex items-center justify-between">
					<h2 class="text-lg font-bold text-[var(--color-tron-text)]">Cartridge Dashboard</h2>
					<button type="button" onclick={() => { cartCollapsed = true; }} class="rounded p-1 text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)] transition-colors" title="Collapse">
						<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 5l7 7-7 7" />
						</svg>
					</button>
				</div>

				{#if data.cartridgeDashboard}
					{@const cd = data.cartridgeDashboard}
					<div class="space-y-4">
						<!-- Total -->
						<TronCard>
							<div class="text-center">
								<div class="text-3xl font-bold text-[var(--color-tron-cyan)]">{cd.totalCartridges}</div>
								<div class="text-xs text-[var(--color-tron-text-secondary)]">Total Cartridges</div>
							</div>
						</TronCard>

						<!-- Status breakdown -->
						<TronCard>
							<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">By Status</h3>
							<div class="space-y-2">
								{#each cd.statusCounts as s}
									<div class="flex items-center justify-between">
										<div class="flex items-center gap-2">
											<div class="h-2 w-2 rounded-full" style="background: {getCartStatusColor(s.status)}"></div>
											<span class="text-xs text-[var(--color-tron-text)]">{s.status ?? 'unknown'}</span>
										</div>
										<span class="font-mono text-xs font-bold text-[var(--color-tron-text)]">{s.count}</span>
									</div>
								{/each}
							</div>
						</TronCard>

						<!-- Type breakdown -->
						{#if cd.typeCounts.length > 0}
							<TronCard>
								<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">By Type</h3>
								<div class="space-y-2">
									{#each cd.typeCounts as t}
										<div class="flex items-center justify-between">
											<span class="text-xs text-[var(--color-tron-text)]">{t.type ?? 'untyped'}</span>
											<span class="font-mono text-xs font-bold text-[var(--color-tron-text)]">{t.count}</span>
										</div>
									{/each}
								</div>
							</TronCard>
						{/if}

						<!-- Groups -->
						{#if cd.groupSummary.length > 0}
							<TronCard>
								<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Groups</h3>
								<div class="space-y-2">
									{#each cd.groupSummary as g}
										<div class="flex items-center justify-between">
											<div class="flex items-center gap-2">
												{#if g.color}
													<div class="h-2 w-2 rounded-full" style="background: {g.color}"></div>
												{/if}
												<span class="text-xs text-[var(--color-tron-text)]">{g.groupName}</span>
											</div>
											<span class="font-mono text-xs font-bold text-[var(--color-tron-text)]">{g.count}</span>
										</div>
									{/each}
								</div>
							</TronCard>
						{/if}

						<!-- Recent Activity -->
						<TronCard>
							<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Recent Activity</h3>
							<div class="space-y-1.5 max-h-64 overflow-y-auto">
								{#each cd.recentActivity as c}
									<a href="/cartridges/{c.id}" class="flex items-center justify-between rounded px-2 py-1.5 text-xs hover:bg-[var(--color-tron-surface)] transition-colors">
										<span class="font-mono text-[var(--color-tron-text)]">{c.barcode ?? c.id.slice(-8)}</span>
										<div class="flex items-center gap-2">
											<TronBadge variant={c.status === 'active' || c.status === 'available' ? 'success' : 'neutral'}>{c.status ?? '—'}</TronBadge>
											<span class="text-[var(--color-tron-text-secondary)]">{formatDate(c.updatedAt)}</span>
										</div>
									</a>
								{/each}
							</div>
						</TronCard>
					</div>
				{:else}
					<p class="text-sm text-[var(--color-tron-text-secondary)]">Cartridge data unavailable.</p>
				{/if}
			</div>
		{/if}
	</div><!-- end Cartridge panel -->
</div><!-- end flex container -->
