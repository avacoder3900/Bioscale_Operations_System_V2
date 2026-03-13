<script lang="ts">
	/**
	 * ThermocoupleTable - Temperature data table with statistics (THERM-008)
	 *
	 * Displays temperature readings in a sortable table with:
	 * - Time, Temperature, and Status columns
	 * - Summary statistics (min/max/avg/std dev)
	 * - Row highlighting for out-of-range values
	 * - CSV export functionality
	 */

	export interface TemperatureReading {
		timestamp: number;
		temperature: number;
		unit: 'C' | 'F';
	}

	interface Props {
		readings: TemperatureReading[];
		minTemp: number;
		maxTemp: number;
		title?: string;
	}

	let { readings, minTemp, maxTemp, title = 'Temperature Readings' }: Props = $props();

	// Sort state
	type SortField = 'time' | 'temperature';
	type SortDirection = 'asc' | 'desc';
	let sortField = $state<SortField>('time');
	let sortDirection = $state<SortDirection>('asc');

	// Calculate statistics
	let stats = $derived.by(() => {
		if (readings.length === 0) {
			return { min: 0, max: 0, avg: 0, stdDev: 0, count: 0, outOfRange: 0 };
		}

		const temps = readings.map((r) => r.temperature);
		const min = Math.min(...temps);
		const max = Math.max(...temps);
		const avg = temps.reduce((a, b) => a + b, 0) / temps.length;

		// Calculate standard deviation
		const squaredDiffs = temps.map((t) => Math.pow(t - avg, 2));
		const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / temps.length;
		const stdDev = Math.sqrt(avgSquaredDiff);

		// Count out of range
		const outOfRange = readings.filter((r) => r.temperature < minTemp || r.temperature > maxTemp).length;

		return { min, max, avg, stdDev, count: readings.length, outOfRange };
	});

	// Sort readings
	let sortedReadings = $derived.by(() => {
		const sorted = [...readings];
		sorted.sort((a, b) => {
			let comparison = 0;
			if (sortField === 'time') {
				comparison = a.timestamp - b.timestamp;
			} else {
				comparison = a.temperature - b.temperature;
			}
			return sortDirection === 'asc' ? comparison : -comparison;
		});
		return sorted;
	});

	// Toggle sort
	function toggleSort(field: SortField) {
		if (sortField === field) {
			sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
		} else {
			sortField = field;
			sortDirection = 'asc';
		}
	}

	// Check if reading is in range
	function isInRange(temp: number): boolean {
		return temp >= minTemp && temp <= maxTemp;
	}

	// Format temperature
	function formatTemp(temp: number): string {
		return temp.toFixed(2);
	}

	// Format time
	function formatTime(timestamp: number): string {
		return new Date(timestamp).toLocaleTimeString('en-US', {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		});
	}

	// Export to CSV
	function exportCsv() {
		const headers = ['Time', 'Timestamp', 'Temperature (°C)', 'Status'];
		const rows = sortedReadings.map((r) => [
			formatTime(r.timestamp),
			r.timestamp.toString(),
			r.temperature.toFixed(4),
			isInRange(r.temperature) ? 'In Range' : 'Out of Range'
		]);

		// Add summary row
		rows.push([]);
		rows.push(['--- Statistics ---']);
		rows.push(['Min Temperature', '', formatTemp(stats.min), '']);
		rows.push(['Max Temperature', '', formatTemp(stats.max), '']);
		rows.push(['Average', '', formatTemp(stats.avg), '']);
		rows.push(['Std Deviation', '', formatTemp(stats.stdDev), '']);
		rows.push(['Total Readings', stats.count.toString(), '', '']);
		rows.push(['Out of Range', stats.outOfRange.toString(), '', '']);
		rows.push(['Expected Range', '', `${minTemp} - ${maxTemp}`, '']);

		const csv = [headers, ...rows].map((row) => row.join(',')).join('\n');
		const blob = new Blob([csv], { type: 'text/csv' });
		const url = URL.createObjectURL(blob);

		const a = document.createElement('a');
		a.href = url;
		a.download = `thermocouple-data-${new Date().toISOString().split('T')[0]}.csv`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	}

	// Get sort icon
	function getSortIcon(field: SortField): string {
		if (sortField !== field) return 'M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4';
		return sortDirection === 'asc'
			? 'M5 15l7-7 7 7' // Up arrow
			: 'M19 9l-7 7-7-7'; // Down arrow
	}
</script>

<div class="space-y-4">
	<!-- Header with title and export button -->
	<div class="flex items-center justify-between">
		<h3 class="tron-heading text-lg font-semibold">{title}</h3>
		{#if readings.length > 0}
			<button
				onclick={exportCsv}
				class="tron-btn-secondary flex items-center gap-2 px-3 py-2 text-sm"
			>
				<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
					/>
				</svg>
				Export CSV
			</button>
		{/if}
	</div>

	<!-- Statistics Summary -->
	{#if readings.length > 0}
		<div class="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
			<div class="tron-card p-3">
				<span class="tron-text-muted block text-xs uppercase">Min</span>
				<span class="tron-heading text-lg font-bold">{formatTemp(stats.min)}°C</span>
			</div>
			<div class="tron-card p-3">
				<span class="tron-text-muted block text-xs uppercase">Max</span>
				<span class="tron-heading text-lg font-bold">{formatTemp(stats.max)}°C</span>
			</div>
			<div class="tron-card p-3">
				<span class="tron-text-muted block text-xs uppercase">Average</span>
				<span class="tron-heading text-lg font-bold">{formatTemp(stats.avg)}°C</span>
			</div>
			<div class="tron-card p-3">
				<span class="tron-text-muted block text-xs uppercase">Std Dev</span>
				<span class="tron-heading text-lg font-bold">{formatTemp(stats.stdDev)}°C</span>
			</div>
			<div class="tron-card p-3">
				<span class="tron-text-muted block text-xs uppercase">Readings</span>
				<span class="tron-heading text-lg font-bold">{stats.count}</span>
			</div>
			<div class="tron-card p-3">
				<span class="tron-text-muted block text-xs uppercase">Out of Range</span>
				<span
					class="text-lg font-bold {stats.outOfRange > 0
						? 'text-[var(--color-tron-red)]'
						: 'text-[var(--color-tron-green)]'}"
				>
					{stats.outOfRange}
				</span>
			</div>
		</div>
	{/if}

	<!-- Data Table -->
	<div class="tron-card overflow-hidden">
		{#if readings.length === 0}
			<div class="p-8 text-center">
				<svg
					class="mx-auto h-12 w-12 text-[var(--color-tron-text-secondary)]"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
					/>
				</svg>
				<p class="tron-text-muted mt-4">No temperature readings to display</p>
			</div>
		{:else}
			<div class="max-h-96 overflow-y-auto">
				<table class="w-full text-sm">
					<thead class="sticky top-0 bg-[var(--color-tron-bg-secondary)]">
						<tr>
							<th class="tron-text-muted p-3 text-left">#</th>
							<th class="p-3 text-left">
								<button
									onclick={() => toggleSort('time')}
									class="flex items-center gap-2 transition-colors hover:text-[var(--color-tron-cyan)]"
								>
									<span class="tron-text-muted">Time</span>
									<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d={getSortIcon('time')}
										/>
									</svg>
								</button>
							</th>
							<th class="p-3 text-left">
								<button
									onclick={() => toggleSort('temperature')}
									class="flex items-center gap-2 transition-colors hover:text-[var(--color-tron-cyan)]"
								>
									<span class="tron-text-muted">Temperature</span>
									<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d={getSortIcon('temperature')}
										/>
									</svg>
								</button>
							</th>
							<th class="tron-text-muted p-3 text-left">Status</th>
						</tr>
					</thead>
					<tbody>
						{#each sortedReadings as reading, i (reading.timestamp)}
							{@const inRange = isInRange(reading.temperature)}
							<tr
								class="border-t border-[var(--color-tron-border)] transition-colors
								{!inRange ? 'bg-[var(--color-tron-red)]/5' : 'hover:bg-[var(--color-tron-bg-tertiary)]'}"
							>
								<td class="tron-text-muted p-3">{i + 1}</td>
								<td class="tron-text-muted p-3 font-mono">{formatTime(reading.timestamp)}</td>
								<td class="p-3">
									<span
										class="font-mono font-medium
										{inRange ? 'tron-heading' : 'text-[var(--color-tron-red)]'}"
									>
										{formatTemp(reading.temperature)}°C
									</span>
								</td>
								<td class="p-3">
									<span
										class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium
										{inRange
											? 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]'
											: 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]'}"
									>
										{#if inRange}
											<svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
												<path
													stroke-linecap="round"
													stroke-linejoin="round"
													stroke-width="2"
													d="M5 13l4 4L19 7"
												/>
											</svg>
											In Range
										{:else}
											<svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
												<path
													stroke-linecap="round"
													stroke-linejoin="round"
													stroke-width="2"
													d="M6 18L18 6M6 6l12 12"
												/>
											</svg>
											Out of Range
										{/if}
									</span>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			<!-- Range Info Footer -->
			<div class="border-t border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] px-4 py-2">
				<span class="tron-text-muted text-xs">
					Expected range: {minTemp}°C - {maxTemp}°C
				</span>
			</div>
		{/if}
	</div>
</div>
