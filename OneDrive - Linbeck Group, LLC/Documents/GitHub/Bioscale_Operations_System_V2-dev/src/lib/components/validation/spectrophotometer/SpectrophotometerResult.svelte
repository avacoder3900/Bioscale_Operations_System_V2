<script lang="ts">
	interface SpectrophotometerReading {
		wavelength: number;
		absorbance: number;
		transmittance?: number;
	}

	interface SpectrophotometerMetrics {
		peakWavelength: number;
		peakAbsorbance: number;
		baselineAbsorbance: number;
		baselineDrift: number;
		fwhm: number | null;
		integratedAbsorbance: number;
		dataPointCount: number;
		wavelengthRange: { min: number; max: number };
		averageAbsorbance: number;
	}

	interface Props {
		passed: boolean;
		metrics: SpectrophotometerMetrics;
		interpretation: string;
		failureReasons: string[];
		details: string[];
		readings?: SpectrophotometerReading[];
	}

	let { passed, metrics, interpretation, failureReasons, details, readings }: Props = $props();

	// Chart dimensions
	const chartWidth = 600;
	const chartHeight = 300;
	const chartPadding = { top: 20, right: 30, bottom: 40, left: 60 };

	// Show/hide raw data
	let showRawData = $state(false);

	// Calculate chart scales
	let chartScales = $derived(() => {
		if (!readings || readings.length === 0) {
			return null;
		}

		const xMin = Math.min(...readings.map((r) => r.wavelength));
		const xMax = Math.max(...readings.map((r) => r.wavelength));
		const yMin = 0;
		const yMax = Math.max(...readings.map((r) => r.absorbance)) * 1.1;

		const innerWidth = chartWidth - chartPadding.left - chartPadding.right;
		const innerHeight = chartHeight - chartPadding.top - chartPadding.bottom;

		return {
			xMin,
			xMax,
			yMin,
			yMax,
			innerWidth,
			innerHeight,
			scaleX: (x: number) => chartPadding.left + ((x - xMin) / (xMax - xMin)) * innerWidth,
			scaleY: (y: number) =>
				chartPadding.top + innerHeight - ((y - yMin) / (yMax - yMin)) * innerHeight
		};
	});

	// Generate SVG path for spectrum line
	let spectrumPath = $derived(() => {
		const scales = chartScales();
		if (!scales || !readings || readings.length === 0) return '';

		const sorted = [...readings].sort((a, b) => a.wavelength - b.wavelength);
		const points = sorted.map(
			(r) => `${scales.scaleX(r.wavelength)},${scales.scaleY(r.absorbance)}`
		);
		return `M ${points.join(' L ')}`;
	});

	// Format numbers
	function formatNumber(value: number, decimals: number = 3): string {
		return value.toFixed(decimals);
	}
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

	<!-- Spectrum Chart -->
	{#if readings && readings.length > 0 && chartScales()}
		{@const scales = chartScales()}
		<div class="tron-card p-4">
			<h3 class="tron-heading mb-4 font-semibold">Absorbance Spectrum</h3>

			<div class="flex justify-center overflow-x-auto">
				<svg
					width={chartWidth}
					height={chartHeight}
					class="rounded bg-[var(--color-tron-bg-tertiary)]"
				>
					<!-- Grid lines -->
					{#if scales}
						{#each [0.25, 0.5, 0.75, 1.0] as fraction}
							<line
								x1={chartPadding.left}
								y1={scales.scaleY(scales.yMax * fraction)}
								x2={chartWidth - chartPadding.right}
								y2={scales.scaleY(scales.yMax * fraction)}
								stroke="var(--color-tron-border)"
								stroke-dasharray="2,2"
							/>
						{/each}
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

					<!-- Spectrum line -->
					<path d={spectrumPath()} fill="none" stroke="var(--color-tron-cyan)" stroke-width="2" />

					<!-- Peak marker -->
					{#if scales}
						<circle
							cx={scales.scaleX(metrics.peakWavelength)}
							cy={scales.scaleY(metrics.peakAbsorbance)}
							r="5"
							fill="var(--color-tron-purple)"
						/>
						<text
							x={scales.scaleX(metrics.peakWavelength)}
							y={scales.scaleY(metrics.peakAbsorbance) - 10}
							text-anchor="middle"
							fill="var(--color-tron-purple)"
							font-size="12"
						>
							{metrics.peakWavelength.toFixed(0)} nm
						</text>
					{/if}

					<!-- Y-axis labels -->
					{#if scales}
						{#each [0, 0.5, 1.0] as fraction}
							<text
								x={chartPadding.left - 10}
								y={scales.scaleY(scales.yMax * fraction)}
								text-anchor="end"
								fill="var(--color-tron-text-secondary)"
								font-size="10"
								dominant-baseline="middle"
							>
								{(scales.yMax * fraction).toFixed(2)}
							</text>
						{/each}
					{/if}

					<!-- X-axis labels -->
					{#if scales}
						{#each [0, 0.25, 0.5, 0.75, 1.0] as fraction}
							<text
								x={chartPadding.left + scales.innerWidth * fraction}
								y={chartHeight - chartPadding.bottom + 15}
								text-anchor="middle"
								fill="var(--color-tron-text-secondary)"
								font-size="10"
							>
								{(scales.xMin + (scales.xMax - scales.xMin) * fraction).toFixed(0)}
							</text>
						{/each}
					{/if}

					<!-- Axis titles -->
					<text
						x={chartWidth / 2}
						y={chartHeight - 5}
						text-anchor="middle"
						fill="var(--color-tron-text-secondary)"
						font-size="12"
					>
						Wavelength (nm)
					</text>
					<text
						x={15}
						y={chartHeight / 2}
						text-anchor="middle"
						fill="var(--color-tron-text-secondary)"
						font-size="12"
						transform="rotate(-90, 15, {chartHeight / 2})"
					>
						Absorbance (AU)
					</text>
				</svg>
			</div>
		</div>
	{/if}

	<!-- Key Metrics -->
	<div class="grid gap-4 md:grid-cols-3">
		<!-- Peak Wavelength -->
		<div class="tron-card p-4">
			<div class="tron-text-muted text-xs uppercase">Peak Wavelength</div>
			<div class="tron-heading mt-1 text-2xl font-bold text-[var(--color-tron-cyan)]">
				{formatNumber(metrics.peakWavelength, 1)} <span class="text-sm font-normal">nm</span>
			</div>
		</div>

		<!-- Peak Absorbance -->
		<div class="tron-card p-4">
			<div class="tron-text-muted text-xs uppercase">Peak Absorbance</div>
			<div class="tron-heading mt-1 text-2xl font-bold text-[var(--color-tron-purple)]">
				{formatNumber(metrics.peakAbsorbance)} <span class="text-sm font-normal">AU</span>
			</div>
		</div>

		<!-- Baseline Drift -->
		<div class="tron-card p-4">
			<div class="tron-text-muted text-xs uppercase">Baseline Drift</div>
			<div
				class="mt-1 text-2xl font-bold {metrics.baselineDrift <= 0.1
					? 'text-[var(--color-tron-green)]'
					: 'text-[var(--color-tron-orange)]'}"
			>
				{formatNumber(metrics.baselineDrift, 4)}
			</div>
		</div>
	</div>

	<!-- Additional Stats -->
	<div class="grid gap-4 md:grid-cols-4">
		<div class="tron-card p-3 text-center">
			<div class="tron-text-muted text-xs">Data Points</div>
			<div class="tron-heading mt-1 text-xl font-bold">{metrics.dataPointCount}</div>
		</div>
		<div class="tron-card p-3 text-center">
			<div class="tron-text-muted text-xs">FWHM</div>
			<div class="tron-heading mt-1 text-xl font-bold">
				{metrics.fwhm !== null ? `${formatNumber(metrics.fwhm, 1)} nm` : 'N/A'}
			</div>
		</div>
		<div class="tron-card p-3 text-center">
			<div class="tron-text-muted text-xs">Integrated</div>
			<div class="tron-heading mt-1 text-xl font-bold">
				{formatNumber(metrics.integratedAbsorbance, 1)}
			</div>
		</div>
		<div class="tron-card p-3 text-center">
			<div class="tron-text-muted text-xs">Avg Absorbance</div>
			<div class="tron-heading mt-1 text-xl font-bold">
				{formatNumber(metrics.averageAbsorbance)}
			</div>
		</div>
	</div>

	<!-- Details -->
	{#if details.length > 0}
		<div class="tron-card p-4">
			<h3 class="tron-heading mb-3 font-semibold">Analysis Details</h3>
			<ul class="tron-text-muted space-y-1 text-sm">
				{#each details as detail (detail)}
					<li class="flex items-start gap-2">
						<span class="text-[var(--color-tron-cyan)]">•</span>
						{detail}
					</li>
				{/each}
			</ul>
		</div>
	{/if}

	<!-- Expandable Raw Data -->
	{#if readings && readings.length > 0}
		<div class="tron-card">
			<button
				onclick={() => (showRawData = !showRawData)}
				class="flex w-full items-center justify-between p-4 text-left transition-colors hover:bg-[var(--color-tron-bg-tertiary)]"
			>
				<h3 class="tron-heading font-semibold">Raw Data</h3>
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
			</button>

			{#if showRawData}
				<div class="max-h-64 overflow-y-auto border-t border-[var(--color-tron-border)]">
					<table class="w-full text-sm">
						<thead class="sticky top-0 bg-[var(--color-tron-bg-secondary)]">
							<tr class="text-left">
								<th class="tron-text-muted p-2">#</th>
								<th class="tron-text-muted p-2">Wavelength (nm)</th>
								<th class="tron-text-muted p-2">Absorbance (AU)</th>
								<th class="tron-text-muted p-2">Transmittance (%)</th>
							</tr>
						</thead>
						<tbody>
							{#each readings as reading, i (reading.wavelength)}
								<tr class="border-t border-[var(--color-tron-border)]">
									<td class="tron-text-muted p-2">{i + 1}</td>
									<td class="tron-heading p-2">{formatNumber(reading.wavelength, 1)}</td>
									<td class="p-2">{formatNumber(reading.absorbance)}</td>
									<td class="p-2"
										>{formatNumber(
											reading.transmittance ?? Math.pow(10, -reading.absorbance) * 100,
											1
										)}</td
									>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
	{/if}
</div>
