<script lang="ts">
	import type { MagnetometerReading } from '$lib/services/magnetometer-serial';

	interface MagnetometerMetrics {
		avgMagnitude: number;
		minMagnitude: number;
		maxMagnitude: number;
		stdDevMagnitude: number;
		coefficientOfVariation: number;
		dominantAxis: 'x' | 'y' | 'z';
		dominantAxisAvg: number;
		detectedPolarity: 'positive' | 'negative';
		axisAverages: { x: number; y: number; z: number };
		readingCount: number;
		durationMs: number;
	}

	interface MagnetometerCriteria {
		minFieldStrength: number;
		maxFieldStrength: number;
		maxCoefficientOfVariation?: number;
	}

	interface Props {
		passed: boolean;
		metrics: MagnetometerMetrics;
		interpretation: string;
		failureReasons: string[];
		readings?: MagnetometerReading[];
		criteria?: MagnetometerCriteria;
	}

	let { passed, metrics, interpretation, failureReasons, readings, criteria }: Props = $props();

	// Chart dimensions
	const chartWidth = 600;
	const chartHeight = 300;
	const chartPadding = { top: 20, right: 30, bottom: 40, left: 60 };

	// Show/hide raw data
	let showRawData = $state(false);

	// Determine if a reading is out of spec
	function isOutOfSpec(reading: MagnetometerReading): boolean {
		if (!criteria) return false;
		const mag = reading.magnitude;
		return mag < criteria.minFieldStrength || mag > criteria.maxFieldStrength;
	}

	// Format numbers for display
	function formatNumber(value: number, decimals: number = 2): string {
		return value.toFixed(decimals);
	}

	function formatDuration(ms: number): string {
		if (ms < 1000) return `${ms}ms`;
		if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
		return `${(ms / 60000).toFixed(1)}m`;
	}

	function formatPercentage(value: number): string {
		return `${(value * 100).toFixed(1)}%`;
	}

	// Count out-of-spec readings
	let outOfSpecCount = $derived(readings?.filter(isOutOfSpec).length ?? 0);

	// Chart calculations
	let sortedReadings = $derived(
		readings ? [...readings].sort((a, b) => a.timestamp - b.timestamp) : []
	);

	let chartScales = $derived.by(() => {
		if (sortedReadings.length === 0) return null;

		const xMin = sortedReadings[0].timestamp;
		const xMax = sortedReadings[sortedReadings.length - 1].timestamp;
		const magnitudes = sortedReadings.map((r) => r.magnitude);
		let yMin = Math.min(...magnitudes);
		let yMax = Math.max(...magnitudes);

		// Include spec bounds in y-range if present
		if (criteria) {
			yMin = Math.min(yMin, criteria.minFieldStrength);
			yMax = Math.max(yMax, criteria.maxFieldStrength);
		}

		// Add 10% padding
		const yRange = yMax - yMin || 1;
		yMin -= yRange * 0.1;
		yMax += yRange * 0.1;

		const innerWidth = chartWidth - chartPadding.left - chartPadding.right;
		const innerHeight = chartHeight - chartPadding.top - chartPadding.bottom;
		const xRange = xMax - xMin || 1;

		return {
			xMin,
			xMax,
			yMin,
			yMax,
			innerWidth,
			innerHeight,
			scaleX: (x: number) => chartPadding.left + ((x - xMin) / xRange) * innerWidth,
			scaleY: (y: number) =>
				chartPadding.top + innerHeight - ((y - yMin) / (yMax - yMin)) * innerHeight
		};
	});

	// SVG path for magnitude line
	let magnitudePath = $derived.by(() => {
		if (!chartScales || sortedReadings.length === 0) return '';
		const points = sortedReadings.map(
			(r) => `${chartScales.scaleX(r.timestamp)},${chartScales.scaleY(r.magnitude)}`
		);
		return `M ${points.join(' L ')}`;
	});

	// Average line Y position
	let avgLineY = $derived(chartScales ? chartScales.scaleY(metrics.avgMagnitude) : 0);

	// Y-axis tick values
	let yTicks = $derived.by(() => {
		if (!chartScales) return [];
		const range = chartScales.yMax - chartScales.yMin;
		const step = range / 4;
		return [0, 1, 2, 3, 4].map((i) => chartScales.yMin + step * i);
	});
</script>

<div class="space-y-6">
	<!-- Pass/Fail Banner -->
	<div
		class="rounded-lg p-6 text-center {passed
			? 'border border-[var(--color-tron-green)] bg-[var(--color-tron-green)]/10'
			: 'border border-[var(--color-tron-red)] bg-[var(--color-tron-red)]/10'}"
	>
		<div class="flex items-center justify-center gap-3">
			{#if passed}
				<svg
					class="h-12 w-12 text-[var(--color-tron-green)]"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
					/>
				</svg>
				<span class="text-3xl font-bold text-[var(--color-tron-green)]">PASSED</span>
			{:else}
				<svg
					class="h-12 w-12 text-[var(--color-tron-red)]"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"
					/>
				</svg>
				<span class="text-3xl font-bold text-[var(--color-tron-red)]">FAILED</span>
			{/if}
		</div>

		<p class="tron-text-muted mt-4 text-sm">{interpretation}</p>

		{#if failureReasons.length > 0}
			<div class="mt-4 space-y-1">
				{#each failureReasons as reason (reason)}
					<div class="text-sm text-[var(--color-tron-red)]">
						<span class="mr-1">•</span>{reason}
					</div>
				{/each}
			</div>
		{/if}
	</div>

	<!-- Magnitude Chart -->
	{#if sortedReadings.length > 0 && chartScales}
		<div class="tron-card p-4">
			<h3 class="tron-heading mb-4 font-semibold">Field Strength Over Time</h3>

			<div class="flex justify-center overflow-x-auto">
				<svg
					width={chartWidth}
					height={chartHeight}
					class="rounded bg-[var(--color-tron-bg-tertiary)]"
				>
					<!-- Grid lines -->
					{#each yTicks as tick (tick)}
						<line
							x1={chartPadding.left}
							y1={chartScales.scaleY(tick)}
							x2={chartWidth - chartPadding.right}
							y2={chartScales.scaleY(tick)}
							stroke="var(--color-tron-border)"
							stroke-dasharray="2,2"
						/>
					{/each}

					<!-- Spec bounds band -->
					{#if criteria}
						<rect
							x={chartPadding.left}
							y={chartScales.scaleY(criteria.maxFieldStrength)}
							width={chartScales.innerWidth}
							height={chartScales.scaleY(criteria.minFieldStrength) -
								chartScales.scaleY(criteria.maxFieldStrength)}
							fill="var(--color-tron-green)"
							opacity="0.06"
						/>
						<line
							x1={chartPadding.left}
							y1={chartScales.scaleY(criteria.minFieldStrength)}
							x2={chartWidth - chartPadding.right}
							y2={chartScales.scaleY(criteria.minFieldStrength)}
							stroke="var(--color-tron-green)"
							stroke-dasharray="4,4"
							opacity="0.5"
						/>
						<line
							x1={chartPadding.left}
							y1={chartScales.scaleY(criteria.maxFieldStrength)}
							x2={chartWidth - chartPadding.right}
							y2={chartScales.scaleY(criteria.maxFieldStrength)}
							stroke="var(--color-tron-green)"
							stroke-dasharray="4,4"
							opacity="0.5"
						/>
					{/if}

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

					<!-- Magnitude line -->
					<path
						d={magnitudePath}
						fill="none"
						stroke="var(--color-tron-purple)"
						stroke-width="2"
					/>

					<!-- Average line -->
					<line
						x1={chartPadding.left}
						y1={avgLineY}
						x2={chartWidth - chartPadding.right}
						y2={avgLineY}
						stroke="var(--color-tron-cyan)"
						stroke-dasharray="6,3"
						stroke-width="1"
					/>
					<text
						x={chartWidth - chartPadding.right + 4}
						y={avgLineY + 4}
						fill="var(--color-tron-cyan)"
						font-size="10"
					>
						avg
					</text>

					<!-- Out-of-spec points -->
					{#each sortedReadings as reading (reading.timestamp)}
						{#if isOutOfSpec(reading)}
							<circle
								cx={chartScales.scaleX(reading.timestamp)}
								cy={chartScales.scaleY(reading.magnitude)}
								r="4"
								fill="var(--color-tron-red)"
								opacity="0.8"
							/>
						{/if}
					{/each}

					<!-- Y-axis labels -->
					{#each yTicks as tick (tick)}
						<text
							x={chartPadding.left - 8}
							y={chartScales.scaleY(tick)}
							text-anchor="end"
							fill="var(--color-tron-text-secondary)"
							font-size="10"
							dominant-baseline="middle"
						>
							{tick.toFixed(1)}
						</text>
					{/each}

					<!-- X-axis labels -->
					{#each [0, 0.25, 0.5, 0.75, 1.0] as fraction (fraction)}
						{@const time = chartScales.xMin + (chartScales.xMax - chartScales.xMin) * fraction}
						<text
							x={chartPadding.left + chartScales.innerWidth * fraction}
							y={chartHeight - chartPadding.bottom + 15}
							text-anchor="middle"
							fill="var(--color-tron-text-secondary)"
							font-size="10"
						>
							{((time - chartScales.xMin) / 1000).toFixed(1)}s
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
						Time (s)
					</text>
					<text
						x={15}
						y={chartHeight / 2}
						text-anchor="middle"
						fill="var(--color-tron-text-secondary)"
						font-size="12"
						transform="rotate(-90, 15, {chartHeight / 2})"
					>
						Magnitude (µT)
					</text>
				</svg>
			</div>

			<!-- Chart legend -->
			<div class="mt-3 flex flex-wrap items-center justify-center gap-4 text-xs">
				<div class="flex items-center gap-1">
					<div class="h-0.5 w-4" style="background: var(--color-tron-purple)"></div>
					<span class="tron-text-muted">Magnitude</span>
				</div>
				<div class="flex items-center gap-1">
					<div
						class="h-0.5 w-4"
						style="background: var(--color-tron-cyan); border-top: 1px dashed var(--color-tron-cyan)"
					></div>
					<span class="tron-text-muted">Average ({formatNumber(metrics.avgMagnitude)} µT)</span>
				</div>
				{#if criteria}
					<div class="flex items-center gap-1">
						<div class="h-3 w-4 rounded" style="background: rgba(0, 255, 100, 0.15)"></div>
						<span class="tron-text-muted"
							>Spec ({criteria.minFieldStrength} - {criteria.maxFieldStrength} µT)</span
						>
					</div>
				{/if}
				{#if outOfSpecCount > 0}
					<div class="flex items-center gap-1">
						<div class="h-2 w-2 rounded-full" style="background: var(--color-tron-red)"></div>
						<span class="tron-text-muted">Out of Spec ({outOfSpecCount})</span>
					</div>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Key Metrics -->
	<div class="grid gap-4 md:grid-cols-3">
		<!-- Average Magnitude -->
		<div class="tron-card p-4">
			<div class="tron-text-muted text-xs uppercase">Avg Field Strength</div>
			<div class="tron-heading mt-1 text-2xl font-bold text-[var(--color-tron-purple)]">
				{formatNumber(metrics.avgMagnitude)} <span class="text-sm font-normal">µT</span>
			</div>
			<div class="tron-text-muted mt-1 text-xs">
				Range: {formatNumber(metrics.minMagnitude)} - {formatNumber(metrics.maxMagnitude)} µT
			</div>
		</div>

		<!-- Uniformity -->
		<div class="tron-card p-4">
			<div class="tron-text-muted text-xs uppercase">Field Uniformity</div>
			<div
				class="mt-1 text-2xl font-bold {metrics.coefficientOfVariation <= 0.25
					? 'text-[var(--color-tron-green)]'
					: 'text-[var(--color-tron-orange)]'}"
			>
				{formatPercentage(1 - metrics.coefficientOfVariation)}
			</div>
			<div class="tron-text-muted mt-1 text-xs">
				CV: {formatPercentage(metrics.coefficientOfVariation)} (Std Dev: {formatNumber(
					metrics.stdDevMagnitude
				)})
			</div>
		</div>

		<!-- Polarity -->
		<div class="tron-card p-4">
			<div class="tron-text-muted text-xs uppercase">Dominant Axis & Polarity</div>
			<div class="tron-heading mt-1 text-2xl font-bold">
				{metrics.dominantAxis.toUpperCase()}-axis
				<span
					class="ml-2 text-lg {metrics.detectedPolarity === 'positive'
						? 'text-[var(--color-tron-cyan)]'
						: 'text-[var(--color-tron-orange)]'}"
				>
					({metrics.detectedPolarity === 'positive' ? '+' : '-'})
				</span>
			</div>
			<div class="tron-text-muted mt-1 text-xs">
				Avg: {formatNumber(metrics.dominantAxisAvg)} µT
			</div>
		</div>
	</div>

	<!-- Additional Stats -->
	<div class="grid gap-4 md:grid-cols-5">
		<div class="tron-card p-3 text-center">
			<div class="tron-text-muted text-xs">Readings</div>
			<div class="tron-heading mt-1 text-xl font-bold">{metrics.readingCount}</div>
		</div>
		<div class="tron-card p-3 text-center">
			<div class="tron-text-muted text-xs">Duration</div>
			<div class="tron-heading mt-1 text-xl font-bold">{formatDuration(metrics.durationMs)}</div>
		</div>
		<div class="tron-card p-3 text-center">
			<div class="tron-text-muted text-xs">X-Avg</div>
			<div class="tron-heading mt-1 text-xl font-bold">{formatNumber(metrics.axisAverages.x)}</div>
		</div>
		<div class="tron-card p-3 text-center">
			<div class="tron-text-muted text-xs">Y-Avg</div>
			<div class="tron-heading mt-1 text-xl font-bold">{formatNumber(metrics.axisAverages.y)}</div>
		</div>
		<div class="tron-card p-3 text-center">
			<div class="tron-text-muted text-xs">Z-Avg</div>
			<div class="tron-heading mt-1 text-xl font-bold">{formatNumber(metrics.axisAverages.z)}</div>
		</div>
	</div>

	<!-- Readings Table (Collapsible) -->
	{#if readings && readings.length > 0}
		<div class="tron-card">
			<button
				onclick={() => (showRawData = !showRawData)}
				class="flex w-full items-center justify-between p-4 text-left transition-colors hover:bg-[var(--color-tron-bg-tertiary)]"
			>
				<div>
					<h3 class="tron-heading font-semibold">Readings Data</h3>
					{#if outOfSpecCount > 0}
						<span class="text-sm text-[var(--color-tron-red)]">
							{outOfSpecCount} out-of-spec reading{outOfSpecCount !== 1 ? 's' : ''}
						</span>
					{/if}
				</div>
				<div class="flex items-center gap-3">
					{#if criteria}
						<span class="tron-text-muted text-xs">
							Spec: {criteria.minFieldStrength} - {criteria.maxFieldStrength} µT
						</span>
					{/if}
					<svg
						class="h-5 w-5 transform transition-transform {showRawData ? 'rotate-180' : ''}"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M19 9l-7 7-7-7"
						/>
					</svg>
				</div>
			</button>

			{#if showRawData}
				<div class="max-h-64 overflow-y-auto border-t border-[var(--color-tron-border)]">
					<table class="w-full text-sm">
						<thead class="sticky top-0 bg-[var(--color-tron-bg-secondary)]">
							<tr class="text-left">
								<th class="tron-text-muted p-2">#</th>
								<th class="tron-text-muted p-2">Magnitude</th>
								<th class="tron-text-muted p-2">X</th>
								<th class="tron-text-muted p-2">Y</th>
								<th class="tron-text-muted p-2">Z</th>
								<th class="tron-text-muted p-2">Status</th>
							</tr>
						</thead>
						<tbody>
							{#each readings as reading, i (reading.timestamp)}
								{@const outOfSpec = isOutOfSpec(reading)}
								<tr
									class="border-t border-[var(--color-tron-border)] {outOfSpec
										? 'bg-[var(--color-tron-red)]/5'
										: ''}"
								>
									<td class="tron-text-muted p-2">{i + 1}</td>
									<td
										class="p-2 font-medium {outOfSpec
											? 'text-[var(--color-tron-red)]'
											: 'tron-heading'}"
									>
										{formatNumber(reading.magnitude)}
									</td>
									<td class="p-2">{formatNumber(reading.x, 3)}</td>
									<td class="p-2">{formatNumber(reading.y, 3)}</td>
									<td class="p-2">{formatNumber(reading.z, 3)}</td>
									<td class="p-2">
										{#if outOfSpec}
											<span
												class="rounded bg-[var(--color-tron-red)]/20 px-2 py-0.5 text-xs text-[var(--color-tron-red)]"
											>
												Out of Spec
											</span>
										{:else}
											<span
												class="rounded bg-[var(--color-tron-green)]/20 px-2 py-0.5 text-xs text-[var(--color-tron-green)]"
											>
												OK
											</span>
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>

				{#if readings.length > 50}
					<div
						class="tron-text-muted border-t border-[var(--color-tron-border)] p-2 text-center text-xs"
					>
						Showing all {readings.length} readings
					</div>
				{/if}
			{/if}
		</div>
	{/if}
</div>
