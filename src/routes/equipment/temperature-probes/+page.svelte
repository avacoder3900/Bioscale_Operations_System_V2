<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { enhance } from '$app/forms';

	interface Stats24h {
		min: number;
		max: number;
		avg: number;
		count: number;
	}

	interface SensorData {
		sensorId: string;
		sensorName: string;
		model: string;
		temperature: number | null;
		humidity: number | null;
		lastReadingAt: string | null;
		readingCount: number;
		signalLevel: number | null;
		batteryLevel: number | null;
		mappedEquipmentId: string | null;
		mappedEquipmentName: string | null;
		mappedEquipmentType: string | null;
		temperatureMinC: number | null;
		temperatureMaxC: number | null;
		isOffline: boolean;
		stats24h: Stats24h | null;
		sparkline: number[];
	}

	interface HistoryPoint {
		temperature: number;
		humidity: number;
		timestamp: string;
	}

	interface AlertData {
		_id: string;
		sensorId: string;
		sensorName: string;
		alertType: 'high_temp' | 'low_temp' | 'lost_connection';
		threshold: number | null;
		actualValue: number | null;
		equipmentName: string | null;
		timestamp: string;
	}

	interface Props {
		data: {
			sensors: SensorData[];
			equipment: { id: string; name: string; equipmentType: string; mocreoDeviceId: string | null }[];
			totalReadings: number;
			isAdmin: boolean;
			selectedSensorId: string | null;
			selectedSensor: SensorData | null;
			historyData: HistoryPoint[];
			range: string;
			alerts: AlertData[];
		};
		form: { success?: boolean; error?: string; pinged?: boolean; dismissed?: boolean } | null;
	}

	let { data, form }: Props = $props();
	let mappingFor = $state<string | null>(null);
	let selectedEquipmentId = $state('');
	let pinnedTooltip = $state<{ x: number; y: number; temp: number; humidity: number; time: string; idx: number } | null>(null);
	let hoverTooltip = $state<{ x: number; y: number; temp: number; humidity: number; time: string; idx: number } | null>(null);
	let pinging = $state<string | null>(null);

	// --- Helpers ---

	function sensorStatus(s: SensorData): 'normal' | 'warning' | 'alert' | 'offline' {
		if (s.isOffline) return 'offline';
		if (s.temperature == null) return 'offline';
		const min = s.temperatureMinC;
		const max = s.temperatureMaxC;
		if (min != null && s.temperature < min) return 'alert';
		if (max != null && s.temperature > max) return 'alert';
		if (min != null && s.temperature < min + 2) return 'warning';
		if (max != null && s.temperature > max - 2) return 'warning';
		return 'normal';
	}

	function cardClasses(s: SensorData): string {
		const status = sensorStatus(s);
		const base = 'rounded-xl border p-5 cursor-pointer transition-all duration-200 hover:scale-[1.02] hover:shadow-lg';
		switch (status) {
			case 'normal':
				return `${base} border-emerald-500/40 bg-emerald-950/30`;
			case 'warning':
				return `${base} border-amber-500/40 bg-amber-950/30`;
			case 'alert':
				return `${base} border-red-500/40 bg-red-950/30 animate-pulse`;
			case 'offline':
				return `${base} border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]/50 opacity-60`;
		}
	}

	function formatTemp(temp: number | null): string {
		if (temp == null) return '--.-';
		return temp.toFixed(1);
	}

	function formatDate(dateStr: string | null): string {
		if (!dateStr) return 'No data';
		const d = new Date(dateStr);
		return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
			+ ', ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
	}

	function formatTime(dateStr: string): string {
		const d = new Date(dateStr);
		return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
	}

	function signalBars(level: number | null): number {
		if (level == null) return 0;
		if (level >= 75) return 4;
		if (level >= 50) return 3;
		if (level >= 25) return 2;
		return 1;
	}

	function batteryPct(level: number | null): number {
		return level ?? 0;
	}

	function batteryIcon(level: number | null): string {
		if (level == null) return 'N/A';
		return level + '%';
	}

	function alertLabel(type: string): string {
		switch (type) {
			case 'high_temp': return 'HIGH TEMP';
			case 'low_temp': return 'LOW TEMP';
			case 'lost_connection': return 'LOST CONNECTION';
			default: return type;
		}
	}

	// --- Sparkline SVG ---
	function sparklinePath(pts: number[]): string {
		if (pts.length < 2) return '';
		const min = Math.min(...pts);
		const max = Math.max(...pts);
		const range = max - min || 1;
		const w = 160;
		const h = 40;
		const step = w / (pts.length - 1);
		let d = `M 0,${h - ((pts[0] - min) / range) * h}`;
		for (let i = 1; i < pts.length; i++) {
			const x = i * step;
			const y = h - ((pts[i] - min) / range) * h;
			const px = (i - 1) * step;
			const py = h - ((pts[i - 1] - min) / range) * h;
			const cpx = (px + x) / 2;
			d += ` C ${cpx},${py} ${cpx},${y} ${x},${y}`;
		}
		return d;
	}

	// --- SVG Chart ---

	const CHART_W = 800;
	const CHART_H = 300;
	const PAD = { top: 20, right: 20, bottom: 40, left: 50 };
	const plotW = CHART_W - PAD.left - PAD.right;
	const plotH = CHART_H - PAD.top - PAD.bottom;

	function buildChart(points: HistoryPoint[]) {
		if (points.length === 0) return null;

		const temps = points.map(p => p.temperature);
		const times = points.map(p => new Date(p.timestamp).getTime());

		let minT = Math.min(...temps);
		let maxT = Math.max(...temps);
		if (maxT - minT < 1) { minT -= 0.5; maxT += 0.5; }
		const padT = (maxT - minT) * 0.1;
		minT -= padT;
		maxT += padT;

		const minTime = Math.min(...times);
		const maxTime = Math.max(...times);
		const timeSpan = maxTime - minTime || 1;

		function scaleX(t: number) { return PAD.left + ((t - minTime) / timeSpan) * plotW; }
		function scaleY(v: number) { return PAD.top + (1 - (v - minT) / (maxT - minT)) * plotH; }

		const chartPoints = points.map(p => ({
			x: scaleX(new Date(p.timestamp).getTime()),
			y: scaleY(p.temperature),
			temp: p.temperature,
			humidity: p.humidity,
			time: p.timestamp
		}));

		// Smooth path using cubic bezier
		let linePath = `M ${chartPoints[0].x},${chartPoints[0].y}`;
		for (let i = 1; i < chartPoints.length; i++) {
			const prev = chartPoints[i - 1];
			const curr = chartPoints[i];
			const cpx = (prev.x + curr.x) / 2;
			linePath += ` C ${cpx},${prev.y} ${cpx},${curr.y} ${curr.x},${curr.y}`;
		}

		// Fill area path
		const last = chartPoints[chartPoints.length - 1];
		const first = chartPoints[0];
		const areaPath = linePath
			+ ` L ${last.x},${PAD.top + plotH}`
			+ ` L ${first.x},${PAD.top + plotH} Z`;

		// Min/max points
		let minIdx = 0, maxIdx = 0;
		for (let i = 1; i < chartPoints.length; i++) {
			if (chartPoints[i].temp < chartPoints[minIdx].temp) minIdx = i;
			if (chartPoints[i].temp > chartPoints[maxIdx].temp) maxIdx = i;
		}

		// X axis labels (6 evenly spaced)
		const xLabels = [];
		const labelCount = Math.min(6, points.length);
		for (let i = 0; i < labelCount; i++) {
			const idx = Math.floor(i * (points.length - 1) / Math.max(labelCount - 1, 1));
			const d = new Date(points[idx].timestamp);
			xLabels.push({
				x: chartPoints[idx].x,
				label: d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
			});
		}

		// Y axis labels (5 evenly spaced)
		const yLabels = [];
		for (let i = 0; i <= 4; i++) {
			const v = minT + (i / 4) * (maxT - minT);
			yLabels.push({ y: scaleY(v), label: v.toFixed(1) + '°' });
		}

		return { linePath, areaPath, chartPoints, minIdx, maxIdx, xLabels, yLabels };
	}

	const chart = $derived(buildChart(data.historyData));

	function activeTooltip() {
		return pinnedTooltip ?? hoverTooltip;
	}

	function handleDotHover(pt: { x: number; y: number; temp: number; humidity: number; time: string }, idx: number) {
		if (pinnedTooltip?.idx === idx) return;
		hoverTooltip = { ...pt, idx };
	}

	function handleDotLeave() {
		hoverTooltip = null;
	}

	function handleDotClick(pt: { x: number; y: number; temp: number; humidity: number; time: string }, idx: number) {
		if (pinnedTooltip?.idx === idx) {
			pinnedTooltip = null;
		} else {
			pinnedTooltip = { ...pt, idx };
		}
	}

	// --- Navigation ---

	function selectSensor(sensorId: string) {
		goto(`?sensor=${sensorId}`);
	}

	function goBack() {
		goto('/equipment/temperature-probes');
	}

	function setRange(r: string) {
		goto(`?sensor=${data.selectedSensorId}&range=${r}`);
	}
</script>

<!-- ==================== ALERT BANNER ==================== -->
{#if data.alerts.length > 0}
	<div class="mb-6 space-y-2">
		{#each data.alerts as alert (alert._id)}
			<div class="rounded-lg border {
				alert.alertType === 'lost_connection'
					? 'border-amber-500/50 bg-amber-950/30'
					: 'border-red-500/50 bg-red-950/30'
			} px-4 py-3 flex items-center justify-between">
				<div class="flex items-center gap-3">
					<span class="text-xs font-bold px-2 py-0.5 rounded {
						alert.alertType === 'lost_connection'
							? 'bg-amber-500/20 text-amber-300'
							: 'bg-red-500/20 text-red-300'
					}">
						{alertLabel(alert.alertType)}
					</span>
					<span class="text-sm text-[var(--color-tron-text)]">
						{alert.sensorName || alert.sensorId}
						{#if alert.equipmentName}
							<span class="text-[var(--color-tron-text-secondary)]">({alert.equipmentName})</span>
						{/if}
					</span>
					{#if alert.alertType === 'lost_connection'}
						<span class="text-sm font-mono text-amber-300">Sensor not responding</span>
					{:else if alert.actualValue != null}
						<span class="text-sm font-mono text-red-300">{alert.actualValue.toFixed(1)}°C</span>
						{#if alert.threshold != null}
							<span class="text-xs text-[var(--color-tron-text-secondary)]">
								(threshold: {alert.threshold.toFixed(1)}°C)
							</span>
						{/if}
					{/if}
					<span class="text-xs text-[var(--color-tron-text-secondary)]">{formatDate(alert.timestamp)}</span>
				</div>
				<form method="POST" action="?/acknowledgeAlert" use:enhance={() => {
					return async ({ update }) => { await update(); };
				}}>
					<input type="hidden" name="alertId" value={alert._id} />
					<button type="submit"
						class="text-xs px-3 py-1 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)] hover:border-[var(--color-tron-cyan)] transition-colors">
						Dismiss
					</button>
				</form>
			</div>
		{/each}
	</div>
{/if}

{#if data.selectedSensor}
	<!-- ==================== DETAIL VIEW ==================== -->
	{@const s = data.selectedSensor}
	{@const status = sensorStatus(s)}
	{@const tt = activeTooltip()}

	<div class="space-y-6 max-w-3xl mx-auto">
		<!-- Back button -->
		<button onclick={() => goBack()}
			class="flex items-center gap-2 text-sm text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)] transition-colors">
			<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
			</svg>
			Back to all probes
		</button>

		<!-- Sensor name + offline badge -->
		<div class="text-center">
			<h1 class="text-xl font-semibold text-[var(--color-tron-text)] inline-flex items-center gap-2">
				{s.sensorName}
				{#if s.isOffline}
					<span class="text-xs font-bold px-2 py-0.5 rounded bg-red-500/20 text-red-400 border border-red-500/30">OFFLINE</span>
				{/if}
			</h1>
			{#if s.mappedEquipmentName}
				<p class="text-sm text-[var(--color-tron-cyan)] mt-1">{s.mappedEquipmentName}</p>
			{/if}
		</div>

		<!-- HUGE temperature display -->
		<div class="text-center py-8">
			<div class="inline-flex items-baseline gap-2">
				<span class="text-[72px] font-bold leading-none {
					status === 'alert' ? 'text-red-400' :
					status === 'warning' ? 'text-amber-400' :
					status === 'normal' ? 'text-emerald-400' :
					'text-[var(--color-tron-text-secondary)]'
				}">
					{formatTemp(s.temperature)}
				</span>
				<span class="text-2xl text-[var(--color-tron-text-secondary)]">°C</span>
			</div>
			<p class="text-sm text-[var(--color-tron-text-secondary)] mt-2">Temperature</p>
			{#if s.humidity != null}
				<p class="text-lg text-[var(--color-tron-text-secondary)] mt-1">{s.humidity.toFixed(1)}% RH</p>
			{/if}
		</div>

		<!-- Ping button -->
		<div class="flex justify-center">
			<form method="POST" action="?/pingSensor&sensor={s.sensorId}" use:enhance={() => {
				pinging = s.sensorId;
				return async ({ update }) => { pinging = null; await update(); };
			}}>
				<input type="hidden" name="sensorId" value={s.sensorId} />
				<button type="submit" disabled={pinging === s.sensorId}
					class="rounded-lg border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-5 py-2 text-sm font-medium text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/20 transition-colors disabled:opacity-50">
					{#if pinging === s.sensorId}
						Pinging...
					{:else}
						Ping Sensor
					{/if}
				</button>
			</form>
		</div>

		<!-- Battery & Signal indicators -->
		<div class="flex justify-center gap-12">
			<!-- Battery -->
			<div class="text-center">
				<p class="text-xs text-[var(--color-tron-text-secondary)] mb-2">Battery Level</p>
				<div class="w-48 h-3 rounded-full bg-[var(--color-tron-surface)] border border-[var(--color-tron-border)] overflow-hidden">
					<div class="h-full rounded-full transition-all {
						batteryPct(s.batteryLevel) > 50 ? 'bg-emerald-500' :
						batteryPct(s.batteryLevel) > 20 ? 'bg-amber-500' : 'bg-red-500'
					}" style="width: {batteryPct(s.batteryLevel)}%"></div>
				</div>
				<p class="text-xs text-[var(--color-tron-text-secondary)] mt-1">
					{batteryIcon(s.batteryLevel)}
				</p>
			</div>

			<!-- Signal -->
			<div class="text-center">
				<p class="text-xs text-[var(--color-tron-text-secondary)] mb-2">Signal Level</p>
				<div class="flex items-end justify-center gap-1 h-5">
					{#each [1, 2, 3, 4] as bar}
						<div class="w-2 rounded-sm transition-all {
							bar <= signalBars(s.signalLevel)
								? 'bg-[var(--color-tron-cyan)]'
								: 'bg-[var(--color-tron-border)]'
						}" style="height: {bar * 25}%"></div>
					{/each}
				</div>
				<p class="text-xs text-[var(--color-tron-text-secondary)] mt-1">
					{s.signalLevel != null ? s.signalLevel + '%' : 'N/A'}
				</p>
			</div>
		</div>

		<!-- Range toggle tabs -->
		<div class="flex justify-center gap-1 mt-4">
			{#each ['day', 'month', 'year'] as r}
				<button onclick={() => setRange(r)}
					class="px-4 py-2 rounded-lg text-sm font-medium transition-colors {
						data.range === r
							? 'bg-[var(--color-tron-cyan)] text-[var(--color-tron-bg)]'
							: 'bg-[var(--color-tron-surface)] text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)] border border-[var(--color-tron-border)]'
					}">
					{r === 'day' ? '24 Hours' : r === 'month' ? '30 Days' : '1 Year'}
				</button>
			{/each}
		</div>

		<!-- Temperature Chart (Interactive) -->
		<div class="rounded-xl border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 relative">
			<h3 class="text-sm font-medium text-[var(--color-tron-text-secondary)] mb-3">Temperature History</h3>
			{#if chart}
				<svg viewBox="0 0 {CHART_W} {CHART_H}" class="w-full" preserveAspectRatio="xMidYMid meet">
					<defs>
						<linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
							<stop offset="0%" stop-color="rgb(20, 184, 166)" stop-opacity="0.3"/>
							<stop offset="100%" stop-color="rgb(20, 184, 166)" stop-opacity="0.02"/>
						</linearGradient>
					</defs>

					<!-- Grid lines -->
					{#each chart.yLabels as yl}
						<line x1={PAD.left} y1={yl.y} x2={CHART_W - PAD.right} y2={yl.y}
							stroke="var(--color-tron-border)" stroke-width="0.5" stroke-dasharray="4,4"/>
						<text x={PAD.left - 8} y={yl.y + 4} text-anchor="end"
							fill="var(--color-tron-text-secondary, #888)" font-size="11">{yl.label}</text>
					{/each}

					<!-- X axis labels -->
					{#each chart.xLabels as xl}
						<text x={xl.x} y={CHART_H - 8} text-anchor="middle"
							fill="var(--color-tron-text-secondary, #888)" font-size="11">{xl.label}</text>
					{/each}

					<!-- Filled area -->
					<path d={chart.areaPath} fill="url(#areaGrad)"/>

					<!-- Line -->
					<path d={chart.linePath} fill="none" stroke="rgb(20, 184, 166)" stroke-width="2.5"
						stroke-linecap="round" stroke-linejoin="round"/>

					<!-- Data point dots (interactive) -->
					{#each chart.chartPoints as pt, i}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<circle cx={pt.x} cy={pt.y} r={tt?.idx === i ? 6 : 3}
							fill={tt?.idx === i ? 'var(--color-tron-cyan, rgb(0, 212, 255))' : 'rgb(20, 184, 166)'}
							stroke="var(--color-tron-surface, #1a1a2e)" stroke-width="1.5"
							class="cursor-pointer transition-all"
							onmouseenter={() => handleDotHover(pt, i)}
							onmouseleave={() => handleDotLeave()}
							onclick={() => handleDotClick(pt, i)}
						/>
					{/each}

					<!-- Tooltip -->
					{#if tt}
						{@const tx = Math.min(Math.max(tt.x, PAD.left + 60), CHART_W - PAD.right - 60)}
						{@const ty = tt.y - 55}
						<rect x={tx - 55} y={ty} width="110" height="48" rx="6"
							fill="var(--color-tron-bg-card, #16161f)" stroke="var(--color-tron-cyan, #00d4ff)" stroke-width="1" opacity="0.95"/>
						<text x={tx} y={ty + 16} text-anchor="middle" fill="var(--color-tron-text, #e0e0e0)" font-size="12" font-weight="bold">
							{tt.temp.toFixed(1)}°C / {tt.humidity?.toFixed(1) ?? '--'}% RH
						</text>
						<text x={tx} y={ty + 34} text-anchor="middle" fill="var(--color-tron-text-secondary, #a0a0a0)" font-size="10">
							{formatTime(tt.time)}
						</text>
						{#if pinnedTooltip?.idx === tt.idx}
							<circle cx={tx + 48} cy={ty + 6} r="3" fill="var(--color-tron-cyan, #00d4ff)"/>
						{/if}
					{/if}

					<!-- Min/Max labels -->
					{#if chart.chartPoints.length > 1}
						{@const minPt = chart.chartPoints[chart.minIdx]}
						{@const maxPt = chart.chartPoints[chart.maxIdx]}
						<circle cx={minPt.x} cy={minPt.y} r="5" fill="rgb(59, 130, 246)" stroke="white" stroke-width="1.5"/>
						<text x={minPt.x} y={minPt.y + 18} text-anchor="middle" fill="rgb(59, 130, 246)" font-size="11" font-weight="bold">
							Min {minPt.temp.toFixed(1)}°
						</text>
						<circle cx={maxPt.x} cy={maxPt.y} r="5" fill="rgb(239, 68, 68)" stroke="white" stroke-width="1.5"/>
						<text x={maxPt.x} y={maxPt.y - 10} text-anchor="middle" fill="rgb(239, 68, 68)" font-size="11" font-weight="bold">
							Max {maxPt.temp.toFixed(1)}°
						</text>
					{/if}
				</svg>
			{:else}
				<div class="flex items-center justify-center h-48 text-[var(--color-tron-text-secondary)]">
					<p>No readings in this time range</p>
				</div>
			{/if}
		</div>

		<!-- Threshold config (admin only) -->
		{#if data.isAdmin && s.mappedEquipmentId}
			<div class="rounded-xl border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
				<h3 class="text-sm font-medium text-[var(--color-tron-text-secondary)] mb-3">Alert Thresholds</h3>
				<form method="POST" action="?/setThresholds&sensor={s.sensorId}" use:enhance={() => {
					return async ({ update }) => { await update(); };
				}} class="flex items-end gap-3">
					<input type="hidden" name="equipmentId" value={s.mappedEquipmentId} />
					<div class="flex-1">
						<label class="text-xs text-[var(--color-tron-text-secondary)]">Min °C</label>
						<input type="number" step="0.1" name="temperatureMinC" value={s.temperatureMinC ?? ''}
							class="w-full mt-1 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
							placeholder="e.g. 2.0" />
					</div>
					<div class="flex-1">
						<label class="text-xs text-[var(--color-tron-text-secondary)]">Max °C</label>
						<input type="number" step="0.1" name="temperatureMaxC" value={s.temperatureMaxC ?? ''}
							class="w-full mt-1 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
							placeholder="e.g. 8.0" />
					</div>
					<button type="submit"
						class="rounded-lg bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-semibold text-[var(--color-tron-bg)]">
						Save
					</button>
				</form>
			</div>
		{/if}

		<!-- Equipment mapping section -->
		{#if data.isAdmin}
			<div class="rounded-xl border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
				<h3 class="text-sm font-medium text-[var(--color-tron-text-secondary)] mb-3">Equipment Mapping</h3>
				{#if s.mappedEquipmentName}
					<p class="text-sm text-[var(--color-tron-text)]">
						Linked to <span class="text-[var(--color-tron-cyan)] font-medium">{s.mappedEquipmentName}</span>
						<span class="text-[var(--color-tron-text-secondary)] capitalize">({s.mappedEquipmentType})</span>
					</p>
				{:else}
					<p class="text-sm text-amber-400/70 mb-3">Not mapped to any equipment</p>
				{/if}
				<form method="POST" action="?/mapSensor" use:enhance={() => { return async ({ update }) => { await update(); }; }}
					class="flex items-center gap-2 mt-3">
					<input type="hidden" name="mocreoDeviceId" value={s.sensorId} />
					<select name="equipmentId" bind:value={selectedEquipmentId}
						class="flex-1 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)]">
						<option value="">-- Select equipment --</option>
						{#each data.equipment.filter(e => ['fridge', 'oven'].includes(e.equipmentType)) as eq (eq.id)}
							<option value={eq.id}>{eq.name} ({eq.equipmentType})</option>
						{/each}
					</select>
					<button type="submit"
						class="rounded-lg bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-semibold text-[var(--color-tron-bg)]"
						disabled={!selectedEquipmentId}>
						Map
					</button>
				</form>
			</div>
		{/if}

		<!-- Metadata -->
		<div class="text-center text-xs text-[var(--color-tron-text-secondary)] space-y-1">
			<p>Sensor ID: <span class="font-mono">{s.sensorId}</span> &middot; Model: {s.model}</p>
			<p>Last updated: {formatDate(s.lastReadingAt)}</p>
			<p>{s.readingCount} total readings stored</p>
		</div>
	</div>

{:else}
	<!-- ==================== GRID VIEW ==================== -->
	<div class="space-y-6">
		<!-- Header -->
		<div class="flex items-center gap-4">
			<a href="/equipment/activity"
				class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)] transition-colors">
				<svg class="w-4 h-4 inline-block mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
				</svg>
				Equipment
			</a>
			<div>
				<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">Temperature Probes</h1>
				<p class="text-sm text-[var(--color-tron-text-secondary)]">
					{data.sensors.length} sensors &middot; {data.totalReadings} readings stored
				</p>
			</div>
		</div>

		{#if form?.success && form?.pinged}
			<div class="rounded-lg border border-emerald-500/30 bg-emerald-900/20 px-4 py-3 text-sm text-emerald-300">Sensor pinged — latest reading stored.</div>
		{/if}
		{#if form?.success && !form?.pinged && !form?.dismissed}
			<div class="rounded-lg border border-green-500/30 bg-green-900/20 px-4 py-3 text-sm text-green-300">Sensor mapping updated.</div>
		{/if}
		{#if form?.error}
			<div class="rounded-lg border border-red-500/30 bg-red-900/20 px-4 py-3 text-sm text-red-300">{form.error}</div>
		{/if}

		{#if data.sensors.length === 0}
			<div class="rounded-xl border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-12 text-center">
				<p class="text-lg text-[var(--color-tron-text-secondary)]">No temperature sensors found</p>
				<p class="text-sm text-[var(--color-tron-text-secondary)] mt-1">Sync data from Mocreo to see sensors here.</p>
			</div>
		{:else}
			<!-- Sensor card grid -->
			<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
				{#each data.sensors as sensor (sensor.sensorId)}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div class={cardClasses(sensor)} onclick={() => selectSensor(sensor.sensorId)}>
						<!-- Top row: name + signal/battery + offline badge -->
						<div class="flex items-start justify-between">
							<div class="flex-1 min-w-0">
								<h3 class="font-bold text-[var(--color-tron-text)] truncate inline-flex items-center gap-2">
									{sensor.sensorName}
									{#if sensor.isOffline}
										<span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 border border-red-500/30">OFFLINE</span>
									{/if}
								</h3>
								{#if sensor.mappedEquipmentName}
									<p class="text-xs text-[var(--color-tron-cyan)] truncate">{sensor.mappedEquipmentName}</p>
								{/if}
							</div>
							<div class="flex items-center gap-3 ml-2 shrink-0">
								<!-- Signal bars -->
								<div class="flex items-end gap-0.5 h-4" title="Signal: {sensor.signalLevel ?? 'N/A'}%">
									{#each [1, 2, 3, 4] as bar}
										<div class="w-1 rounded-sm {
											bar <= signalBars(sensor.signalLevel)
												? 'bg-[var(--color-tron-cyan)]'
												: 'bg-[var(--color-tron-border)]'
										}" style="height: {bar * 25}%"></div>
									{/each}
								</div>
								<!-- Battery with % -->
								<div class="flex items-center gap-1" title="Battery: {batteryIcon(sensor.batteryLevel)}">
									<div class="w-6 h-3 rounded-sm border border-current text-[var(--color-tron-text-secondary)] relative overflow-hidden">
										<div class="absolute inset-0.5 rounded-sm {
											batteryPct(sensor.batteryLevel) > 50 ? 'bg-emerald-500' :
											batteryPct(sensor.batteryLevel) > 20 ? 'bg-amber-500' : 'bg-red-500'
										}" style="width: {batteryPct(sensor.batteryLevel)}%"></div>
									</div>
									<span class="text-[10px] text-[var(--color-tron-text-secondary)]">{batteryIcon(sensor.batteryLevel)}</span>
								</div>
							</div>
						</div>

						<!-- Big temperature + 24h summary -->
						<div class="mt-4 mb-3 flex items-end justify-between">
							<div>
								<span class="text-4xl font-bold {
									sensorStatus(sensor) === 'alert' ? 'text-red-400' :
									sensorStatus(sensor) === 'warning' ? 'text-amber-400' :
									sensorStatus(sensor) === 'normal' ? 'text-emerald-400' :
									'text-[var(--color-tron-text-secondary)]'
								}">
									{formatTemp(sensor.temperature)} <span class="text-lg">°C</span>
								</span>
								{#if sensor.humidity != null}
									<span class="text-sm text-[var(--color-tron-text-secondary)] ml-3">{sensor.humidity.toFixed(1)}% RH</span>
								{/if}
							</div>
						</div>

						<!-- 24h summary stats -->
						{#if sensor.stats24h}
							<div class="flex gap-3 text-[10px] text-[var(--color-tron-text-secondary)] mb-2">
								<span>24h: <span class="text-blue-400">{sensor.stats24h.min}°</span> min</span>
								<span><span class="text-red-400">{sensor.stats24h.max}°</span> max</span>
								<span><span class="text-[var(--color-tron-text)]">{sensor.stats24h.avg}°</span> avg</span>
							</div>
						{/if}

						<!-- Full-width sparkline chart with axes -->
						{#if sensor.sparkline.length >= 2}
							{@const pts = sensor.sparkline}
							{@const minVal = Math.min(...pts)}
							{@const maxVal = Math.max(...pts)}
							{@const range = maxVal - minVal || 1}
							{@const chartW = 100}
							{@const chartH = 60}
							{@const padL = 8}
							{@const padR = 2}
							{@const padT = 4}
							{@const padB = 10}
							{@const plotW = chartW - padL - padR}
							{@const plotH = chartH - padT - padB}
							<div class="w-full mt-2 mb-1">
								<svg viewBox="0 0 {chartW} {chartH}" class="w-full" preserveAspectRatio="xMidYMid meet" style="min-height: 80px;">
									<!-- Y axis labels -->
									<text x="{padL - 1}" y="{padT + 3}" text-anchor="end" fill="rgba(255,255,255,0.4)" font-size="3">{maxVal.toFixed(0)}°</text>
									<text x="{padL - 1}" y="{padT + plotH}" text-anchor="end" fill="rgba(255,255,255,0.4)" font-size="3">{minVal.toFixed(0)}°</text>
									<!-- X axis labels -->
									<text x="{padL}" y="{chartH - 1}" text-anchor="start" fill="rgba(255,255,255,0.3)" font-size="2.5">24h ago</text>
									<text x="{chartW - padR}" y="{chartH - 1}" text-anchor="end" fill="rgba(255,255,255,0.3)" font-size="2.5">now</text>
									<!-- Grid lines -->
									<line x1="{padL}" y1="{padT}" x2="{padL + plotW}" y2="{padT}" stroke="rgba(255,255,255,0.08)" stroke-width="0.3"/>
									<line x1="{padL}" y1="{padT + plotH}" x2="{padL + plotW}" y2="{padT + plotH}" stroke="rgba(255,255,255,0.08)" stroke-width="0.3"/>
									<line x1="{padL}" y1="{padT + plotH/2}" x2="{padL + plotW}" y2="{padT + plotH/2}" stroke="rgba(255,255,255,0.05)" stroke-width="0.3" stroke-dasharray="1,1"/>
									<!-- Gradient fill -->
									<defs>
										<linearGradient id="sparkFill-{sensor.sensorId}" x1="0" y1="0" x2="0" y2="1">
											<stop offset="0%" stop-color="rgb(20, 184, 166)" stop-opacity="0.3"/>
											<stop offset="100%" stop-color="rgb(20, 184, 166)" stop-opacity="0.02"/>
										</linearGradient>
									</defs>
									<!-- Fill area -->
									{@const step = plotW / (pts.length - 1)}
									{@const fillPath = pts.map((v, i) => {
										const x = padL + i * step;
										const y = padT + plotH - ((v - minVal) / range) * plotH;
										return `${i === 0 ? 'M' : 'L'} ${x},${y}`;
									}).join(' ') + ` L ${padL + (pts.length-1)*step},${padT+plotH} L ${padL},${padT+plotH} Z`}
									<path d={fillPath} fill="url(#sparkFill-{sensor.sensorId})"/>
									<!-- Line -->
									{@const linePath = pts.map((v, i) => {
										const x = padL + i * step;
										const y = padT + plotH - ((v - minVal) / range) * plotH;
										return `${i === 0 ? 'M' : 'L'} ${x},${y}`;
									}).join(' ')}
									<path d={linePath} fill="none" stroke="rgb(20, 184, 166)" stroke-width="0.8" stroke-linecap="round" stroke-linejoin="round"/>
									<!-- Data points -->
									{#each pts as v, i}
										{@const x = padL + i * step}
										{@const y = padT + plotH - ((v - minVal) / range) * plotH}
										<circle cx={x} cy={y} r="0.8" fill="rgb(20, 184, 166)" opacity="0.6"/>
									{/each}
								</svg>
							</div>
						{/if}

						<!-- Last updated + ping -->
						<div class="flex items-center justify-between">
							<p class="text-xs text-[var(--color-tron-text-secondary)]">
								Last updated {formatDate(sensor.lastReadingAt)}
							</p>
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<form method="POST" action="?/pingSensor" use:enhance={() => {
								pinging = sensor.sensorId;
								return async ({ update }) => { pinging = null; await update(); };
							}} onclick={(e) => e.stopPropagation()}>
								<input type="hidden" name="sensorId" value={sensor.sensorId} />
								<button type="submit" disabled={pinging === sensor.sensorId}
									class="text-[10px] px-2 py-1 rounded border border-[var(--color-tron-cyan)]/30 text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10 transition-colors disabled:opacity-50">
									{#if pinging === sensor.sensorId}
										...
									{:else}
										Ping
									{/if}
								</button>
							</form>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/if}
