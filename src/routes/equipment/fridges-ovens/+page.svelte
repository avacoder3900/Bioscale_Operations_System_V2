<script lang="ts">
	import { enhance } from '$app/forms';
	import { SvelteMap } from 'svelte/reactivity';

	interface Location {
		id: string;
		barcode: string;
		locationType: string;
		displayName: string;
		isActive: boolean;
		capacity: number | null;
		notes: string | null;
		createdAt: string;
		occupantCount: number;
	}

	interface EquipmentSensor {
		equipmentId: string;
		name: string;
		equipmentType: string;
		status: string;
		currentTemperatureC: number | null;
		temperatureMinC: number | null;
		temperatureMaxC: number | null;
		lastTemperatureReadAt: string | null;
		mocreoDeviceId: string | null;
		mocreoAssetId: string | null;
	}

	interface Props {
		data: { locations: Location[]; equipmentSensors: EquipmentSensor[]; isAdmin: boolean };
		form: { success?: boolean; error?: string; message?: string } | null;
	}

	let { data, form }: Props = $props();

	let showCreateForm = $state(false);
	let editingId = $state<string | null>(null);
	let filter = $state<'all' | 'fridge' | 'oven'>('all');
	let showInactive = $state(false);

	let filteredLocations = $derived(
		data.locations.filter((loc) => {
			if (filter !== 'all' && loc.locationType !== filter) return false;
			if (!showInactive && !loc.isActive) return false;
			return true;
		})
	);

	let fridgeCount = $derived(data.locations.filter((l) => l.locationType === 'fridge' && l.isActive).length);
	let ovenCount = $derived(data.locations.filter((l) => l.locationType === 'oven' && l.isActive).length);

	// Build a lookup: location displayName -> equipment sensor data
	let sensorByName = $derived.by(() => {
		const map = new SvelteMap<string, EquipmentSensor>();
		for (const s of data.equipmentSensors) {
			map.set(s.name, s);
		}
		return map;
	});

	function getTempStatus(sensor: EquipmentSensor): 'normal' | 'low' | 'high' | 'unknown' {
		if (sensor.currentTemperatureC == null) return 'unknown';
		if (sensor.temperatureMinC != null && sensor.currentTemperatureC < sensor.temperatureMinC) return 'low';
		if (sensor.temperatureMaxC != null && sensor.currentTemperatureC > sensor.temperatureMaxC) return 'high';
		return 'normal';
	}

	function tempStatusClass(status: 'normal' | 'low' | 'high' | 'unknown'): string {
		switch (status) {
			case 'normal': return 'text-green-300 bg-green-900/30 border-green-500/30';
			case 'low': return 'text-blue-300 bg-blue-900/30 border-blue-500/30';
			case 'high': return 'text-red-300 bg-red-900/30 border-red-500/30';
			case 'unknown': return 'text-[var(--color-tron-text-secondary)] bg-[var(--color-tron-surface)] border-[var(--color-tron-border)]';
		}
	}

	function formatTempTime(iso: string | null): string {
		if (!iso) return 'Never';
		const d = new Date(iso);
		const now = Date.now();
		const diffMs = now - d.getTime();
		if (diffMs < 60000) return 'Just now';
		if (diffMs < 3600000) return `${Math.floor(diffMs / 60000)}m ago`;
		if (diffMs < 86400000) return `${Math.floor(diffMs / 3600000)}h ago`;
		return d.toLocaleDateString();
	}

	function typeBadgeClass(type: string): string {
		return type === 'fridge'
			? 'border-blue-500/40 bg-blue-900/30 text-blue-300'
			: 'border-orange-500/40 bg-orange-900/30 text-orange-300';
	}

	function typeIcon(type: string): string {
		return type === 'fridge' ? 'snowflake' : 'flame';
	}

	function startEdit(loc: Location) {
		editingId = loc.id;
	}

	function cancelEdit() {
		editingId = null;
	}
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">Fridges & Ovens</h1>
			<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
				Manage storage locations for decks and trays.
				<span class="ml-2 font-mono text-blue-300">{fridgeCount} fridge{fridgeCount !== 1 ? 's' : ''}</span>
				<span class="mx-1 text-[var(--color-tron-text-secondary)]">/</span>
				<span class="font-mono text-orange-300">{ovenCount} oven{ovenCount !== 1 ? 's' : ''}</span>
			</p>
		</div>
		{#if data.isAdmin}
			<button
				type="button"
				onclick={() => { showCreateForm = !showCreateForm; }}
				class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 px-4 py-2 text-sm text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10"
			>
				{showCreateForm ? 'Cancel' : '+ Register Location'}
			</button>
		{/if}
	</div>

	<!-- Flash messages -->
	{#if form?.success && form?.message}
		<div class="rounded border border-green-500/30 bg-green-900/20 px-4 py-3 text-sm text-green-300">
			{form.message}
		</div>
	{/if}
	{#if form?.error}
		<div class="rounded border border-red-500/30 bg-red-900/20 px-4 py-3 text-sm text-red-300">
			{form.error}
		</div>
	{/if}

	<!-- Create form -->
	{#if showCreateForm && data.isAdmin}
		<form
			method="POST"
			action="?/createLocation"
			use:enhance={() => {
				return async ({ update }) => {
					showCreateForm = false;
					await update();
				};
			}}
			class="rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-surface)] p-5"
		>
			<h3 class="mb-4 text-sm font-semibold text-[var(--color-tron-cyan)]">Register New Location</h3>
			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
				<div>
					<label for="create-type" class="mb-1 block text-xs font-medium text-[var(--color-tron-text-secondary)]">Type</label>
					<select id="create-type" name="locationType" required class="tron-input w-full">
						<option value="fridge">Fridge</option>
						<option value="oven">Oven</option>
					</select>
				</div>
				<div>
					<label for="create-name" class="mb-1 block text-xs font-medium text-[var(--color-tron-text-secondary)]">Display Name</label>
					<input id="create-name" type="text" name="displayName" required placeholder="e.g. Fridge A" class="tron-input w-full" />
				</div>
				<div>
					<label for="create-barcode" class="mb-1 block text-xs font-medium text-[var(--color-tron-text-secondary)]">Barcode</label>
					<input id="create-barcode" type="text" name="barcode" required placeholder="Scan or enter barcode" class="tron-input w-full" />
				</div>
				<div>
					<label for="create-capacity" class="mb-1 block text-xs font-medium text-[var(--color-tron-text-secondary)]">Capacity (optional)</label>
					<input id="create-capacity" type="number" name="capacity" min="1" placeholder="Max items" class="tron-input w-full" />
				</div>
			</div>
			<div class="mt-3">
				<label for="create-notes" class="mb-1 block text-xs font-medium text-[var(--color-tron-text-secondary)]">Notes (optional)</label>
				<input id="create-notes" type="text" name="notes" placeholder="Any additional notes..." class="tron-input w-full" />
			</div>
			<div class="mt-4 flex justify-end gap-2">
				<button type="button" onclick={() => { showCreateForm = false; }} class="rounded border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-surface-hover)]">
					Cancel
				</button>
				<button type="submit" class="tron-btn-primary">Register</button>
			</div>
		</form>
	{/if}

	<!-- Filter bar -->
	<div class="flex items-center gap-3">
		<div class="flex rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)]">
			<button
				type="button"
				onclick={() => { filter = 'all'; }}
				class="px-3 py-1.5 text-xs font-medium transition-colors {filter === 'all'
					? 'bg-[var(--color-tron-cyan)]/15 text-[var(--color-tron-cyan)]'
					: 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}"
			>
				All
			</button>
			<button
				type="button"
				onclick={() => { filter = 'fridge'; }}
				class="border-l border-[var(--color-tron-border)] px-3 py-1.5 text-xs font-medium transition-colors {filter === 'fridge'
					? 'bg-blue-500/15 text-blue-300'
					: 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}"
			>
				Fridges
			</button>
			<button
				type="button"
				onclick={() => { filter = 'oven'; }}
				class="border-l border-[var(--color-tron-border)] px-3 py-1.5 text-xs font-medium transition-colors {filter === 'oven'
					? 'bg-orange-500/15 text-orange-300'
					: 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}"
			>
				Ovens
			</button>
		</div>
		<label class="flex items-center gap-2 text-xs text-[var(--color-tron-text-secondary)]">
			<input type="checkbox" bind:checked={showInactive} class="accent-[var(--color-tron-cyan)]" />
			Show inactive
		</label>
	</div>

	<!-- Location cards -->
	<div class="space-y-3">
		{#each filteredLocations as loc (loc.id)}
			{@const sensor = sensorByName.get(loc.displayName) ?? null}
			{@const tempStatus = sensor ? getTempStatus(sensor) : 'unknown'}
			<div class="rounded-lg border border-l-4 border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] {loc.locationType === 'fridge' ? 'border-l-blue-500' : 'border-l-orange-500'} {!loc.isActive ? 'opacity-50' : ''}">
				{#if editingId === loc.id && data.isAdmin}
					<!-- Edit mode -->
					<form
						method="POST"
						action="?/updateLocation"
						use:enhance={() => {
							return async ({ update }) => {
								editingId = null;
								await update();
							};
						}}
						class="p-4"
					>
						<input type="hidden" name="id" value={loc.id} />
						<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
							<div>
								<label for="edit-name-{loc.id}" class="mb-1 block text-xs font-medium text-[var(--color-tron-text-secondary)]">Display Name</label>
								<input id="edit-name-{loc.id}" type="text" name="displayName" value={loc.displayName} required class="tron-input w-full" />
							</div>
							<div>
								<label for="edit-capacity-{loc.id}" class="mb-1 block text-xs font-medium text-[var(--color-tron-text-secondary)]">Capacity</label>
								<input id="edit-capacity-{loc.id}" type="number" name="capacity" value={loc.capacity ?? ''} min="1" class="tron-input w-full" />
							</div>
							<div>
								<label for="edit-notes-{loc.id}" class="mb-1 block text-xs font-medium text-[var(--color-tron-text-secondary)]">Notes</label>
								<input id="edit-notes-{loc.id}" type="text" name="notes" value={loc.notes ?? ''} class="tron-input w-full" />
							</div>
							<div>
								<label for="edit-active-{loc.id}" class="mb-1 block text-xs font-medium text-[var(--color-tron-text-secondary)]">Status</label>
								<select id="edit-active-{loc.id}" name="isActive" class="tron-input w-full">
									<option value="true" selected={loc.isActive}>Active</option>
									<option value="false" selected={!loc.isActive}>Inactive</option>
								</select>
							</div>
						</div>
						<div class="mt-3 flex justify-end gap-2">
							<button type="button" onclick={() => cancelEdit()} class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-surface-hover)]">
								Cancel
							</button>
							<button type="submit" class="tron-btn-primary text-xs">Save Changes</button>
						</div>
					</form>
				{:else}
					<!-- Display mode -->
					<div class="p-4">
						<div class="flex items-center justify-between">
							<div class="flex-1">
								<div class="flex items-center gap-3">
									<div class="flex h-9 w-9 items-center justify-center rounded-lg {loc.locationType === 'fridge' ? 'bg-blue-500/20' : 'bg-orange-500/20'}">
										{#if typeIcon(loc.locationType) === 'snowflake'}
											<svg class="h-5 w-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
												<path stroke-linecap="round" stroke-linejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
											</svg>
										{:else}
											<svg class="h-5 w-5 text-orange-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
												<path stroke-linecap="round" stroke-linejoin="round" d="M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z" />
											</svg>
										{/if}
									</div>
									<div>
										<span class="text-sm font-semibold text-[var(--color-tron-text)]">{loc.displayName}</span>
										<span class="ml-2 inline-flex rounded border px-2 py-0.5 text-[10px] font-bold uppercase {typeBadgeClass(loc.locationType)}">
											{loc.locationType}
										</span>
										{#if !loc.isActive}
											<span class="ml-1 rounded border border-red-500/30 bg-red-900/20 px-2 py-0.5 text-[10px] font-bold text-red-400">
												INACTIVE
											</span>
										{/if}
									</div>
								</div>
								<div class="mt-2 flex flex-wrap items-center gap-4 text-xs text-[var(--color-tron-text-secondary)]">
									<span class="font-mono">Barcode: {loc.barcode}</span>
									<span>
										Occupants: <span class="font-semibold text-[var(--color-tron-text)]">{loc.occupantCount}</span>
										{#if loc.capacity != null}
											/ {loc.capacity}
										{/if}
									</span>
									{#if loc.capacity != null && loc.occupantCount >= loc.capacity}
										<span class="rounded bg-amber-900/30 px-1.5 py-0.5 text-[10px] font-bold text-amber-300">FULL</span>
									{/if}
									{#if loc.notes}
										<span class="italic">{loc.notes}</span>
									{/if}
									<span>Added: {new Date(loc.createdAt).toLocaleDateString()}</span>
								</div>
							</div>

							<!-- Temperature display -->
							<div class="flex items-center gap-3">
								{#if sensor?.currentTemperatureC != null}
									<div class="flex flex-col items-end gap-0.5">
										<span class="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 font-mono text-sm font-bold {tempStatusClass(tempStatus)}">
											{#if tempStatus === 'high'}
												<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
													<path stroke-linecap="round" stroke-linejoin="round" d="M5 15l7-7 7 7" />
												</svg>
											{:else if tempStatus === 'low'}
												<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
													<path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
												</svg>
											{/if}
											{sensor.currentTemperatureC.toFixed(1)}°C
										</span>
										<span class="text-[10px] text-[var(--color-tron-text-secondary)]">
											{formatTempTime(sensor.lastTemperatureReadAt)}
										</span>
									</div>
								{:else if sensor}
									<span class="rounded-full border border-[var(--color-tron-border)] px-2.5 py-1 text-xs text-[var(--color-tron-text-secondary)]">
										No reading
									</span>
								{/if}

								{#if data.isAdmin}
									<div class="flex items-center gap-2">
										<button
											type="button"
											onclick={() => startEdit(loc)}
											class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)]/50 hover:text-[var(--color-tron-cyan)]"
										>
											Edit
										</button>
										{#if loc.isActive}
											<form method="POST" action="?/deleteLocation" use:enhance>
												<input type="hidden" name="id" value={loc.id} />
												<button
													type="submit"
													class="rounded border border-red-500/30 px-3 py-1.5 text-xs text-red-400 hover:bg-red-900/20"
													onclick={(e) => { if (!confirm(`Deactivate "${loc.displayName}"?`)) e.preventDefault(); }}
												>
													Deactivate
												</button>
											</form>
										{/if}
									</div>
								{/if}
							</div>
						</div>

						<!-- Temperature range & MOCREO sensor info -->
						{#if sensor}
							<div class="mt-3 flex flex-wrap items-center gap-3 border-t border-[var(--color-tron-border)]/30 pt-3">
								{#if sensor.temperatureMinC != null || sensor.temperatureMaxC != null}
									<div class="flex items-center gap-1.5 text-xs text-[var(--color-tron-text-secondary)]">
										<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
											<path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
										</svg>
										<span>Range:</span>
										<span class="font-mono text-[var(--color-tron-text)]">
											{sensor.temperatureMinC != null ? `${sensor.temperatureMinC}°C` : '—'}
											to
											{sensor.temperatureMaxC != null ? `${sensor.temperatureMaxC}°C` : '—'}
										</span>
									</div>
								{/if}
								<div class="flex items-center gap-1.5 text-xs">
									{#if sensor.mocreoDeviceId}
										<span class="inline-flex items-center gap-1 rounded-full border border-green-500/30 bg-green-900/20 px-2 py-0.5 text-[10px] font-medium text-green-300">
											<span class="h-1.5 w-1.5 rounded-full bg-green-400"></span>
											MOCREO linked
										</span>
										<span class="font-mono text-[10px] text-[var(--color-tron-text-secondary)]">
											{sensor.mocreoDeviceId}
										</span>
									{:else}
										<span class="inline-flex items-center gap-1 rounded-full border border-[var(--color-tron-border)] px-2 py-0.5 text-[10px] text-[var(--color-tron-text-secondary)]">
											<span class="h-1.5 w-1.5 rounded-full bg-[var(--color-tron-text-secondary)]"></span>
											No sensor linked
										</span>
									{/if}
								</div>
							</div>
						{/if}
					</div>
				{/if}
			</div>
		{/each}

		{#if filteredLocations.length === 0}
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-8 text-center">
				<p class="text-sm text-[var(--color-tron-text-secondary)]">
					{#if data.locations.length === 0}
						No locations registered yet. Click "+ Register Location" to add a fridge or oven.
					{:else}
						No locations match the current filter.
					{/if}
				</p>
			</div>
		{/if}
	</div>

	<!-- MOCREO Sensor Summary -->
	{#if data.equipmentSensors.length > 0}
		<div class="mt-8 space-y-4">
			<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Temperature Sensors (MOCREO)</h2>
			<p class="text-sm text-[var(--color-tron-text-secondary)]">
				Equipment temperature sensors linked via the MOCREO Smart System API. Sensors are matched to locations by name.
			</p>
			<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
				{#each data.equipmentSensors as sensor (sensor.equipmentId)}
					{@const status = getTempStatus(sensor)}
					{@const matchedLoc = data.locations.find((l) => l.displayName === sensor.name)}
					<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
						<div class="mb-2 flex items-center justify-between">
							<span class="text-sm font-semibold text-[var(--color-tron-text)]">{sensor.name}</span>
							<span class="rounded border px-1.5 py-0.5 text-[10px] font-medium {sensor.equipmentType === 'fridge'
								? 'border-blue-500/40 bg-blue-900/30 text-blue-300'
								: 'border-orange-500/40 bg-orange-900/30 text-orange-300'}">
								{sensor.equipmentType}
							</span>
						</div>
						<div class="space-y-2">
							<div class="flex items-center justify-between">
								<span class="text-xs text-[var(--color-tron-text-secondary)]">Temperature</span>
								{#if sensor.currentTemperatureC != null}
									<span class="rounded border px-2 py-0.5 font-mono text-xs font-bold {tempStatusClass(status)}">
										{sensor.currentTemperatureC.toFixed(1)}°C
									</span>
								{:else}
									<span class="text-xs text-[var(--color-tron-text-secondary)]">—</span>
								{/if}
							</div>
							{#if sensor.temperatureMinC != null || sensor.temperatureMaxC != null}
								<div class="flex items-center justify-between">
									<span class="text-xs text-[var(--color-tron-text-secondary)]">Acceptable range</span>
									<span class="font-mono text-xs text-[var(--color-tron-text)]">
										{sensor.temperatureMinC ?? '—'} — {sensor.temperatureMaxC ?? '—'}°C
									</span>
								</div>
							{/if}
							<div class="flex items-center justify-between">
								<span class="text-xs text-[var(--color-tron-text-secondary)]">Last read</span>
								<span class="text-xs text-[var(--color-tron-text)]">{formatTempTime(sensor.lastTemperatureReadAt)}</span>
							</div>
							<div class="flex items-center justify-between">
								<span class="text-xs text-[var(--color-tron-text-secondary)]">MOCREO</span>
								{#if sensor.mocreoDeviceId}
									<span class="inline-flex items-center gap-1 text-xs text-green-300">
										<span class="h-1.5 w-1.5 rounded-full bg-green-400"></span>
										Connected
									</span>
								{:else}
									<span class="text-xs text-[var(--color-tron-text-secondary)]">Not linked</span>
								{/if}
							</div>
							<div class="flex items-center justify-between">
								<span class="text-xs text-[var(--color-tron-text-secondary)]">Location match</span>
								{#if matchedLoc}
									<span class="inline-flex items-center gap-1 text-xs text-green-300">
										<span class="h-1.5 w-1.5 rounded-full bg-green-400"></span>
										{matchedLoc.displayName}
									</span>
								{:else}
									<span class="text-xs text-amber-300">No matching location</span>
								{/if}
							</div>
						</div>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
