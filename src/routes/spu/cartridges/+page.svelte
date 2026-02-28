<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { getTestCartridgeData } from '$lib/utils/test-data';

	let { data, form } = $props();

	let showRegisterModal = $state(false);
	let showScanModal = $state(false);
	let scanBarcode = $state('');
	let scanError = $state('');
	let scanLoading = $state(false);
	let searchInput = $state(data.filters.q ?? '');

	// Register modal controlled state
	let regBarcode = $state('');
	let regLotNumber = $state('');
	let regCartridgeType = $state('');
	let regSerialNumber = $state('');
	let regGroupId = $state('');
	let regManufacturer = $state('');
	let regExpirationDate = $state('');
	let regTotalUses = $state('');
	let regStorageLocation = $state('');
	let regStorageConditions = $state('');
	let regNotes = $state('');

	function resetRegisterForm() {
		regBarcode = '';
		regLotNumber = '';
		regCartridgeType = '';
		regSerialNumber = '';
		regGroupId = '';
		regManufacturer = '';
		regExpirationDate = '';
		regTotalUses = '';
		regStorageLocation = '';
		regStorageConditions = '';
		regNotes = '';
	}

	function fillRegisterTestData() {
		const td = getTestCartridgeData();
		regBarcode = td.barcode;
		regLotNumber = td.lotNumber;
		regCartridgeType = td.cartridgeType;
		regSerialNumber = td.serialNumber;
		regManufacturer = td.manufacturer;
		regExpirationDate = td.expirationDate;
		regTotalUses = td.totalUses;
		regStorageLocation = td.storageLocation;
		regStorageConditions = td.storageConditions;
		regNotes = td.notes;
	}

	async function handleScan() {
		if (!scanBarcode.trim()) return;
		scanLoading = true;
		scanError = '';
		try {
			const res = await fetch('/spu/cartridges/scan', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ barcode: scanBarcode.trim() })
			});
			if (res.ok) {
				const cartridgeData = await res.json();
				showScanModal = false;
				goto(`/spu/cartridges/${cartridgeData.id}`);
			} else {
				const err = await res.json();
				scanError = err.message ?? 'Cartridge not found';
			}
		} catch {
			scanError = 'Scan failed';
		} finally {
			scanLoading = false;
		}
	}

	function handleSearch(e: Event) {
		e.preventDefault();
		const params = new URLSearchParams();
		if (searchInput.trim()) params.set('q', searchInput.trim());
		goto(`/spu/cartridges?${params.toString()}`);
	}

	function getStatusColor(status: string) {
		const colors: Record<string, string> = {
			available: 'var(--color-tron-green, #39ff14)',
			in_use: 'var(--color-tron-cyan, #00ffff)',
			depleted: 'var(--color-tron-text-secondary, #6b7280)',
			expired: '#ef4444',
			quarantine: '#f97316',
			disposed: '#6b7280'
		};
		return colors[status] ?? '#6b7280';
	}

	function getTypeLabel(type: string) {
		const labels: Record<string, string> = {
			measurement: 'Measurement',
			calibration: 'Calibration',
			reference: 'Reference',
			test: 'Test'
		};
		return labels[type] ?? type;
	}
</script>

<div class="mx-auto max-w-7xl space-y-6 p-4">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan, #00ffff)">Cartridges</h1>
		<div class="flex gap-2">
			<a
				href="/spu/cartridges/export?format=csv"
				class="tron-button"
				style="min-height: 44px; background: var(--color-tron-green, #39ff14); color: #000; font-weight: 600"
			>
				Export CSV
			</a>
			<a
				href="/spu/cartridges/export?format=json"
				class="tron-button"
				style="min-height: 44px"
			>
				Export JSON
			</a>
			<button class="tron-button" style="min-height: 44px" onclick={() => (showScanModal = true)}>
				Scan Barcode
			</button>
			{#if data.canWrite}
				<button
					class="tron-button"
					style="min-height: 44px; background: var(--color-tron-cyan, #00ffff); color: #000"
					onclick={() => { resetRegisterForm(); showRegisterModal = true; }}
				>
					+ Register
				</button>
			{/if}
			{#if data.canAdmin}
				<form method="POST" action="?/seed" use:enhance>
					<button class="tron-button" style="min-height: 44px; opacity: 0.7" type="submit">
						Seed Test Data
					</button>
				</form>
			{/if}
		</div>
	</div>

	<!-- Stats Cards -->
	<div class="grid grid-cols-2 gap-4 md:grid-cols-4">
		<div class="tron-card p-4 text-center">
			<div class="text-2xl font-bold" style="color: var(--color-tron-cyan, #00ffff)">
				{data.stats.total}
			</div>
			<div class="text-sm" style="color: var(--color-tron-text-secondary, #9ca3af)">Total</div>
		</div>
		<div class="tron-card p-4 text-center">
			<div class="text-2xl font-bold" style="color: var(--color-tron-green, #39ff14)">
				{data.stats.available}
			</div>
			<div class="text-sm" style="color: var(--color-tron-text-secondary, #9ca3af)">
				Available
			</div>
		</div>
		<div class="tron-card p-4 text-center">
			<div class="text-2xl font-bold" style="color: var(--color-tron-cyan, #00ffff)">
				{data.stats.inUse}
			</div>
			<div class="text-sm" style="color: var(--color-tron-text-secondary, #9ca3af)">In Use</div>
		</div>
		<div class="tron-card p-4 text-center">
			<div class="text-2xl font-bold" style="color: #f97316">
				{data.stats.expiringSoon}
			</div>
			<div class="text-sm" style="color: var(--color-tron-text-secondary, #9ca3af)">
				Expiring Soon
			</div>
		</div>
	</div>

	<!-- Search & Filters -->
	<div class="tron-card p-4">
		<form onsubmit={handleSearch} class="flex flex-wrap items-end gap-3">
			<div class="flex-1">
				<input
					type="text"
					class="tron-input w-full"
					style="min-height: 44px"
					placeholder="Search barcode, serial, lot, manufacturer..."
					bind:value={searchInput}
				/>
			</div>
			<button class="tron-button" style="min-height: 44px" type="submit">Search</button>
			{#if data.filters.q}
				<a href="/spu/cartridges" class="tron-button" style="min-height: 44px; opacity: 0.7">
					Clear
				</a>
			{/if}
		</form>
	</div>

	<!-- Table -->
	{#if data.cartridges.length === 0}
		<div class="tron-card p-8 text-center">
			<p style="color: var(--color-tron-text-secondary, #9ca3af)">
				No cartridges found. Register one or seed test data.
			</p>
		</div>
	{:else}
		<div class="overflow-x-auto">
			<table class="tron-table w-full">
				<thead>
					<tr>
						<th>Barcode</th>
						<th>Serial #</th>
						<th>Lot #</th>
						<th>Type</th>
						<th>Status</th>
						<th>Group</th>
						<th>Firmware</th>
						<th>Expiration</th>
						<th>Uses</th>
					</tr>
				</thead>
				<tbody>
					{#each data.cartridges as c (c.id)}
						<tr
							style="cursor: pointer"
							onclick={() => goto(`/spu/cartridges/${c.id}`)}
						>
							<td style="color: var(--color-tron-cyan, #00ffff); font-family: monospace">
								{c.barcode}
							</td>
							<td>{c.serialNumber ?? '—'}</td>
							<td>{c.lotNumber}</td>
							<td>{getTypeLabel(c.cartridgeType)}</td>
							<td>
								<span
									class="inline-block rounded px-2 py-1 text-xs font-semibold"
									style="background: color-mix(in srgb, {getStatusColor(c.status)} 20%, transparent); color: {getStatusColor(c.status)}; border: 1px solid {getStatusColor(c.status)}"
								>
									{c.status}
								</span>
							</td>
							<td>
								{#if c.group}
									<span
										class="inline-block rounded px-2 py-1 text-xs"
										style="background: color-mix(in srgb, {c.group.color ?? '#6b7280'} 20%, transparent); color: {c.group.color ?? '#6b7280'}; border: 1px solid {c.group.color ?? '#6b7280'}"
									>
										{c.group.name}
									</span>
								{:else}
									<span style="color: var(--color-tron-text-secondary, #9ca3af)">—</span>
								{/if}
							</td>
							<td>
								{#if c.firmwareStatus}
									<span
										class="inline-block rounded px-2 py-1 text-xs font-semibold"
										style="background: rgba(0, 255, 255, 0.12); color: var(--color-tron-cyan, #00ffff); border: 1px solid var(--color-tron-cyan, #00ffff)"
									>
										{c.firmwareStatus}
									</span>
									{#if c.firmwareAssayId}
										<span class="ml-1 font-mono text-xs" style="color: var(--color-tron-text-secondary, #9ca3af)">
											{c.firmwareAssayId}
										</span>
									{/if}
								{:else}
									<span style="color: var(--color-tron-text-secondary, #9ca3af)">—</span>
								{/if}
							</td>
							<td>
								{#if c.expirationDate}
									{new Date(c.expirationDate).toLocaleDateString()}
								{:else}
									—
								{/if}
							</td>
							<td>
								{c.usesRemaining ?? '—'}{c.totalUses ? `/${c.totalUses}` : ''}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}

	<!-- Navigation Links -->
	<div class="flex gap-4">
		<a href="/spu/cartridges/groups" class="tron-button" style="min-height: 44px">
			Manage Groups
		</a>
		<a href="/spu/cartridges/analysis" class="tron-button" style="min-height: 44px">
			Analysis Dashboard
		</a>
	</div>
</div>

<!-- Scan Modal -->
{#if showScanModal}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
		role="dialog"
		onclick={() => (showScanModal = false)}
		onkeydown={(e) => e.key === 'Escape' && (showScanModal = false)}
	>
		<div class="tron-card w-full max-w-md p-6" onclick={(e) => e.stopPropagation()} role="document">
			<h2 class="mb-4 text-lg font-bold" style="color: var(--color-tron-cyan, #00ffff)">
				Scan Barcode
			</h2>
			<input
				type="text"
				class="tron-input mb-4 w-full"
				style="min-height: 44px"
				placeholder="Scan or enter barcode..."
				bind:value={scanBarcode}
				onkeydown={(e) => e.key === 'Enter' && handleScan()}
			/>
			{#if scanError}
				<p class="mb-4 text-sm" style="color: #ef4444">{scanError}</p>
			{/if}
			<div class="flex justify-end gap-2">
				<button class="tron-button" style="min-height: 44px" onclick={() => (showScanModal = false)}>
					Cancel
				</button>
				<button
					class="tron-button"
					style="min-height: 44px; background: var(--color-tron-cyan, #00ffff); color: #000"
					onclick={handleScan}
					disabled={scanLoading}
				>
					{scanLoading ? 'Looking up...' : 'Lookup'}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Register Modal -->
{#if showRegisterModal}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
		role="dialog"
		onclick={() => (showRegisterModal = false)}
		onkeydown={(e) => e.key === 'Escape' && (showRegisterModal = false)}
	>
		<div
			class="tron-card max-h-[90vh] w-full max-w-lg overflow-y-auto p-6"
			onclick={(e) => e.stopPropagation()}
			role="document"
		>
			<h2 class="mb-4 text-lg font-bold" style="color: var(--color-tron-cyan, #00ffff)">
				Register Cartridge
			</h2>
			<form
				method="POST"
				action="?/register"
				use:enhance={() => {
					return async ({ result, update }) => {
						if (result.type === 'success') {
							showRegisterModal = false;
						}
						await update();
					};
				}}
				class="space-y-3"
			>
				<input
					name="barcode"
					type="text"
					class="tron-input w-full"
					style="min-height: 44px"
					placeholder="Barcode (auto-generated if empty)"
					bind:value={regBarcode}
				/>
				<input
					name="lotNumber"
					type="text"
					class="tron-input w-full"
					style="min-height: 44px"
					placeholder="Lot Number *"
					required
					bind:value={regLotNumber}
				/>
				<select name="cartridgeType" class="tron-input w-full" style="min-height: 44px" required bind:value={regCartridgeType}>
					<option value="">Select Type *</option>
					<option value="measurement">Measurement</option>
					<option value="calibration">Calibration</option>
					<option value="reference">Reference</option>
					<option value="test">Test</option>
				</select>
				<input
					name="serialNumber"
					type="text"
					class="tron-input w-full"
					style="min-height: 44px"
					placeholder="Serial Number"
					bind:value={regSerialNumber}
				/>
				<select name="groupId" class="tron-input w-full" style="min-height: 44px" bind:value={regGroupId}>
					<option value="">No Group</option>
					{#each data.groups as g (g.id)}
						<option value={g.id}>{g.name}</option>
					{/each}
				</select>
				<input
					name="manufacturer"
					type="text"
					class="tron-input w-full"
					style="min-height: 44px"
					placeholder="Manufacturer"
					bind:value={regManufacturer}
				/>
				<input
					name="expirationDate"
					type="date"
					class="tron-input w-full"
					style="min-height: 44px"
					bind:value={regExpirationDate}
				/>
				<input
					name="totalUses"
					type="number"
					class="tron-input w-full"
					style="min-height: 44px"
					placeholder="Total Uses"
					bind:value={regTotalUses}
				/>
				<input
					name="storageLocation"
					type="text"
					class="tron-input w-full"
					style="min-height: 44px"
					placeholder="Storage Location"
					bind:value={regStorageLocation}
				/>
				<input
					name="storageConditions"
					type="text"
					class="tron-input w-full"
					style="min-height: 44px"
					placeholder="Storage Conditions (e.g., 2-8°C)"
					bind:value={regStorageConditions}
				/>
				<textarea
					name="notes"
					class="tron-input w-full"
					style="min-height: 66px"
					placeholder="Notes"
					bind:value={regNotes}
				></textarea>
				<div class="flex justify-end">
					<button
						type="button"
						class="tron-button text-sm"
						style="min-height: 44px; border-color: #f97316; color: #f97316"
						onclick={fillRegisterTestData}
					>
						&#9881; Fill Test Data
					</button>
				</div>
				<div class="flex justify-end gap-2">
					<button
						type="button"
						class="tron-button"
						style="min-height: 44px"
						onclick={() => (showRegisterModal = false)}
					>
						Cancel
					</button>
					<button
						type="submit"
						class="tron-button"
						style="min-height: 44px; background: var(--color-tron-cyan, #00ffff); color: #000"
					>
						Register
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}
