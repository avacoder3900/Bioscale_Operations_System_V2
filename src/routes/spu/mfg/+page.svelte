<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { TronCard, TronButton, TronBadge } from '$lib/components/ui';
	import SpuStatusBadge from '$lib/components/spu/SpuStatusBadge.svelte';
	import SpuDeviceStateBadge from '$lib/components/spu/SpuDeviceStateBadge.svelte';
	import { SvelteSet } from 'svelte/reactivity';

	let { data, form: _form } = $props();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const form = _form as any;

	let barcodeInput = $state('');
	let udiInput = $state('');
	let showRegisterForm = $state(false);
	let registering = $state(false);
	let registerSuccess = $state<{ spuId: string } | null>(null);
	let showCreateModal = $state(false);
	let creating = $state(false);
	let expandedSpuId = $state<string | null>(null);
	let selectedSpus = new SvelteSet<string>();
	let bulkState = $state('');
	let bulkUpdating = $state(false);

	const STATUS_OPTIONS = [
		'draft', 'assembling', 'assembled', 'validating', 'validated',
		'released-rnd', 'released-manufacturing', 'released-field',
		'deployed', 'servicing', 'retired', 'voided'
	] as const;

	// Barcode / UDI scan → lookup existing SPU or open the register form
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

	$effect(() => {
		if (form?.success && form?.spuId) {
			registerSuccess = { spuId: form.spuId };
			showRegisterForm = false;
			barcodeInput = '';
			udiInput = '';
		}
	});

	$effect(() => {
		data.spus;
		selectedSpus.clear();
	});

	let searchQuery = $state('');
	let filterQcStatus = $state('all');
	let filterStatus = $state('all');
	let filterAssemblyStatus = $state('all');
	let filterDateAfter = $state('');
	let filterDateBefore = $state('');
	let sortBy = $state<'createdAt' | 'qcStatus' | 'status'>('createdAt');
	let sortDir = $state<'asc' | 'desc'>('desc');

	const ASSEMBLY_STATUSES = [
		'created', 'in_progress', 'assembled', 'tested', 'released', 'on_hold', 'scrapped'
	] as const;

	let totalCount = $derived(
		Object.values(data.stateCounts).reduce((sum, c) => sum + c, 0)
	);

	let filteredSpus = $derived.by(() => {
		let result = data.spus;
		if (searchQuery.trim()) {
			const q = searchQuery.trim().toLowerCase();
			result = result.filter(
				(s) => s.udi.toLowerCase().includes(q) ||
					extractShortId(s.udi).toLowerCase().includes(q) ||
					(s.batchNumber && s.batchNumber.toLowerCase().includes(q)) ||
					(s.owner && s.owner.toLowerCase().includes(q))
			);
		}
		if (filterQcStatus !== 'all') {
			result = result.filter((s) => s.qcStatus === filterQcStatus);
		}
		if (filterStatus !== 'all') {
			result = result.filter((s) => s.status === filterStatus);
		}
		if (filterAssemblyStatus !== 'all') {
			result = result.filter((s) => s.assemblyStatus === filterAssemblyStatus);
		}
		if (filterDateAfter) {
			const after = new Date(filterDateAfter);
			result = result.filter((s) => new Date(s.createdAt) >= after);
		}
		if (filterDateBefore) {
			const beforeMs = Date.parse(filterDateBefore) + 86399999;
			result = result.filter((s) => Date.parse(String(s.createdAt)) <= beforeMs);
		}
		result = [...result].sort((a, b) => {
			const dir = sortDir === 'asc' ? 1 : -1;
			if (sortBy === 'createdAt') {
				return dir * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
			}
			if (sortBy === 'qcStatus') {
				return dir * a.qcStatus.localeCompare(b.qcStatus);
			}
			return dir * (a.status ?? '').localeCompare(b.status ?? '');
		});
		return result;
	});

	let hasActiveFilters = $derived(
		searchQuery.trim() !== '' ||
			filterQcStatus !== 'all' ||
			filterStatus !== 'all' ||
			filterAssemblyStatus !== 'all' ||
			filterDateAfter !== '' ||
			filterDateBefore !== ''
	);

	function clearFilters() {
		searchQuery = '';
		filterQcStatus = 'all';
		filterStatus = 'all';
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
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h2 class="tron-text-primary text-2xl font-bold">SPU Manufacturing</h2>
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

	<!-- SPU Inventory Overview -->
	<div class="grid gap-4 sm:grid-cols-2">
		<!-- SPU Build Capacity -->
		<TronCard>
			<div class="text-center">
				<div class="mb-0.5 text-2xl font-bold {data.spuBuildCount > 0 ? 'text-[var(--color-tron-green)]' : 'text-[var(--color-tron-red)]'}">{data.spuBuildCount}</div>
				<div class="tron-text-muted text-xs">SPUs Buildable with Current Inventory</div>
			</div>
		</TronCard>

		<!-- 5 Lowest Inventory Parts -->
		<TronCard>
			<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">5 Lowest Inventory Parts</h3>
			<div class="space-y-2">
				{#each data.lowestSpuParts as part (part.id)}
					<a href="/parts/{part.id}" class="flex items-center justify-between rounded px-2 py-1.5 hover:bg-white/5 transition-colors">
						<div class="min-w-0">
							<div class="text-xs font-mono text-[var(--color-tron-cyan)] truncate">{part.partNumber}</div>
							<div class="tron-text-muted text-xs truncate">{part.name}</div>
						</div>
						<div class="shrink-0 ml-3 font-mono text-sm font-bold {part.inventoryCount <= 0 ? 'text-[var(--color-tron-red)]' : part.inventoryCount < 10 ? 'text-[var(--color-tron-orange)]' : 'tron-text-primary'}">
							{part.inventoryCount}
						</div>
					</a>
				{:else}
					<p class="tron-text-muted text-xs italic text-center">No parts data</p>
				{/each}
			</div>
			<div class="mt-3 border-t border-[var(--color-tron-border)] pt-2 text-center">
				<a href="/parts" class="text-xs text-[var(--color-tron-cyan)] hover:underline">View all parts →</a>
			</div>
		</TronCard>
	</div>


	<!-- Active Production Runs -->
	<TronCard>
		<h3 class="tron-text-primary mb-2 text-sm font-semibold">Active Production Runs</h3>
		{#if data.activeRuns.length === 0}
			<p class="tron-text-muted py-2 text-center text-xs">No active runs</p>
		{:else}
			<div class="space-y-1.5">
				{#each data.activeRuns as run (run.id)}
					<a
						href="/documents/instructions/{run.workInstructionId}/run/{run.id}"
						class="flex items-center justify-between rounded border border-[var(--color-tron-border)] p-2 transition-colors hover:border-[var(--color-tron-cyan)] hover:bg-[rgba(0,255,255,0.05)]"
					>
						<div class="flex items-center gap-2">
							<span class="font-mono text-xs text-[var(--color-tron-cyan)]">{run.runNumber}</span>
							<span class="tron-text-muted text-xs">{run.workInstructionTitle}</span>
						</div>
						<div class="flex items-center gap-2">
							<span class="tron-text-primary text-xs font-medium"
								>{run.completedUnits}/{run.quantity} units</span
							>
							<span
								class="rounded px-1.5 py-0.5 text-[10px] font-medium {run.status === 'in_progress'
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
						<label for="filter-status" class="tron-label text-xs">SPU Status</label>
						<select id="filter-status" class="tron-select text-sm" bind:value={filterStatus}>
							<option value="all">All ({totalCount})</option>
							{#each STATUS_OPTIONS as s (s)}
								<option value={s}>{s.replace(/-/g, ' ')} ({data.stateCounts[s] ?? 0})</option>
							{/each}
						</select>
					</div>

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
					{#if data.stateFilter}
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
							<div class="mb-3 pl-6">
								<div class="mb-2 truncate text-sm font-bold text-[var(--color-tron-cyan)] font-mono" title={spuItem.udi}>
									{spuItem.udi}
								</div>
								<div class="flex flex-wrap gap-1.5">
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
