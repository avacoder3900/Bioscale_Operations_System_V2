<script lang="ts">
	interface Sensor {
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
		notes: string | null;
	}

	interface Reading {
		id: string;
		equipmentId: string;
		temperatureC: number | null;
		description: string | null;
		createdAt: string;
	}

	interface Props {
		data: { sensors: Sensor[]; recentReadings: Reading[]; isAdmin: boolean };
	}

	let { data }: Props = $props();

	let fridgeSensors = $derived(data.sensors.filter((s) => s.equipmentType === 'fridge'));
	let ovenSensors = $derived(data.sensors.filter((s) => s.equipmentType === 'oven'));
	let linkedCount = $derived(data.sensors.filter((s) => s.mocreoDeviceId).length);

	function getTempStatus(sensor: Sensor): 'normal' | 'low' | 'high' | 'unknown' {
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

	function tempStatusLabel(status: 'normal' | 'low' | 'high' | 'unknown'): string {
		switch (status) {
			case 'normal': return 'Normal';
			case 'low': return 'Below Range';
			case 'high': return 'Above Range';
			case 'unknown': return 'No Data';
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
</script>

<div class="space-y-8">
	<!-- Header -->
	<div>
		<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">Temperature Probes</h1>
		<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
			MOCREO Smart System temperature sensors linked to fridges and ovens.
			<span class="ml-2 font-mono text-[var(--color-tron-cyan)]">{data.sensors.length} probe{data.sensors.length !== 1 ? 's' : ''}</span>
			<span class="mx-1 text-[var(--color-tron-text-secondary)]">/</span>
			<span class="font-mono {linkedCount > 0 ? 'text-green-300' : 'text-[var(--color-tron-text-secondary)]'}">{linkedCount} linked</span>
		</p>
	</div>

	<!-- Status Summary Cards -->
	<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 text-center">
			<p class="text-2xl font-bold text-[var(--color-tron-text)]">{data.sensors.length}</p>
			<p class="text-xs text-[var(--color-tron-text-secondary)]">Total Probes</p>
		</div>
		<div class="rounded-lg border border-green-500/30 bg-green-900/10 p-4 text-center">
			<p class="text-2xl font-bold text-green-300">{linkedCount}</p>
			<p class="text-xs text-green-300/70">MOCREO Linked</p>
		</div>
		<div class="rounded-lg border border-blue-500/30 bg-blue-900/10 p-4 text-center">
			<p class="text-2xl font-bold text-blue-300">{fridgeSensors.length}</p>
			<p class="text-xs text-blue-300/70">Fridge Probes</p>
		</div>
		<div class="rounded-lg border border-orange-500/30 bg-orange-900/10 p-4 text-center">
			<p class="text-2xl font-bold text-orange-300">{ovenSensors.length}</p>
			<p class="text-xs text-orange-300/70">Oven Probes</p>
		</div>
	</div>

	<!-- Probe Cards -->
	{#if data.sensors.length === 0}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-12 text-center">
			<svg class="mx-auto mb-4 h-12 w-12 text-[var(--color-tron-text-secondary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
			</svg>
			<p class="text-sm text-[var(--color-tron-text-secondary)]">
				No temperature probes configured yet. Register equipment in the Fridges & Ovens tab to create probe entries.
			</p>
		</div>
	{:else}
		<div class="space-y-3">
			{#each data.sensors as sensor (sensor.equipmentId)}
				{@const status = getTempStatus(sensor)}
				<div class="rounded-lg border border-l-4 border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] {sensor.equipmentType === 'fridge' ? 'border-l-blue-500' : 'border-l-orange-500'}">
					<div class="p-4">
						<div class="flex items-center justify-between">
							<div class="flex-1">
								<div class="flex items-center gap-3">
									<!-- Icon -->
									<div class="flex h-10 w-10 items-center justify-center rounded-lg {sensor.equipmentType === 'fridge' ? 'bg-blue-500/20' : 'bg-orange-500/20'}">
										{#if sensor.equipmentType === 'fridge'}
											<svg class="h-5 w-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
												<path stroke-linecap="round" stroke-linejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
											</svg>
										{:else}
											<svg class="h-5 w-5 text-orange-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
												<path stroke-linecap="round" stroke-linejoin="round" d="M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z" />
											</svg>
										{/if}
									</div>

									<!-- Name & badges -->
									<div>
										<div class="flex items-center gap-2">
											<span class="text-sm font-semibold text-[var(--color-tron-text)]">{sensor.name}</span>
											<span class="rounded border px-2 py-0.5 text-[10px] font-bold uppercase {sensor.equipmentType === 'fridge'
												? 'border-blue-500/40 bg-blue-900/30 text-blue-300'
												: 'border-orange-500/40 bg-orange-900/30 text-orange-300'}">
												{sensor.equipmentType}
											</span>
											<span class="rounded border px-2 py-0.5 text-[10px] font-medium {tempStatusClass(status)}">
												{tempStatusLabel(status)}
											</span>
										</div>
										<div class="mt-1 flex items-center gap-4 text-xs text-[var(--color-tron-text-secondary)]">
											<span class="font-mono">{sensor.equipmentId}</span>
											{#if sensor.temperatureMinC != null && sensor.temperatureMaxC != null}
												<span>
													Range: <span class="font-mono text-[var(--color-tron-text)]">{sensor.temperatureMinC}°C — {sensor.temperatureMaxC}°C</span>
												</span>
											{/if}
											<span>Last read: {formatTempTime(sensor.lastTemperatureReadAt)}</span>
											{#if sensor.batteryLevel != null}
												<span class="flex items-center gap-1">
													<span class="inline-block w-5 h-2.5 rounded-sm border border-current relative overflow-hidden">
														<span class="absolute inset-0.5 rounded-sm {sensor.batteryLevel > 50 ? 'bg-emerald-500' : sensor.batteryLevel > 20 ? 'bg-amber-500' : 'bg-red-500'}" style="width: {sensor.batteryLevel}%"></span>
													</span>
													{sensor.batteryLevel}%
												</span>
											{/if}
											{#if sensor.signalLevel != null}
												<span>📶 {sensor.signalLevel}%</span>
											{/if}
										</div>
									</div>
								</div>
							</div>

							<!-- Temperature display -->
							<div class="flex items-center gap-4">
								{#if sensor.currentTemperatureC != null}
									<div class="flex flex-col items-end">
										<span class="inline-flex items-center gap-1.5 rounded-full border px-4 py-1.5 font-mono text-lg font-bold {tempStatusClass(status)}">
											{#if status === 'high'}
												<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
													<path stroke-linecap="round" stroke-linejoin="round" d="M5 15l7-7 7 7" />
												</svg>
											{:else if status === 'low'}
												<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
													<path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
												</svg>
											{/if}
											{sensor.currentTemperatureC.toFixed(1)}°C
										</span>
									</div>
								{:else}
									<span class="rounded-full border border-[var(--color-tron-border)] px-4 py-1.5 text-sm text-[var(--color-tron-text-secondary)]">
										— °C
									</span>
								{/if}
							</div>
						</div>

						<!-- MOCREO Connection Info -->
						<div class="mt-3 flex flex-wrap items-center gap-3 border-t border-[var(--color-tron-border)]/30 pt-3">
							<div class="flex items-center gap-1.5 text-xs">
								{#if sensor.mocreoDeviceId}
									<span class="inline-flex items-center gap-1.5 rounded-full border border-green-500/30 bg-green-900/20 px-2.5 py-0.5 text-[10px] font-medium text-green-300">
										<span class="h-1.5 w-1.5 rounded-full bg-green-400"></span>
										MOCREO Connected
									</span>
									<span class="font-mono text-[10px] text-[var(--color-tron-text-secondary)]">
										Device: {sensor.mocreoDeviceId}
									</span>
									{#if sensor.mocreoAssetId}
										<span class="font-mono text-[10px] text-[var(--color-tron-text-secondary)]">
											/ Asset: {sensor.mocreoAssetId}
										</span>
									{/if}
								{:else}
									<span class="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-900/15 px-2.5 py-0.5 text-[10px] font-medium text-amber-300">
										<span class="h-1.5 w-1.5 rounded-full bg-amber-400"></span>
										Not Linked
									</span>
									<span class="text-[10px] text-[var(--color-tron-text-secondary)]">
										Configure MOCREO device ID to enable automatic temperature polling
									</span>
								{/if}
							</div>
							{#if sensor.notes}
								<span class="text-xs italic text-[var(--color-tron-text-secondary)]">{sensor.notes}</span>
							{/if}
						</div>
					</div>
				</div>
			{/each}
		</div>
	{/if}

	<!-- Recent Temperature Readings -->
	<section>
		<h2 class="mb-4 text-lg font-semibold text-[var(--color-tron-text)]">Recent Readings</h2>
		{#if data.recentReadings.length === 0}
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-8 text-center">
				<p class="text-sm text-[var(--color-tron-text-secondary)]">
					No temperature readings recorded yet. Readings will appear here once MOCREO sensors are linked and polling is active.
				</p>
			</div>
		{:else}
			<div class="overflow-hidden rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
				<div class="overflow-x-auto">
					<table class="w-full text-xs">
						<thead>
							<tr class="border-b border-[var(--color-tron-border)] text-left text-[var(--color-tron-text-secondary)]">
								<th class="px-4 py-2.5 font-medium">Equipment</th>
								<th class="px-3 py-2.5 font-medium">Temperature</th>
								<th class="px-3 py-2.5 font-medium">Description</th>
								<th class="px-3 py-2.5 font-medium">Time</th>
							</tr>
						</thead>
						<tbody>
							{#each data.recentReadings as reading (reading.id)}
								{@const sensor = data.sensors.find((s) => s.equipmentId === reading.equipmentId)}
								<tr class="border-b border-[var(--color-tron-border)]/30 transition-colors hover:bg-[var(--color-tron-bg)]">
									<td class="px-4 py-2 text-[var(--color-tron-text)]">{sensor?.name ?? reading.equipmentId}</td>
									<td class="px-3 py-2">
										{#if reading.temperatureC != null}
											<span class="font-mono font-bold text-[var(--color-tron-text)]">{reading.temperatureC.toFixed(1)}°C</span>
										{:else}
											<span class="text-[var(--color-tron-text-secondary)]">—</span>
										{/if}
									</td>
									<td class="px-3 py-2 text-[var(--color-tron-text-secondary)]">{reading.description ?? '—'}</td>
									<td class="px-3 py-2 text-[var(--color-tron-text-secondary)]">{new Date(reading.createdAt).toLocaleString()}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</div>
		{/if}
	</section>

	<!-- MOCREO Configuration Info -->
	<section class="rounded-lg border border-[var(--color-tron-border)]/50 bg-[var(--color-tron-bg)] p-5">
		<h3 class="mb-2 text-sm font-semibold text-[var(--color-tron-text)]">MOCREO Integration</h3>
		<p class="text-xs leading-relaxed text-[var(--color-tron-text-secondary)]">
			Temperature probes are polled via the MOCREO Smart System API. To enable automatic readings, set the
			<code class="rounded bg-[var(--color-tron-surface)] px-1.5 py-0.5 font-mono text-[var(--color-tron-cyan)]">MOCREO_API_KEY</code>
			environment variable and link each equipment record to a MOCREO device ID and asset ID.
			The system will poll sensors periodically and log out-of-range warnings.
		</p>
	</section>
</div>
