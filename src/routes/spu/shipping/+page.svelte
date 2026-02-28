<script lang="ts">
	import { enhance } from '$app/forms';
	import { generateTestBarcode } from '$lib/utils/test-barcode';

	let { data, form } = $props();

	let showCreateForm = $state(false);
	let expandedId = $state<string | null>(null);
	let addCartridgeInput = $state('');
	let scanInput = $state('');
	let scanPackageId = $state('');
	let filterAssayTypeId = $state<string | null>(null);

	const statusColors: Record<string, string> = {
		created: 'border-[var(--color-tron-text-secondary)] text-[var(--color-tron-text-secondary)]',
		packed: 'border-[var(--color-tron-blue)] text-[var(--color-tron-blue)]',
		shipped: 'border-[var(--color-tron-yellow)] text-[var(--color-tron-yellow)]',
		delivered: 'border-[var(--color-tron-green)] text-[var(--color-tron-green)]'
	};

	const nextStatus: Record<string, string> = {
		created: 'packed',
		packed: 'shipped',
		shipped: 'delivered'
	};

	let filteredReadyCartridges = $derived(
		filterAssayTypeId
			? data.readyCartridges.filter((c) => c.assayTypeId === filterAssayTypeId)
			: data.readyCartridges
	);

	let availablePackages = $derived(
		data.packages.filter((p) => p.status === 'created' || p.status === 'packed')
	);

	function formatDate(d: string | null): string {
		if (!d) return '—';
		return new Date(d).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		});
	}
</script>

<svelte:head>
	<title>Shipping | Bioscale</title>
</svelte:head>

<div class="space-y-6">
	<p class="text-[10px] italic text-[var(--color-tron-text-secondary)]/60">Idea: admin planning run and operator fulfilling preset page, different page views, same as old manufacturing system.</p>
	<div class="flex items-center justify-between">
		<div>
			<h2 class="text-lg font-semibold" style="color: var(--color-tron-cyan)">
				Shipping Packages
			</h2>
			<p class="text-sm" style="color: var(--color-tron-text-secondary)">
				Create packages, add cartridges, and track fulfillment
			</p>
		</div>
		<button
			type="button"
			onclick={() => {
				showCreateForm = !showCreateForm;
			}}
			class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)]"
		>
			{showCreateForm ? 'Cancel' : '+ New Package'}
		</button>
	</div>

	{#if form?.error}
		<div
			class="rounded border px-4 py-2 text-sm"
			style="border-color: var(--color-tron-error); color: var(--color-tron-error)"
		>
			{form.error}
		</div>
	{/if}

	{#if form?.success}
		<div
			class="rounded border px-4 py-2 text-sm"
			style="border-color: var(--color-tron-green); color: var(--color-tron-green)"
		>
			{form.message}
		</div>
	{/if}

	<!-- UPS API Integration - Planned -->
	<div class="rounded border border-[var(--color-tron-blue)]/40 bg-[var(--color-tron-blue)]/5 p-4">
		<div class="mb-3 flex items-center gap-3">
			<svg class="h-5 w-5 text-[var(--color-tron-blue)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
			</svg>
			<h3 class="text-sm font-medium text-[var(--color-tron-blue)]">UPS API Integration</h3>
			<span class="rounded border border-[var(--color-tron-yellow)]/50 bg-[var(--color-tron-yellow)]/10 px-2 py-0.5 text-[10px] font-medium text-[var(--color-tron-yellow)]">Planned</span>
		</div>
		<ul class="space-y-1.5 text-xs text-[var(--color-tron-text-secondary)]">
			<li class="flex items-center gap-2">
				<span class="h-1 w-1 rounded-full bg-[var(--color-tron-blue)]/60"></span>
				Generate shipping labels directly from packages
			</li>
			<li class="flex items-center gap-2">
				<span class="h-1 w-1 rounded-full bg-[var(--color-tron-blue)]/60"></span>
				Real-time tracking updates
			</li>
			<li class="flex items-center gap-2">
				<span class="h-1 w-1 rounded-full bg-[var(--color-tron-blue)]/60"></span>
				Rate quotes for service levels (Ground, 2-Day, Next Day)
			</li>
			<li class="flex items-center gap-2">
				<span class="h-1 w-1 rounded-full bg-[var(--color-tron-blue)]/60"></span>
				Address validation before shipping
			</li>
			<li class="flex items-center gap-2">
				<span class="h-1 w-1 rounded-full bg-[var(--color-tron-blue)]/60"></span>
				Automatic status updates on delivery
			</li>
			<li class="flex items-center gap-2">
				<span class="h-1 w-1 rounded-full bg-[var(--color-tron-blue)]/60"></span>
				Pickup scheduling
			</li>
		</ul>
	</div>

	<!-- Ready to Ship Section -->
	{#if data.readyCartridges.length > 0}
		<div class="rounded border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/5 p-4">
			<h3 class="mb-3 text-sm font-medium text-[var(--color-tron-cyan)]">
				Ready to Ship
				<span class="ml-2 text-xs text-[var(--color-tron-text-secondary)]">({data.readyCartridges.length} cartridges)</span>
			</h3>

			<!-- Count badges by assay type -->
			<div class="mb-3 flex flex-wrap gap-2">
				<button
					type="button"
					onclick={() => { filterAssayTypeId = null; }}
					class="min-h-[32px] rounded border px-3 py-1 text-xs font-medium {filterAssayTypeId === null
						? 'border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]'
						: 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]'}"
				>
					All ({data.readyCartridges.length})
				</button>
				{#each data.readyCounts as rc (rc.assayTypeId)}
					<button
						type="button"
						onclick={() => { filterAssayTypeId = filterAssayTypeId === rc.assayTypeId ? null : rc.assayTypeId; }}
						class="min-h-[32px] rounded border px-3 py-1 text-xs font-medium {filterAssayTypeId === rc.assayTypeId
							? 'border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]'
							: 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]'}"
					>
						{rc.assayTypeName} ({rc.count})
					</button>
				{/each}
			</div>

			<!-- QR/barcode scan input -->
			{#if availablePackages.length > 0}
				<form
					method="POST"
					action="?/scanCartridge"
					use:enhance={() => {
						return async ({ result, update }) => {
							if (result.type === 'success') scanInput = '';
							await update();
						};
					}}
					class="mb-3 flex items-end gap-3"
				>
					<div>
						<label class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]" for="scan-package">Target Package</label>
						<select
							id="scan-package"
							name="packageId"
							bind:value={scanPackageId}
							required
							class="min-h-[36px] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-2 py-1 text-sm text-[var(--color-tron-text)]"
						>
							<option value="">Select package...</option>
							{#each availablePackages as pkg (pkg.id)}
								<option value={pkg.id}>{pkg.barcode} — {pkg.customerName}</option>
							{/each}
						</select>
					</div>
					<div class="flex-1">
						<label class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]" for="scan-input">Scan Cartridge ID</label>
						<input
							id="scan-input"
							name="cartridgeId"
							bind:value={scanInput}
							placeholder="Scan or type cartridge ID..."
							required
							class="min-h-[36px] w-full rounded border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-bg)] px-3 py-1 text-sm text-[var(--color-tron-text)]"
						/>
					</div>
					<button
						type="submit"
						class="min-h-[36px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-4 py-1 text-xs font-medium text-[var(--color-tron-cyan)]"
					>
						Add to Package
					</button>
					<button
						type="button"
						onclick={() => { scanInput = data.readyCartridges.length > 0 ? data.readyCartridges[0].cartridgeId : generateTestBarcode('CART'); }}
						class="min-h-[36px] rounded border border-[var(--color-tron-border)] px-3 py-1 text-xs text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-orange)] hover:text-[var(--color-tron-orange)]"
					>
						Test
					</button>
				</form>
			{/if}

			<!-- Ready cartridges table -->
			<div class="overflow-x-auto rounded border border-[var(--color-tron-border)]/50">
				<table class="w-full text-xs">
					<thead>
						<tr class="border-b border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
							<th class="px-3 py-2 text-left font-medium text-[var(--color-tron-text-secondary)]">Cartridge ID</th>
							<th class="px-3 py-2 text-left font-medium text-[var(--color-tron-text-secondary)]">Assay Type</th>
							<th class="px-3 py-2 text-left font-medium text-[var(--color-tron-text-secondary)]">Status</th>
							<th class="px-3 py-2 text-left font-medium text-[var(--color-tron-text-secondary)]">Storage</th>
							<th class="px-3 py-2 text-left font-medium text-[var(--color-tron-text-secondary)]">Created</th>
						</tr>
					</thead>
					<tbody>
						{#each filteredReadyCartridges as cart (cart.id)}
							<tr class="border-b border-[var(--color-tron-border)]/30 hover:bg-[var(--color-tron-surface)]/30">
								<td class="px-3 py-2 font-mono text-[var(--color-tron-cyan)]">{cart.cartridgeId}</td>
								<td class="px-3 py-2 text-[var(--color-tron-text)]">{cart.assayTypeName}</td>
								<td class="px-3 py-2">
									<span class="rounded border border-green-500/30 bg-green-900/20 px-1.5 py-0.5 text-green-400">{cart.currentStatus}</span>
								</td>
								<td class="px-3 py-2 text-[var(--color-tron-text-secondary)]">{cart.storageLocation ?? '—'}{cart.fridgeId ? ` (${cart.fridgeId})` : ''}</td>
								<td class="px-3 py-2 text-[var(--color-tron-text-secondary)]">{formatDate(cart.createdAt)}</td>
							</tr>
						{/each}
						{#if filteredReadyCartridges.length === 0}
							<tr>
								<td colspan="5" class="px-3 py-4 text-center text-[var(--color-tron-text-secondary)]">
									{filterAssayTypeId ? 'No cartridges match this filter.' : 'No cartridges ready to ship.'}
								</td>
							</tr>
						{/if}
					</tbody>
				</table>
			</div>
		</div>
	{/if}

	<!-- Create Package Form -->
	{#if showCreateForm}
		<div
			class="rounded border p-4"
			style="border-color: var(--color-tron-cyan); background: rgba(0,255,255,0.03)"
		>
			<h3 class="mb-3 text-sm font-medium" style="color: var(--color-tron-text)">
				Create New Package
			</h3>
			<form
				method="POST"
				action="?/createPackage"
				use:enhance={() => {
					return async ({ result, update }) => {
						if (result.type === 'success') showCreateForm = false;
						await update();
					};
				}}
			>
				<div class="flex gap-3">
					<select
						name="customerId"
						required
						class="min-h-[44px] flex-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
					>
						<option value="">Select Customer</option>
						{#each data.customers as c (c.id)}
							<option value={c.id}>{c.name}</option>
						{/each}
					</select>
					<input
						name="notes"
						placeholder="Notes (optional)"
						class="min-h-[44px] w-64 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
					/>
					<button
						type="submit"
						class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)]"
					>
						Create
					</button>
				</div>
			</form>
		</div>
	{/if}

	<!-- Packages Table -->
	<div class="overflow-x-auto rounded border border-[var(--color-tron-border)]">
		<table class="w-full text-sm">
			<thead>
				<tr class="border-b border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
					<th
						class="px-4 py-3 text-left font-medium text-[var(--color-tron-text-secondary)]"
						>Package ID</th
					>
					<th
						class="px-4 py-3 text-left font-medium text-[var(--color-tron-text-secondary)]"
						>Customer</th
					>
					<th
						class="px-4 py-3 text-left font-medium text-[var(--color-tron-text-secondary)]"
						>Status</th
					>
					<th
						class="px-4 py-3 text-right font-medium text-[var(--color-tron-text-secondary)]"
						>Cartridges</th
					>
					<th
						class="px-4 py-3 text-left font-medium text-[var(--color-tron-text-secondary)]"
						>Tracking</th
					>
					<th
						class="px-4 py-3 text-left font-medium text-[var(--color-tron-text-secondary)]"
						>Carrier</th
					>
					<th
						class="px-4 py-3 text-left font-medium text-[var(--color-tron-text-secondary)]"
						>Created</th
					>
					<th
						class="px-4 py-3 text-right font-medium text-[var(--color-tron-text-secondary)]"
						>Actions</th
					>
				</tr>
			</thead>
			<tbody>
				{#each data.packages as pkg (pkg.id)}
					<tr class="border-b border-[var(--color-tron-border)]/50 hover:bg-[var(--color-tron-surface)]/50">
						<td class="px-4 py-3 font-mono text-xs" style="color: var(--color-tron-cyan)"
							>{pkg.barcode}</td
						>
						<td class="px-4 py-3 text-[var(--color-tron-text)]">{pkg.customerName}</td>
						<td class="px-4 py-3">
							<span
								class="rounded border px-1.5 py-0.5 text-xs font-medium {statusColors[
									pkg.status
								] ?? ''}"
							>
								{pkg.status}
							</span>
						</td>
						<td class="px-4 py-3 text-right font-mono text-[var(--color-tron-text)]"
							>{pkg.cartridgeCount}</td
						>
						<td class="px-4 py-3 text-xs text-[var(--color-tron-text-secondary)]"
							>{pkg.trackingNumber ?? '—'}</td
						>
						<td class="px-4 py-3 text-xs text-[var(--color-tron-text-secondary)]"
							>{pkg.carrier ?? '—'}</td
						>
						<td class="px-4 py-3 text-xs text-[var(--color-tron-text-secondary)]"
							>{formatDate(pkg.createdAt)}</td
						>
						<td class="px-4 py-3 text-right">
							<div class="flex items-center justify-end gap-2">
								{#if nextStatus[pkg.status]}
									<form method="POST" action="?/updateStatus" use:enhance>
										<input type="hidden" name="packageId" value={pkg.id} />
										<input
											type="hidden"
											name="status"
											value={nextStatus[pkg.status]}
										/>
										<button
											type="submit"
											class="min-h-[36px] text-xs text-[var(--color-tron-cyan)] hover:underline"
										>
											Mark {nextStatus[pkg.status]}
										</button>
									</form>
								{/if}
								<button
									type="button"
									onclick={() => {
										expandedId = expandedId === pkg.id ? null : pkg.id;
									}}
									class="min-h-[36px] text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]"
								>
									{expandedId === pkg.id ? 'Hide' : 'Details'}
								</button>
							</div>
						</td>
					</tr>
					{#if expandedId === pkg.id}
						<tr>
							<td
								colspan="8"
								class="bg-[var(--color-tron-surface)]/30 px-4 py-4"
							>
								<div class="space-y-4">
									<!-- Tracking Info -->
									<form
										method="POST"
										action="?/updateTracking"
										use:enhance
										class="flex items-end gap-3"
									>
										<input
											type="hidden"
											name="packageId"
											value={pkg.id}
										/>
										<div>
											<label
												class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]"
												for="tracking-{pkg.id}">Tracking Number</label
											>
											<input
												id="tracking-{pkg.id}"
												name="trackingNumber"
												value={pkg.trackingNumber ?? ''}
												class="min-h-[36px] w-48 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm text-[var(--color-tron-text)]"
											/>
										</div>
										<div>
											<label
												class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]"
												for="carrier-{pkg.id}">Carrier</label
											>
											<select
												id="carrier-{pkg.id}"
												name="carrier"
												class="min-h-[36px] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm text-[var(--color-tron-text)]"
											>
												<option value="">None</option>
												<option
													value="FedEx"
													selected={pkg.carrier === 'FedEx'}
													>FedEx</option
												>
												<option
													value="UPS"
													selected={pkg.carrier === 'UPS'}
													>UPS</option
												>
												<option
													value="USPS"
													selected={pkg.carrier === 'USPS'}
													>USPS</option
												>
												<option
													value="DHL"
													selected={pkg.carrier === 'DHL'}
													>DHL</option
												>
											</select>
										</div>
										<button
											type="submit"
											class="min-h-[36px] rounded border border-[var(--color-tron-border)] px-3 py-1 text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]"
											>Save Tracking</button
										>
									</form>

									<!-- Add Cartridges -->
									{#if pkg.status === 'created' || pkg.status === 'packed'}
										<form
											method="POST"
											action="?/addCartridges"
											use:enhance={() => {
												return async ({ update }) => {
													addCartridgeInput = '';
													await update();
												};
											}}
											class="flex items-end gap-3"
										>
											<input
												type="hidden"
												name="packageId"
												value={pkg.id}
											/>
											<div class="flex-1">
												<label
													class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]"
													for="cartridges-{pkg.id}"
													>Add Cartridges (comma-separated IDs)</label
												>
												<input
													id="cartridges-{pkg.id}"
													name="cartridgeIds"
													bind:value={addCartridgeInput}
													placeholder="CART-001, CART-002..."
													class="min-h-[36px] w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm text-[var(--color-tron-text)]"
												/>
											</div>
											<button
												type="submit"
												class="min-h-[36px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-3 py-1 text-xs text-[var(--color-tron-cyan)]"
												>Add</button
											>
										</form>
									{/if}

									<!-- Timestamps -->
									<div
										class="flex gap-6 text-xs text-[var(--color-tron-text-secondary)]"
									>
										<span>Created: {formatDate(pkg.createdAt)}</span>
										<span>Packed: {formatDate(pkg.packedAt)}</span>
										<span>Shipped: {formatDate(pkg.shippedAt)}</span>
										<span
											>Delivered: {formatDate(pkg.deliveredAt)}</span
										>
									</div>
									{#if pkg.notes}
										<p
											class="text-xs italic text-[var(--color-tron-text-secondary)]"
										>
											{pkg.notes}
										</p>
									{/if}
								</div>
							</td>
						</tr>
					{/if}
				{/each}
				{#if data.packages.length === 0}
					<tr>
						<td
							colspan="8"
							class="px-4 py-8 text-center text-sm text-[var(--color-tron-text-secondary)]"
						>
							No shipping packages yet. Create one to get started.
						</td>
					</tr>
				{/if}
			</tbody>
		</table>
	</div>
</div>
