<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { TronCard, TronButton, TronBadge } from '$lib/components/ui';

	let { data, form } = $props();

	// Tab state
	let activeTab = $state<'lots' | 'packages'>(
		page.url.searchParams.get('tab') === 'packages' ? 'packages' : 'lots'
	);

	// Form visibility
	let showAddLot = $state(false);
	let showAddPackage = $state(false);
	let submitting = $state(false);
	let expandedLotId = $state<string | null>(null);

	function switchTab(tab: 'lots' | 'packages') {
		activeTab = tab;
		const url = new URL(page.url);
		url.searchParams.set('tab', tab);
		url.searchParams.delete('page');
		history.replaceState(history.state, '', url.toString());
	}

	function goToPage(p: number) {
		const params = new URLSearchParams(page.url.searchParams);
		params.set('page', String(p));
		goto(`/spu/shipping?${params.toString()}`);
	}

	function formatDate(date: string | Date | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleDateString();
	}

	function formatDateTime(date: string | Date | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleString();
	}

	function getLotStatusVariant(status: string): 'success' | 'info' | 'warning' | 'error' | 'neutral' {
		switch (status) {
			case 'open': return 'info';
			case 'testing': return 'warning';
			case 'released': return 'success';
			case 'shipped': return 'success';
			case 'cancelled': return 'error';
			default: return 'neutral';
		}
	}

	function getPkgStatusVariant(status: string): 'success' | 'info' | 'warning' | 'error' | 'neutral' {
		switch (status) {
			case 'created': return 'neutral';
			case 'packing': return 'info';
			case 'packed': return 'warning';
			case 'shipped': return 'success';
			case 'delivered': return 'success';
			default: return 'neutral';
		}
	}

	// Computed stats
	let openLots = $derived((data.lots ?? []).filter((l: { status: string }) => l.status === 'open').length);
	let shippedPackages = $derived((data.packages ?? []).filter((p: { status: string }) => p.status === 'shipped' || p.status === 'delivered').length);

	// Active tab total for pagination
	let activeTabTotal = $derived(
		activeTab === 'lots' ? (data.pagination?.lotsTotal ?? 0) : (data.pagination?.packagesTotal ?? 0)
	);
</script>

<div class="space-y-6">
	<!-- Header -->
	<div>
		<h2 class="tron-text-primary font-mono text-2xl font-bold">Shipping</h2>
		<p class="tron-text-muted text-sm">Manage shipping lots and packages</p>
	</div>

	{#if form?.error}
		<div class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-3">
			<p class="text-sm text-[var(--color-tron-red)]">{form.error}</p>
		</div>
	{/if}

	{#if form?.success}
		<div class="rounded border border-[var(--color-tron-green)] bg-[rgba(0,255,136,0.1)] p-3">
			<p class="text-sm text-[var(--color-tron-green)]">Operation completed successfully.</p>
		</div>
	{/if}

	<!-- Stats Cards -->
	<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
		<TronCard>
			<div class="text-center">
				<div class="font-mono text-3xl font-bold text-[var(--color-tron-cyan)]">
					{data.pagination?.lotsTotal ?? 0}
				</div>
				<div class="tron-text-muted text-sm">Total Lots</div>
			</div>
		</TronCard>
		<TronCard>
			<div class="text-center">
				<div class="font-mono text-3xl font-bold text-[var(--color-tron-cyan)]">
					{data.pagination?.packagesTotal ?? 0}
				</div>
				<div class="tron-text-muted text-sm">Total Packages</div>
			</div>
		</TronCard>
		<TronCard>
			<div class="text-center">
				<div class="font-mono text-3xl font-bold text-[var(--color-tron-green)]">
					{openLots}
				</div>
				<div class="tron-text-muted text-sm">Open Lots</div>
			</div>
		</TronCard>
		<TronCard>
			<div class="text-center">
				<div class="font-mono text-3xl font-bold text-[var(--color-tron-green)]">
					{shippedPackages}
				</div>
				<div class="tron-text-muted text-sm">Shipped Packages</div>
			</div>
		</TronCard>
	</div>

	<!-- Tab Bar -->
	<div class="flex items-center gap-1 border-b border-[var(--color-tron-border)]">
		<button
			class="px-4 py-2 text-sm font-medium transition-colors {activeTab === 'lots'
				? 'border-b-2 border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
				: 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}"
			onclick={() => switchTab('lots')}
		>
			Shipping Lots
		</button>
		<button
			class="px-4 py-2 text-sm font-medium transition-colors {activeTab === 'packages'
				? 'border-b-2 border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
				: 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}"
			onclick={() => switchTab('packages')}
		>
			Packages
		</button>
	</div>

	<!-- ═══ LOTS TAB ═══ -->
	{#if activeTab === 'lots'}
		<div class="flex items-center justify-between">
			<span class="tron-text-muted text-sm">{data.lots?.length ?? 0} lots on this page</span>
			<TronButton variant="primary" onclick={() => (showAddLot = !showAddLot)}>
				{showAddLot ? 'Cancel' : 'Create Lot'}
			</TronButton>
		</div>

		<!-- Create Lot Form -->
		{#if showAddLot}
			<TronCard>
				<h3 class="tron-text-primary mb-3 font-mono text-sm font-semibold">Create Shipping Lot</h3>
				<form
					method="POST"
					action="?/createLot"
					use:enhance={() => {
						submitting = true;
						return async ({ update }) => {
							submitting = false;
							showAddLot = false;
							await update();
						};
					}}
				>
					<div class="grid gap-3 sm:grid-cols-2">
						<div>
							<label class="tron-text-muted mb-1 block text-xs">Assay ID</label>
							<input type="text" name="assayId" class="tron-input w-full" placeholder="Assay ID" />
						</div>
						<div>
							<label class="tron-text-muted mb-1 block text-xs">Assay Name</label>
							<input type="text" name="assayName" class="tron-input w-full" placeholder="Assay Name" />
						</div>
						<div>
							<label class="tron-text-muted mb-1 block text-xs">Customer ID</label>
							<input type="text" name="customerId" class="tron-input w-full" placeholder="Customer ID" />
						</div>
						<div>
							<label class="tron-text-muted mb-1 block text-xs">Customer Name</label>
							<input type="text" name="customerName" class="tron-input w-full" placeholder="Customer Name" />
						</div>
						<div class="sm:col-span-2">
							<label class="tron-text-muted mb-1 block text-xs">Notes</label>
							<input type="text" name="notes" class="tron-input w-full" placeholder="Optional notes" />
						</div>
					</div>
					<div class="mt-3 flex justify-end">
						<TronButton type="submit" variant="primary" disabled={submitting}>
							{submitting ? 'Creating...' : 'Create Lot'}
						</TronButton>
					</div>
				</form>
			</TronCard>
		{/if}

		<!-- Lots Table -->
		<TronCard>
			<div class="overflow-x-auto">
				<table class="tron-table">
					<thead>
						<tr>
							<th></th>
							<th>Lot ID</th>
							<th>Assay</th>
							<th>Customer</th>
							<th>Status</th>
							<th>Cartridges</th>
							<th>QA/QC</th>
							<th>Released By</th>
							<th>Released At</th>
							<th>Notes</th>
							<th>Created</th>
							<th>Actions</th>
						</tr>
					</thead>
					<tbody>
						{#each data.lots ?? [] as lot (lot.id)}
							<tr>
								<td>
									{#if lot.qaqcReleases && lot.qaqcReleases.length > 0}
										<button
											class="text-xs text-[var(--color-tron-cyan)]"
											onclick={() => (expandedLotId = expandedLotId === lot.id ? null : lot.id)}
										>
											{expandedLotId === lot.id ? '▼' : '▶'}
										</button>
									{/if}
								</td>
								<td class="font-mono text-[var(--color-tron-cyan)]">{lot.id}</td>
								<td>{lot.assayType?.name ?? '—'}</td>
								<td>{lot.customer?.name ?? '—'}</td>
								<td><TronBadge variant={getLotStatusVariant(lot.status)}>{lot.status}</TronBadge></td>
								<td class="text-center font-mono">{lot.cartridgeCount ?? 0}</td>
								<td class="text-center">
									{#if lot.qaqcReleases && lot.qaqcReleases.length > 0}
										<TronBadge variant="info">{lot.qaqcReleases.length}</TronBadge>
									{:else}
										<span class="tron-text-muted">0</span>
									{/if}
								</td>
								<td>{lot.releasedBy ?? '—'}</td>
								<td class="tron-text-muted text-xs">{formatDate(lot.releasedAt)}</td>
								<td class="max-w-[150px] truncate text-xs" title={lot.notes}>{lot.notes ?? '—'}</td>
								<td class="tron-text-muted text-xs">{formatDate(lot.createdAt)}</td>
								<td>
									<form
										method="POST"
										action="?/updateLotStatus"
										use:enhance={() => {
											return async ({ update }) => { await update(); };
										}}
									>
										<input type="hidden" name="lotId" value={lot.id} />
										<select
											name="status"
											class="tron-input text-xs"
											style="min-width: 90px"
											onchange={(e: Event) => (e.target as HTMLFormElement).form?.requestSubmit()}
										>
											<option value="" disabled selected>Change...</option>
											<option value="open">Open</option>
											<option value="testing">Testing</option>
											<option value="released">Released</option>
											<option value="shipped">Shipped</option>
											<option value="cancelled">Cancelled</option>
										</select>
									</form>
								</td>
							</tr>
							<!-- Expanded QA/QC detail -->
							{#if expandedLotId === lot.id && lot.qaqcReleases}
								<tr>
									<td colspan="12" class="bg-[var(--color-tron-bg-primary)] p-3">
										<div class="mb-2 text-xs font-semibold text-[var(--color-tron-cyan)]">QA/QC Releases</div>
										<table class="tron-table text-xs">
											<thead>
												<tr>
													<th>Run ID</th>
													<th>Cartridge IDs</th>
													<th>Result</th>
													<th>Tested By</th>
													<th>Tested At</th>
													<th>Notes</th>
												</tr>
											</thead>
											<tbody>
												{#each lot.qaqcReleases as release (release._id)}
													<tr>
														<td class="font-mono">{release.reagentRunId ?? '—'}</td>
														<td class="font-mono">{release.qaqcCartridgeIds?.join(', ') ?? '—'}</td>
														<td>
															<TronBadge variant={release.testResult === 'pass' ? 'success' : release.testResult === 'fail' ? 'error' : 'warning'}>
																{release.testResult}
															</TronBadge>
														</td>
														<td>{release.testedBy?.username ?? '—'}</td>
														<td>{formatDateTime(release.testedAt)}</td>
														<td>{release.notes ?? '—'}</td>
													</tr>
												{/each}
											</tbody>
										</table>
										<!-- Add QA/QC Release mini-form -->
										<form
											method="POST"
											action="?/addQaqcRelease"
											class="mt-2 flex flex-wrap items-end gap-2"
											use:enhance={() => {
												submitting = true;
												return async ({ update }) => {
													submitting = false;
													await update();
												};
											}}
										>
											<input type="hidden" name="lotId" value={lot.id} />
											<div>
												<label class="tron-text-muted mb-1 block text-xs">Run ID</label>
												<input type="text" name="reagentRunId" class="tron-input text-xs" placeholder="Run ID" />
											</div>
											<div>
												<label class="tron-text-muted mb-1 block text-xs">Cartridge IDs (comma sep)</label>
												<input type="text" name="qaqcCartridgeIds" class="tron-input text-xs" placeholder="id1,id2" />
											</div>
											<div>
												<label class="tron-text-muted mb-1 block text-xs">Result</label>
												<select name="testResult" class="tron-input text-xs">
													<option value="pass">Pass</option>
													<option value="fail">Fail</option>
													<option value="pending">Pending</option>
												</select>
											</div>
											<div>
												<label class="tron-text-muted mb-1 block text-xs">Notes</label>
												<input type="text" name="notes" class="tron-input text-xs" />
											</div>
											<TronButton type="submit" variant="default" disabled={submitting}>
												Add Release
											</TronButton>
										</form>
									</td>
								</tr>
							{/if}
						{:else}
							<tr>
								<td colspan="12" class="tron-text-muted text-center">No shipping lots yet.</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</TronCard>
	{/if}

	<!-- ═══ PACKAGES TAB ═══ -->
	{#if activeTab === 'packages'}
		<div class="flex items-center justify-between">
			<span class="tron-text-muted text-sm">{data.packages?.length ?? 0} packages on this page</span>
			<TronButton variant="primary" onclick={() => (showAddPackage = !showAddPackage)}>
				{showAddPackage ? 'Cancel' : 'Create Package'}
			</TronButton>
		</div>

		<!-- Create Package Form -->
		{#if showAddPackage}
			<TronCard>
				<h3 class="tron-text-primary mb-3 font-mono text-sm font-semibold">Create Package</h3>
				<form
					method="POST"
					action="?/createPackage"
					use:enhance={() => {
						submitting = true;
						return async ({ update }) => {
							submitting = false;
							showAddPackage = false;
							await update();
						};
					}}
				>
					<div class="grid gap-3 sm:grid-cols-2">
						<div>
							<label class="tron-text-muted mb-1 block text-xs">Customer ID *</label>
							<input type="text" name="customerId" class="tron-input w-full" required placeholder="Customer ID" />
						</div>
						<div>
							<label class="tron-text-muted mb-1 block text-xs">Barcode</label>
							<input type="text" name="barcode" class="tron-input w-full" placeholder="Package barcode" />
						</div>
						<div>
							<label class="tron-text-muted mb-1 block text-xs">Carrier</label>
							<input type="text" name="carrier" class="tron-input w-full" placeholder="e.g. FedEx, UPS" />
						</div>
						<div>
							<label class="tron-text-muted mb-1 block text-xs">Notes</label>
							<input type="text" name="notes" class="tron-input w-full" placeholder="Optional notes" />
						</div>
					</div>
					<div class="mt-3 flex justify-end">
						<TronButton type="submit" variant="primary" disabled={submitting}>
							{submitting ? 'Creating...' : 'Create Package'}
						</TronButton>
					</div>
				</form>
			</TronCard>
		{/if}

		<!-- Packages Table -->
		<TronCard>
			<div class="overflow-x-auto">
				<table class="tron-table">
					<thead>
						<tr>
							<th>Package ID</th>
							<th>Barcode</th>
							<th>Customer</th>
							<th>Carrier</th>
							<th>Tracking #</th>
							<th>Status</th>
							<th>Cartridges</th>
							<th>Packed By</th>
							<th>Packed At</th>
							<th>Shipped At</th>
							<th>Delivered At</th>
							<th>Actions</th>
						</tr>
					</thead>
					<tbody>
						{#each data.packages ?? [] as pkg (pkg.id)}
							<tr>
								<td class="font-mono text-xs text-[var(--color-tron-cyan)]">{pkg.id}</td>
								<td class="font-mono text-xs">{pkg.barcode ?? '—'}</td>
								<td>{pkg.customer?.name ?? '—'}</td>
								<td>{pkg.carrier ?? '—'}</td>
								<td class="font-mono text-xs">{pkg.trackingNumber ?? '—'}</td>
								<td><TronBadge variant={getPkgStatusVariant(pkg.status)}>{pkg.status}</TronBadge></td>
								<td class="text-center font-mono">{pkg.cartridges?.length ?? 0}</td>
								<td>{pkg.packedBy ?? '—'}</td>
								<td class="tron-text-muted text-xs">{formatDate(pkg.packedAt)}</td>
								<td class="tron-text-muted text-xs">{formatDate(pkg.shippedAt)}</td>
								<td class="tron-text-muted text-xs">{formatDate(pkg.deliveredAt)}</td>
								<td>
									<div class="flex flex-col gap-1">
										<!-- Status Change with optional tracking -->
										<form
											method="POST"
											action="?/updatePackageStatus"
											class="flex items-center gap-1"
											use:enhance={() => {
												return async ({ update }) => { await update(); };
											}}
										>
											<input type="hidden" name="packageId" value={pkg.id} />
											<input type="text" name="trackingNumber" class="tron-input w-24 text-xs" placeholder="Tracking #" />
											<select
												name="status"
												class="tron-input text-xs"
												style="min-width: 80px"
												onchange={(e: Event) => (e.target as HTMLFormElement).form?.requestSubmit()}
											>
												<option value="" disabled selected>Status...</option>
												<option value="created">Created</option>
												<option value="packing">Packing</option>
												<option value="packed">Packed</option>
												<option value="shipped">Shipped</option>
												<option value="delivered">Delivered</option>
											</select>
										</form>
										<!-- Add Cartridge -->
										<form
											method="POST"
											action="?/addCartridgeToPackage"
											class="flex items-center gap-1"
											use:enhance={() => {
												return async ({ update }) => { await update(); };
											}}
										>
											<input type="hidden" name="packageId" value={pkg.id} />
											<input type="text" name="cartridgeId" class="tron-input w-24 text-xs" placeholder="Cart ID" />
											<TronButton type="submit" variant="default">Add</TronButton>
										</form>
									</div>
								</td>
							</tr>
						{:else}
							<tr>
								<td colspan="12" class="tron-text-muted text-center">No packages created yet.</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</TronCard>
	{/if}

	<!-- Pagination -->
	{#if data.pagination && (data.pagination.hasPrev || data.pagination.hasNext)}
		<div class="flex items-center justify-between">
			<button
				class="tron-button"
				disabled={!data.pagination.hasPrev}
				onclick={() => goToPage(data.pagination.page - 1)}
			>
				Previous
			</button>
			<span class="tron-text-muted text-sm">
				Page {data.pagination.page} of {Math.ceil(activeTabTotal / data.pagination.limit) || 1}
			</span>
			<button
				class="tron-button"
				disabled={!data.pagination.hasNext}
				onclick={() => goToPage(data.pagination.page + 1)}
			>
				Next
			</button>
		</div>
	{/if}
</div>
