<script lang="ts">
	import { enhance } from '$app/forms';

	interface MocreoSensor {
		sensorId: string;
		sensorName: string;
		model: string;
		temperature: number | null;
		humidity: number | null;
		lastReadingAt: string | null;
		readingCount: number;
		mappedEquipmentId: string | null;
		mappedEquipmentName: string | null;
		mappedEquipmentType: string | null;
	}

	interface EquipmentItem {
		id: string;
		name: string;
		equipmentType: string;
		mocreoDeviceId: string | null;
		currentTemperatureC: number | null;
		lastTemperatureReadAt: string | null;
		temperatureMinC: number | null;
		temperatureMaxC: number | null;
	}

	interface Props {
		data: {
			mocreoSensors: MocreoSensor[];
			equipment: EquipmentItem[];
			totalReadings: number;
			isAdmin: boolean;
		};
		form: { success?: boolean; error?: string } | null;
	}

	let { data, form }: Props = $props();
	let mappingFor = $state<string | null>(null);
	let selectedEquipmentId = $state('');

	function tempColor(temp: number | null, min?: number | null, max?: number | null): string {
		if (temp == null) return 'text-[var(--color-tron-text-secondary)]';
		if (min != null && temp < min) return 'text-blue-400';
		if (max != null && temp > max) return 'text-red-400';
		return 'text-green-400';
	}

	function formatTemp(temp: number | null): string {
		if (temp == null) return '—';
		return temp.toFixed(1) + '°C';
	}

	function timeAgo(dateStr: string | null): string {
		if (!dateStr) return 'Never';
		const diff = Date.now() - new Date(dateStr).getTime();
		const mins = Math.floor(diff / 60000);
		if (mins < 1) return 'Just now';
		if (mins < 60) return mins + 'm ago';
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return hrs + 'h ago';
		return Math.floor(hrs / 24) + 'd ago';
	}

	function typeIcon(type: string | null): string {
		switch (type) {
			case 'fridge': return '🧊';
			case 'oven': return '🔥';
			case 'robot': return '🤖';
			default: return '🌡️';
		}
	}

	const unmappedEquipment = $derived(
		data.equipment.filter(e => !e.mocreoDeviceId && ['fridge', 'oven'].includes(e.equipmentType))
	);
</script>

<div class="space-y-6">
	<!-- Header with back button -->
	<div class="flex items-center gap-4">
		<a href="/equipment/activity" class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)] transition-colors">
			← Equipment
		</a>
		<div>
			<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">Temperature Probes</h1>
			<p class="text-sm text-[var(--color-tron-text-secondary)]">
				{data.mocreoSensors.length} Mocreo sensors • {data.totalReadings} total readings stored
			</p>
		</div>
	</div>

	{#if form?.success}
		<div class="rounded border border-green-500/30 bg-green-900/20 px-4 py-3 text-sm text-green-300">✓ Sensor mapping updated.</div>
	{/if}
	{#if form?.error}
		<div class="rounded border border-red-500/30 bg-red-900/20 px-4 py-3 text-sm text-red-300">{form.error}</div>
	{/if}

	<!-- All Mocreo Sensors -->
	<section>
		<h2 class="mb-3 text-lg font-medium text-[var(--color-tron-cyan)]">Mocreo Sensors ({data.mocreoSensors.length})</h2>
		
		{#if data.mocreoSensors.length === 0}
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-6 text-center">
				<p class="text-sm text-[var(--color-tron-text-secondary)]">No Mocreo sensors found. Check API connection.</p>
			</div>
		{:else}
			<div class="space-y-3">
				{#each data.mocreoSensors as sensor (sensor.sensorId)}
					<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
						<div class="flex items-start justify-between gap-4">
							<!-- Sensor info -->
							<div class="flex-1">
								<div class="flex items-center gap-2">
									<span class="text-lg">{sensor.mappedEquipmentType ? typeIcon(sensor.mappedEquipmentType) : '📡'}</span>
									<h3 class="font-semibold text-[var(--color-tron-text)]">{sensor.sensorName}</h3>
									<span class="rounded bg-[var(--color-tron-surface)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--color-tron-text-secondary)] border border-[var(--color-tron-border)]">{sensor.model}</span>
								</div>
								<p class="mt-1 font-mono text-xs text-[var(--color-tron-text-secondary)]">ID: {sensor.sensorId}</p>
								
								{#if sensor.mappedEquipmentName}
									<p class="mt-1 text-xs">
										<span class="text-[var(--color-tron-text-secondary)]">Mapped to:</span>
										<span class="text-[var(--color-tron-cyan)] font-medium">{sensor.mappedEquipmentName}</span>
									</p>
								{:else}
									<p class="mt-1 text-xs text-amber-400/70">⚠ Not mapped to any equipment</p>
								{/if}
							</div>

							<!-- Temperature display -->
							<div class="text-right">
								<p class="text-2xl font-bold {tempColor(sensor.temperature)}">
									{formatTemp(sensor.temperature)}
								</p>
								{#if sensor.humidity != null}
									<p class="text-sm text-[var(--color-tron-text-secondary)]">{sensor.humidity.toFixed(1)}% RH</p>
								{/if}
								<p class="text-xs text-[var(--color-tron-text-secondary)]">{timeAgo(sensor.lastReadingAt)}</p>
								<p class="text-[10px] text-[var(--color-tron-text-secondary)]">{sensor.readingCount} readings</p>
							</div>
						</div>

						<!-- Mapping controls -->
						{#if data.isAdmin}
							{#if mappingFor === sensor.sensorId}
								<form method="POST" action="?/mapSensor" use:enhance={() => { return async ({ update }) => { mappingFor = null; await update(); }; }}
									class="mt-3 flex items-center gap-2 border-t border-[var(--color-tron-border)]/50 pt-3">
									<input type="hidden" name="mocreoDeviceId" value={sensor.sensorId} />
									<select name="equipmentId" bind:value={selectedEquipmentId}
										class="flex-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)]">
										<option value="">— Select equipment —</option>
										{#each data.equipment.filter(e => ['fridge', 'oven'].includes(e.equipmentType)) as eq (eq.id)}
											<option value={eq.id}>{typeIcon(eq.equipmentType)} {eq.name} ({eq.equipmentType})</option>
										{/each}
									</select>
									<button type="submit" class="rounded bg-[var(--color-tron-cyan)] px-3 py-2 text-xs font-semibold text-[var(--color-tron-bg)]" disabled={!selectedEquipmentId}>Map</button>
									<button type="button" onclick={() => { mappingFor = null; }} class="rounded border border-[var(--color-tron-border)] px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">Cancel</button>
								</form>
							{:else}
								<button type="button" onclick={() => { mappingFor = sensor.sensorId; selectedEquipmentId = sensor.mappedEquipmentId ?? ''; }}
									class="mt-2 text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)] underline">
									{sensor.mappedEquipmentId ? '🔗 Change mapping' : '🔗 Map to equipment'}
								</button>
							{/if}
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</section>

	<!-- Equipment with temperature data -->
	<section>
		<h2 class="mb-3 text-lg font-medium text-[var(--color-tron-cyan)]">Equipment Temperature Status</h2>
		<div class="overflow-x-auto rounded-lg border border-[var(--color-tron-border)]">
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
						<th class="px-4 py-2 text-left text-xs font-medium text-[var(--color-tron-text-secondary)]">Equipment</th>
						<th class="px-4 py-2 text-left text-xs font-medium text-[var(--color-tron-text-secondary)]">Type</th>
						<th class="px-4 py-2 text-center text-xs font-medium text-[var(--color-tron-text-secondary)]">Current Temp</th>
						<th class="px-4 py-2 text-center text-xs font-medium text-[var(--color-tron-text-secondary)]">Min / Max</th>
						<th class="px-4 py-2 text-left text-xs font-medium text-[var(--color-tron-text-secondary)]">Sensor</th>
						<th class="px-4 py-2 text-left text-xs font-medium text-[var(--color-tron-text-secondary)]">Last Reading</th>
					</tr>
				</thead>
				<tbody>
					{#each data.equipment.filter(e => ['fridge', 'oven'].includes(e.equipmentType)) as eq (eq.id)}
						{@const sensor = data.mocreoSensors.find(s => s.sensorId === eq.mocreoDeviceId)}
						<tr class="border-b border-[var(--color-tron-border)]/50 hover:bg-[var(--color-tron-surface)]">
							<td class="px-4 py-2 font-medium text-[var(--color-tron-text)]">{typeIcon(eq.equipmentType)} {eq.name}</td>
							<td class="px-4 py-2 text-[var(--color-tron-text-secondary)] capitalize">{eq.equipmentType}</td>
							<td class="px-4 py-2 text-center font-bold {tempColor(eq.currentTemperatureC, eq.temperatureMinC, eq.temperatureMaxC)}">
								{formatTemp(eq.currentTemperatureC)}
							</td>
							<td class="px-4 py-2 text-center text-xs text-[var(--color-tron-text-secondary)]">
								{eq.temperatureMinC != null ? eq.temperatureMinC + '°C' : '—'} / {eq.temperatureMaxC != null ? eq.temperatureMaxC + '°C' : '—'}
							</td>
							<td class="px-4 py-2 text-xs">
								{#if sensor}
									<span class="text-[var(--color-tron-cyan)]">{sensor.sensorName}</span>
								{:else if eq.mocreoDeviceId}
									<span class="font-mono text-[var(--color-tron-text-secondary)]">{eq.mocreoDeviceId}</span>
								{:else}
									<span class="text-amber-400/70">Not mapped</span>
								{/if}
							</td>
							<td class="px-4 py-2 text-xs text-[var(--color-tron-text-secondary)]">{timeAgo(eq.lastTemperatureReadAt)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>
</div>
