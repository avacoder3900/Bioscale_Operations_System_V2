<!--
	Thermocouple Chart Component (THERM-007)

	Displays temperature readings as a time-series chart with min/max range bands.
-->
<script lang="ts">
	interface ThermocoupleReading {
		timestamp: number;
		temperature: number;
	}

	interface Props {
		readings: ThermocoupleReading[];
		minTemp?: number;
		maxTemp?: number;
		showBands?: boolean;
	}

	let { readings, minTemp, maxTemp, showBands = true }: Props = $props();

	// Chart dimensions (used as viewBox for responsive sizing)
	const chartWidth = 600;
	const chartHeight = 300;
	const chartPadding = { top: 20, right: 30, bottom: 50, left: 60 };

	// Calculate chart scales
	let chartScales = $derived.by(() => {
		if (!readings || readings.length === 0) {
			return null;
		}

		// Sort by timestamp
		const sorted = [...readings].sort((a, b) => a.timestamp - b.timestamp);

		const xMin = sorted[0].timestamp;
		const xMax = sorted[sorted.length - 1].timestamp;

		// Calculate Y range with padding
		const temps = sorted.map((r) => r.temperature);
		let yMin = Math.min(...temps);
		let yMax = Math.max(...temps);

		// Extend Y range to include configured min/max if specified
		if (minTemp !== undefined) {
			yMin = Math.min(yMin, minTemp);
		}
		if (maxTemp !== undefined) {
			yMax = Math.max(yMax, maxTemp);
		}

		// Add 10% padding
		const yPadding = (yMax - yMin) * 0.1;
		yMin = yMin - yPadding;
		yMax = yMax + yPadding;

		const innerWidth = chartWidth - chartPadding.left - chartPadding.right;
		const innerHeight = chartHeight - chartPadding.top - chartPadding.bottom;

		return {
			xMin,
			xMax,
			yMin,
			yMax,
			innerWidth,
			innerHeight,
			sorted,
			scaleX: (x: number) => chartPadding.left + ((x - xMin) / (xMax - xMin || 1)) * innerWidth,
			scaleY: (y: number) =>
				chartPadding.top + innerHeight - ((y - yMin) / (yMax - yMin || 1)) * innerHeight
		};
	});

	// Generate SVG path for temperature line
	let temperaturePath = $derived.by(() => {
		if (!chartScales || chartScales.sorted.length === 0) return '';

		const points = chartScales.sorted.map(
			(r) => `${chartScales.scaleX(r.timestamp)},${chartScales.scaleY(r.temperature)}`
		);
		return `M ${points.join(' L ')}`;
	});

	// Check if a reading is outside the acceptable range
	function isOutOfRange(temp: number): boolean {
		if (minTemp !== undefined && temp < minTemp) return true;
		if (maxTemp !== undefined && temp > maxTemp) return true;
		return false;
	}

	// Format time for axis labels
	function formatTime(timestamp: number): string {
		const date = new Date(timestamp);
		return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
	}

	// Format duration
	function formatDuration(ms: number): string {
		const seconds = Math.floor(ms / 1000);
		const minutes = Math.floor(seconds / 60);
		const remainingSeconds = seconds % 60;
		if (minutes > 0) {
			return `${minutes}m ${remainingSeconds}s`;
		}
		return `${seconds}s`;
	}
</script>

<div class="tron-card p-4">
	<h3 class="tron-heading mb-4 font-semibold">Temperature Over Time</h3>

	{#if readings && readings.length > 0 && chartScales}
		{@const scales = chartScales}

		<div class="w-full overflow-x-auto">
			<svg
				viewBox="0 0 {chartWidth} {chartHeight}"
				class="w-full rounded bg-[var(--color-tron-bg-tertiary)]"
				style="min-width: 400px; max-height: 400px"
				preserveAspectRatio="xMidYMid meet"
			>
				<!-- Acceptable range bands -->
				{#if showBands && minTemp !== undefined && maxTemp !== undefined}
					<!-- Out-of-range areas (red) -->
					<rect
						x={chartPadding.left}
						y={chartPadding.top}
						width={scales.innerWidth}
						height={scales.scaleY(maxTemp) - chartPadding.top}
						fill="var(--color-tron-red)"
						opacity="0.1"
					/>
					<rect
						x={chartPadding.left}
						y={scales.scaleY(minTemp)}
						width={scales.innerWidth}
						height={chartHeight - chartPadding.bottom - scales.scaleY(minTemp)}
						fill="var(--color-tron-red)"
						opacity="0.1"
					/>

					<!-- Acceptable range (green) -->
					<rect
						x={chartPadding.left}
						y={scales.scaleY(maxTemp)}
						width={scales.innerWidth}
						height={scales.scaleY(minTemp) - scales.scaleY(maxTemp)}
						fill="var(--color-tron-green)"
						opacity="0.1"
					/>

					<!-- Min/Max lines -->
					<line
						x1={chartPadding.left}
						y1={scales.scaleY(maxTemp)}
						x2={chartWidth - chartPadding.right}
						y2={scales.scaleY(maxTemp)}
						stroke="var(--color-tron-green)"
						stroke-dasharray="4,4"
						stroke-width="1"
					/>
					<line
						x1={chartPadding.left}
						y1={scales.scaleY(minTemp)}
						x2={chartWidth - chartPadding.right}
						y2={scales.scaleY(minTemp)}
						stroke="var(--color-tron-green)"
						stroke-dasharray="4,4"
						stroke-width="1"
					/>

					<!-- Min/Max labels -->
					<text
						x={chartWidth - chartPadding.right + 5}
						y={scales.scaleY(maxTemp)}
						fill="var(--color-tron-green)"
						font-size="10"
						dominant-baseline="middle"
					>
						Max
					</text>
					<text
						x={chartWidth - chartPadding.right + 5}
						y={scales.scaleY(minTemp)}
						fill="var(--color-tron-green)"
						font-size="10"
						dominant-baseline="middle"
					>
						Min
					</text>
				{/if}

				<!-- Grid lines -->
				{#each [0.25, 0.5, 0.75] as fraction (fraction)}
					<line
						x1={chartPadding.left}
						y1={chartPadding.top + scales.innerHeight * fraction}
						x2={chartWidth - chartPadding.right}
						y2={chartPadding.top + scales.innerHeight * fraction}
						stroke="var(--color-tron-border)"
						stroke-dasharray="2,2"
					/>
				{/each}

				<!-- Axes -->
				<line
					x1={chartPadding.left}
					y1={chartPadding.top}
					x2={chartPadding.left}
					y2={chartHeight - chartPadding.bottom}
					stroke="var(--color-tron-text-secondary)"
					stroke-width="1"
				/>
				<line
					x1={chartPadding.left}
					y1={chartHeight - chartPadding.bottom}
					x2={chartWidth - chartPadding.right}
					y2={chartHeight - chartPadding.bottom}
					stroke="var(--color-tron-text-secondary)"
					stroke-width="1"
				/>

				<!-- Temperature line -->
				<path d={temperaturePath} fill="none" stroke="var(--color-tron-cyan)" stroke-width="2" />

				<!-- Data points (color-coded: red for out-of-range, cyan for in-range) -->
				{#if scales.sorted.length <= 50}
					{#each scales.sorted as reading (reading.timestamp)}
						{@const outOfRange = isOutOfRange(reading.temperature)}
						<circle
							cx={scales.scaleX(reading.timestamp)}
							cy={scales.scaleY(reading.temperature)}
							r={outOfRange ? 4 : 3}
							fill={outOfRange ? 'var(--color-tron-red)' : 'var(--color-tron-cyan)'}
						/>
					{/each}
				{:else}
					<!-- For many readings, only highlight out-of-range points -->
					{#each scales.sorted as reading (reading.timestamp)}
						{#if isOutOfRange(reading.temperature)}
							<circle
								cx={scales.scaleX(reading.timestamp)}
								cy={scales.scaleY(reading.temperature)}
								r="4"
								fill="var(--color-tron-red)"
							/>
						{/if}
					{/each}
				{/if}

				<!-- Y-axis labels (temperature) -->
				{#each [0, 0.25, 0.5, 0.75, 1.0] as fraction (fraction)}
					<text
						x={chartPadding.left - 10}
						y={chartPadding.top + scales.innerHeight * (1 - fraction)}
						text-anchor="end"
						fill="var(--color-tron-text-secondary)"
						font-size="10"
						dominant-baseline="middle"
					>
						{(scales.yMin + (scales.yMax - scales.yMin) * fraction).toFixed(1)}
					</text>
				{/each}

				<!-- X-axis labels (time) -->
				{#each [0, 0.5, 1.0] as fraction (fraction)}
					<text
						x={chartPadding.left + scales.innerWidth * fraction}
						y={chartHeight - chartPadding.bottom + 15}
						text-anchor="middle"
						fill="var(--color-tron-text-secondary)"
						font-size="10"
					>
						{formatTime(scales.xMin + (scales.xMax - scales.xMin) * fraction)}
					</text>
				{/each}

				<!-- Axis titles -->
				<text
					x={chartWidth / 2}
					y={chartHeight - 5}
					text-anchor="middle"
					fill="var(--color-tron-text-secondary)"
					font-size="12"
				>
					Time
				</text>
				<text
					x={15}
					y={chartHeight / 2}
					text-anchor="middle"
					fill="var(--color-tron-text-secondary)"
					font-size="12"
					transform="rotate(-90, 15, {chartHeight / 2})"
				>
					Temperature (°C)
				</text>
			</svg>
		</div>

		<!-- Legend -->
		<div class="mt-3 flex flex-wrap items-center justify-center gap-4 text-xs">
			<div class="flex items-center gap-1.5">
				<div class="h-0.5 w-4" style="background: var(--color-tron-cyan)"></div>
				<span class="tron-text-muted">Temperature</span>
			</div>
			{#if showBands && minTemp !== undefined && maxTemp !== undefined}
				<div class="flex items-center gap-1.5">
					<div
						class="h-3 w-4 rounded-sm"
						style="background: color-mix(in srgb, var(--color-tron-green) 20%, transparent); border: 1px dashed var(--color-tron-green)"
					></div>
					<span class="tron-text-muted">Acceptable Range ({minTemp}-{maxTemp}°C)</span>
				</div>
				<div class="flex items-center gap-1.5">
					<div class="h-2.5 w-2.5 rounded-full" style="background: var(--color-tron-red)"></div>
					<span class="tron-text-muted">Out of Range</span>
				</div>
			{/if}
		</div>

		<!-- Duration info -->
		{#if scales.sorted.length > 1}
			<div class="mt-2 text-center">
				<span class="tron-text-muted text-sm">
					Duration: {formatDuration(scales.xMax - scales.xMin)} |
					{scales.sorted.length} readings
				</span>
			</div>
		{/if}
	{:else}
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
					d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
				/>
			</svg>
			<p class="tron-text-muted mt-4">No temperature data to display</p>
		</div>
	{/if}
</div>
