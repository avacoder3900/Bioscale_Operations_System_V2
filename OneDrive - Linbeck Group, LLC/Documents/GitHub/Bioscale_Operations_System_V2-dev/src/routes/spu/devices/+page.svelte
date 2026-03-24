<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { TronCard, TronButton, TronBadge } from '$lib/components/ui';

	let { data, form } = $props();

	// Tab state
	let activeTab = $state<'devices' | 'fwcartridges' | 'events'>(
		(page.url.searchParams.get('tab') as 'devices' | 'fwcartridges' | 'events') || 'devices'
	);

	// Form visibility
	let showAddDevice = $state(false);
	let editingDeviceId = $state<string | null>(null);
	let submitting = $state(false);

	function switchTab(tab: 'devices' | 'fwcartridges' | 'events') {
		activeTab = tab;
		const url = new URL(page.url);
		url.searchParams.set('tab', tab);
		url.searchParams.delete('page');
		history.replaceState(history.state, '', url.toString());
	}

	function goToPage(p: number) {
		const params = new URLSearchParams(page.url.searchParams);
		params.set('page', String(p));
		goto(`/spu/devices?${params.toString()}`);
	}

	function formatDate(date: string | Date | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleString();
	}

	function formatRelativeTime(date: string | Date | null): string {
		if (!date) return 'Never';
		const d = new Date(date);
		const diff = Date.now() - d.getTime();
		const hours = Math.floor(diff / 3600000);
		if (hours < 1) return 'Just now';
		if (hours < 24) return `${hours}h ago`;
		const days = Math.floor(hours / 24);
		if (days === 1) return 'Yesterday';
		return `${days}d ago`;
	}

	function getEventBadgeVariant(eventType: string): 'success' | 'info' | 'warning' | 'error' | 'neutral' {
		switch (eventType) {
			case 'validate': return 'info';
			case 'load_assay': return 'success';
			case 'upload': return 'success';
			case 'reset': return 'warning';
			case 'error': return 'error';
			default: return 'neutral';
		}
	}

	function getCartridgeStatusVariant(status: string): 'success' | 'info' | 'warning' | 'error' | 'neutral' {
		switch (status) {
			case 'active': return 'success';
			case 'pending': return 'info';
			case 'used': return 'warning';
			case 'expired': return 'error';
			default: return 'neutral';
		}
	}

	// Active tab total for pagination
	let activeTabTotal = $derived(
		activeTab === 'devices' ? (data.pagination?.devicesTotal ?? 0) :
		activeTab === 'fwcartridges' ? (data.pagination?.fwCartridgesTotal ?? 0) :
		(data.events?.length ?? 0)
	);
</script>

<div class="space-y-6">
	<!-- Header -->
	<div>
		<h2 class="tron-text-primary font-mono text-2xl font-bold">Devices & Firmware</h2>
		<p class="tron-text-muted text-sm">Manage firmware devices, cartridges, and events</p>
	</div>

	{#if form?.error}
		<div class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-3">
			<p class="text-sm text-[var(--color-tron-red)]">{form.error}</p>
		</div>
	{/if}

	<!-- Stats Cards -->
	<div class="grid gap-4 sm:grid-cols-3">
		<TronCard>
			<div class="text-center">
				<div class="font-mono text-3xl font-bold text-[var(--color-tron-cyan)]">
					{data.pagination?.devicesTotal ?? 0}
				</div>
				<div class="tron-text-muted text-sm">Total Devices</div>
			</div>
		</TronCard>
		<TronCard>
			<div class="text-center">
				<div class="font-mono text-3xl font-bold text-[var(--color-tron-green)]">
					{data.pagination?.fwCartridgesTotal ?? 0}
				</div>
				<div class="tron-text-muted text-sm">FW Cartridges</div>
			</div>
		</TronCard>
		<TronCard>
			<div class="text-center">
				<div class="font-mono text-3xl font-bold text-[var(--color-tron-orange)]">
					{data.events?.length ?? 0}
				</div>
				<div class="tron-text-muted text-sm">Recent Events</div>
			</div>
		</TronCard>
	</div>

	<!-- Tab Bar -->
	<div class="flex items-center gap-1 border-b border-[var(--color-tron-border)]">
		<button
			class="px-4 py-2 text-sm font-medium transition-colors {activeTab === 'devices'
				? 'border-b-2 border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
				: 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}"
			onclick={() => switchTab('devices')}
		>
			Devices
		</button>
		<button
			class="px-4 py-2 text-sm font-medium transition-colors {activeTab === 'fwcartridges'
				? 'border-b-2 border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
				: 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}"
			onclick={() => switchTab('fwcartridges')}
		>
			FW Cartridges
		</button>
		<button
			class="px-4 py-2 text-sm font-medium transition-colors {activeTab === 'events'
				? 'border-b-2 border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
				: 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}"
			onclick={() => switchTab('events')}
		>
			Events
		</button>
	</div>

	<!-- Devices Tab -->
	{#if activeTab === 'devices'}
		<div class="flex items-center justify-between">
			<span class="tron-text-muted text-sm">{data.devices?.length ?? 0} devices on this page</span>
			<TronButton variant="primary" onclick={() => (showAddDevice = !showAddDevice)}>
				{showAddDevice ? 'Cancel' : 'Register Device'}
			</TronButton>
		</div>

		<!-- Add Device Form -->
		{#if showAddDevice}
			<TronCard>
				<h3 class="tron-text-primary mb-3 font-mono text-sm font-semibold">Register New Device</h3>
				<form
					method="POST"
					action="?/createDevice"
					use:enhance={() => {
						submitting = true;
						return async ({ update }) => {
							submitting = false;
							showAddDevice = false;
							await update();
						};
					}}
				>
					<div class="grid gap-3 sm:grid-cols-2">
						<div>
							<label class="tron-text-muted mb-1 block text-xs">Device ID *</label>
							<input type="text" name="deviceId" class="tron-input w-full" required />
						</div>
						<div>
							<label class="tron-text-muted mb-1 block text-xs">API Key</label>
							<input type="text" name="apiKey" class="tron-input w-full" />
						</div>
						<div>
							<label class="tron-text-muted mb-1 block text-xs">Firmware Version</label>
							<input type="text" name="firmwareVersion" class="tron-input w-full" placeholder="e.g. 2.1.0" />
						</div>
						<div>
							<label class="tron-text-muted mb-1 block text-xs">Data Format Version</label>
							<input type="text" name="dataFormatVersion" class="tron-input w-full" placeholder="e.g. 3.0" />
						</div>
					</div>
					<div class="mt-3 flex justify-end">
						<TronButton type="submit" variant="primary" disabled={submitting}>
							{submitting ? 'Registering...' : 'Register'}
						</TronButton>
					</div>
				</form>
			</TronCard>
		{/if}

		<!-- Devices Table -->
		<TronCard>
			<div class="overflow-x-auto">
				<table class="tron-table">
					<thead>
						<tr>
							<th>Device ID</th>
							<th>API Key</th>
							<th>FW Version</th>
							<th>Data Format</th>
							<th>Last Seen</th>
							<th>Created</th>
							<th>Actions</th>
						</tr>
					</thead>
					<tbody>
						{#each data.devices ?? [] as device (device.id)}
							<tr>
								<td class="font-mono text-[var(--color-tron-cyan)]">{device.deviceId}</td>
								<td class="font-mono text-xs">{device.apiKey === '***' ? '***' : (device.apiKey ?? '—')}</td>
								<td>{device.firmwareVersion ?? '—'}</td>
								<td>{device.dataFormatVersion ?? '—'}</td>
								<td class="tron-text-muted">{formatRelativeTime(device.lastSeen)}</td>
								<td class="tron-text-muted text-xs">{formatDate(device.createdAt)}</td>
								<td>
									{#if editingDeviceId === device.id}
										<form
											method="POST"
											action="?/updateDevice"
											class="flex items-center gap-2"
											use:enhance={() => {
												submitting = true;
												return async ({ update }) => {
													submitting = false;
													editingDeviceId = null;
													await update();
												};
											}}
										>
											<input type="hidden" name="id" value={device.id} />
											<input type="text" name="firmwareVersion" class="tron-input w-20" value={device.firmwareVersion ?? ''} placeholder="FW" />
											<input type="text" name="dataFormatVersion" class="tron-input w-20" value={device.dataFormatVersion ?? ''} placeholder="DF" />
											<TronButton type="submit" variant="primary" disabled={submitting}>Save</TronButton>
											<button class="tron-button" type="button" onclick={() => (editingDeviceId = null)}>Cancel</button>
										</form>
									{:else}
										<button class="tron-button text-xs" onclick={() => (editingDeviceId = device.id)}>Edit</button>
									{/if}
								</td>
							</tr>
						{:else}
							<tr>
								<td colspan="7" class="tron-text-muted text-center">No devices registered yet.</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</TronCard>
	{/if}

	<!-- FW Cartridges Tab -->
	{#if activeTab === 'fwcartridges'}
		<TronCard>
			<div class="overflow-x-auto">
				<table class="tron-table">
					<thead>
						<tr>
							<th>UUID</th>
							<th>Assay ID</th>
							<th>Status</th>
							<th>Lot #</th>
							<th>Serial #</th>
							<th>Site</th>
							<th>Program</th>
							<th>Experiment</th>
							<th>Qty</th>
							<th>Created</th>
						</tr>
					</thead>
					<tbody>
						{#each data.firmwareCartridges ?? [] as cart (cart.id)}
							<tr>
								<td class="font-mono text-xs text-[var(--color-tron-cyan)]">{cart.cartridgeUuid}</td>
								<td>{cart.assayId ?? '—'}</td>
								<td><TronBadge variant={getCartridgeStatusVariant(cart.status)}>{cart.status}</TronBadge></td>
								<td class="font-mono text-xs">{cart.lotNumber ?? '—'}</td>
								<td class="font-mono text-xs">{cart.serialNumber ?? '—'}</td>
								<td>{cart.siteId ?? '—'}</td>
								<td>{cart.program ?? '—'}</td>
								<td>{cart.experiment ?? '—'}</td>
								<td class="text-center">{cart.quantity ?? '—'}</td>
								<td class="tron-text-muted text-xs">{formatDate(cart.createdAt)}</td>
							</tr>
						{:else}
							<tr>
								<td colspan="10" class="tron-text-muted text-center">No firmware cartridges found.</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</TronCard>
	{/if}

	<!-- Events Tab -->
	{#if activeTab === 'events'}
		<TronCard>
			<div class="overflow-x-auto">
				<table class="tron-table">
					<thead>
						<tr>
							<th>Device ID</th>
							<th>Event Type</th>
							<th>Cartridge UUID</th>
							<th>Success</th>
							<th>Error</th>
							<th>Timestamp</th>
						</tr>
					</thead>
					<tbody>
						{#each data.events ?? [] as event (event.id)}
							<tr>
								<td class="font-mono text-[var(--color-tron-cyan)]">{event.deviceId}</td>
								<td><TronBadge variant={getEventBadgeVariant(event.eventType)}>{event.eventType}</TronBadge></td>
								<td class="font-mono text-xs">{event.cartridgeUuid ?? '—'}</td>
								<td class="text-center">
									{#if event.success}
										<span class="text-[var(--color-tron-green)]">&#10003;</span>
									{:else}
										<span class="text-[var(--color-tron-red)]">&#10007;</span>
									{/if}
								</td>
								<td class="text-xs text-[var(--color-tron-red)]">{event.errorMessage ?? ''}</td>
								<td class="tron-text-muted text-xs">{formatDate(event.createdAt)}</td>
							</tr>
						{:else}
							<tr>
								<td colspan="6" class="tron-text-muted text-center">No device events recorded.</td>
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
