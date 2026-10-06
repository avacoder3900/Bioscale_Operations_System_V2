<!--
	Thermocouple Result Component (THERM-009)

	Displays complete thermocouple validation results including:
	- Pass/Fail banner
	- Temperature chart
	- Key metrics
	- Failure reasons (if any)
-->
<script lang="ts">
	import ThermocoupleChart from './ThermocoupleChart.svelte';

	interface ThermocoupleReading {
		timestamp: number;
		temperature: number;
	}

	interface ThermocoupleStats {
		min: number;
		max: number;
		average: number;
		stdDev: number;
		range: number;
		drift: number;
		readingCount: number;
		outOfRangeCount: number;
		durationMs: number;
	}

	interface ThermocoupleChannel {
		key: string;
		label: string;
		readings: ThermocoupleReading[];
		stats: ThermocoupleStats | null;
	}

	interface Props {
		passed: boolean;
		stats: ThermocoupleStats;
		interpretation: string;
		failureReasons: string[];
		readings?: ThermocoupleReading[];
		/**
		 * One entry per probe. When given, each probe gets its own chart and its
		 * own metrics; the pass/fail banner stays at session level. Omitted for
		 * single-probe files and for sessions recorded before two-channel
		 * parsing, which render the one combined series as before.
		 */
		channels?: ThermocoupleChannel[] | null;
		minTemp?: number;
		maxTemp?: number;
	}

	let {
		passed,
		stats,
		interpretation,
		failureReasons,
		readings,
		channels = null,
		minTemp,
		maxTemp
	}: Props = $props();

	// One colour per probe, matching the server-rendered channel charts.
	const CHANNEL_COLORS = [
		'var(--color-tron-cyan)',
		'var(--color-tron-orange)',
		'var(--color-tron-green)',
		'var(--color-tron-purple)'
	];
	function channelColor(i: number): string {
		return CHANNEL_COLORS[i % CHANNEL_COLORS.length];
	}

	// Show/hide raw data table
	let showRawData = $state(false);

	function formatNumber(value: number, decimals: number = 2): string {
		return value.toFixed(decimals);
	}

	function formatDuration(ms: number): string {
		const seconds = Math.floor(ms / 1000);
		const minutes = Math.floor(seconds / 60);
		const remainingSeconds = seconds % 60;
		if (minutes > 0) {
			return `${minutes}m ${remainingSeconds}s`;
		}
		return `${seconds}s`;
	}

	function formatTime(timestamp: number): string {
		return new Date(timestamp).toLocaleTimeString();
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

	{#snippet metrics(stats: ThermocoupleStats)}
	<!-- Key Metrics -->
	<div class="grid gap-4 md:grid-cols-3">
		<!-- Average Temperature -->
		<div class="tron-card p-4">
			<div class="tron-text-muted text-xs uppercase">Average Temperature</div>
			<div class="tron-heading mt-1 text-2xl font-bold text-[var(--color-tron-cyan)]">
				{formatNumber(stats.average)} <span class="text-sm font-normal">°C</span>
			</div>
		</div>

		<!-- Temperature Range -->
		<div class="tron-card p-4">
			<div class="tron-text-muted text-xs uppercase">Temperature Range</div>
			<div class="tron-heading mt-1 text-2xl font-bold text-[var(--color-tron-purple)]">
				{formatNumber(stats.min)} - {formatNumber(stats.max)}
				<span class="text-sm font-normal">°C</span>
			</div>
		</div>

		<!-- Stability -->
		<div class="tron-card p-4">
			<div class="tron-text-muted text-xs uppercase">Stability (Std Dev)</div>
			<div
				class="mt-1 text-2xl font-bold {stats.stdDev <= 2.0
					? 'text-[var(--color-tron-green)]'
					: 'text-[var(--color-tron-orange)]'}"
			>
				±{formatNumber(stats.stdDev)} <span class="text-sm font-normal">°C</span>
			</div>
		</div>
	</div>

	<!-- Additional Stats -->
	<div class="grid gap-4 md:grid-cols-4">
		<div class="tron-card p-3 text-center">
			<div class="tron-text-muted text-xs">Readings</div>
			<div class="tron-heading mt-1 text-xl font-bold">{stats.readingCount}</div>
		</div>
		<div class="tron-card p-3 text-center">
			<div class="tron-text-muted text-xs">Duration</div>
			<div class="tron-heading mt-1 text-xl font-bold">{formatDuration(stats.durationMs)}</div>
		</div>
		<div class="tron-card p-3 text-center">
			<div class="tron-text-muted text-xs">Drift</div>
			<div
				class="mt-1 text-xl font-bold {stats.drift <= 5.0
					? 'text-[var(--color-tron-green)]'
					: 'text-[var(--color-tron-orange)]'}"
			>
				{formatNumber(stats.drift)}°C
			</div>
		</div>
		<div class="tron-card p-3 text-center">
			<div class="tron-text-muted text-xs">Out of Range</div>
			<div
				class="mt-1 text-xl font-bold {stats.outOfRangeCount === 0
					? 'text-[var(--color-tron-green)]'
					: 'text-[var(--color-tron-red)]'}"
			>
				{stats.outOfRangeCount}
			</div>
		</div>
	</div>
	{/snippet}

	{#if channels && channels.length > 0}
		<!-- One block per probe: its own chart, then its own metrics. -->
		{#each channels as channel, i (channel.key)}
			<div class="space-y-4">
				<div class="flex items-center gap-2">
					<span
						class="inline-block h-3 w-3 rounded-full"
						style="background: {channelColor(i)}"
					></span>
					<h3 class="tron-heading font-semibold">{channel.label}</h3>
				</div>

				{#if channel.readings && channel.readings.length > 0}
					<ThermocoupleChart
						readings={channel.readings}
						{minTemp}
						{maxTemp}
						showBands={true}
						title="{channel.label} — Temperature Over Time"
						lineColor={channelColor(i)}
						seriesLabel={channel.label}
					/>
				{/if}

				{#if channel.stats}
					{@render metrics(channel.stats)}
				{/if}
			</div>
		{/each}
	{:else}
		<!-- Temperature Chart -->
		{#if readings && readings.length > 0}
			<ThermocoupleChart {readings} {minTemp} {maxTemp} showBands={true} />
		{/if}

		{@render metrics(stats)}
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

			{#snippet rawTable(rows: ThermocoupleReading[])}
				<div class="max-h-64 overflow-y-auto border-t border-[var(--color-tron-border)]">
					<table class="w-full text-sm">
						<thead class="sticky top-0 bg-[var(--color-tron-bg-secondary)]">
							<tr class="text-left">
								<th class="tron-text-muted p-2">#</th>
								<th class="tron-text-muted p-2">Time</th>
								<th class="tron-text-muted p-2">Temperature (°C)</th>
								<th class="tron-text-muted p-2">Status</th>
							</tr>
						</thead>
						<tbody>
							{#each [...rows].sort((a, b) => a.timestamp - b.timestamp) as reading, i (i)}
								{@const inRange =
									(minTemp === undefined || reading.temperature >= minTemp) &&
									(maxTemp === undefined || reading.temperature <= maxTemp)}
								<tr class="border-t border-[var(--color-tron-border)]">
									<td class="tron-text-muted p-2">{i + 1}</td>
									<td class="tron-heading p-2">{formatTime(reading.timestamp)}</td>
									<td class="p-2">{formatNumber(reading.temperature)}</td>
									<td class="p-2">
										{#if inRange}
											<span class="text-[var(--color-tron-green)]">OK</span>
										{:else}
											<span class="text-[var(--color-tron-red)]">Out of Range</span>
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/snippet}

			{#if showRawData}
				{#if channels && channels.length > 0}
					<!-- A table per probe. A single merged table would have to show
					     one temperature per row, which is the averaging this change
					     removed. -->
					{#each channels as channel, i (channel.key)}
						<div class="border-t border-[var(--color-tron-border)]">
							<div class="flex items-center gap-2 px-4 pt-3">
								<span
									class="inline-block h-3 w-3 rounded-full"
									style="background: {channelColor(i)}"
								></span>
								<h4 class="tron-heading text-sm font-semibold">{channel.label}</h4>
							</div>
							{@render rawTable(channel.readings)}
						</div>
					{/each}
				{:else}
					{@render rawTable(readings ?? [])}
				{/if}
			{/if}
		</div>
	{/if}
</div>
