<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';

	let { data, form } = $props();

	// =========================================================================
	// Tabs
	// =========================================================================
	const TABS = [
		{ id: 'overview', label: 'Overview' },
		{ id: 'cycle', label: 'Cycle Time' },
		{ id: 'failures', label: 'Yield & Failures' },
		{ id: 'material', label: 'Material Flow' },
		{ id: 'compare', label: 'Compare' },
		{ id: 'spc', label: 'SPC Alerts' },
		{ id: 'fmea', label: 'FMEA' },
		{ id: 'manual', label: 'Manual Input' },
		{ id: 'runs', label: 'All Runs' },
		{ id: 'export', label: 'Reports & Export' },
		{ id: 'doe', label: 'DOE Planner' }
	];

	let activeTab = $state<string>(new URL($page.url).searchParams.get('tab') ?? 'overview');

	function setTab(t: string) {
		activeTab = t;
		const u = new URL(window.location.href);
		u.searchParams.set('tab', t);
		history.replaceState({}, '', u.toString());
	}

	// =========================================================================
	// Filters
	// =========================================================================
	function toInputDate(iso: string | null): string {
		if (!iso) return '';
		return new Date(iso).toISOString().slice(0, 10);
	}

	let fromDate = $state<string>(toInputDate(data.filters.from));
	let toDate = $state<string>(toInputDate(data.filters.to));
	let selectedProcesses = $state<string[]>(data.filters.processTypes ?? []);
	let selectedOperators = $state<string[]>(data.filters.operatorIds ?? []);
	let selectedRobots = $state<string[]>(data.filters.robotIds ?? []);
	let selectedShifts = $state<string[]>((data.filters.shifts as string[]) ?? []);
	let inputLotBarcodes = $state<string>((data.filters.inputLotBarcodes ?? []).join(','));

	function applyFilters() {
		const u = new URL(window.location.href);
		u.searchParams.set('tab', activeTab);
		if (fromDate) u.searchParams.set('from', fromDate); else u.searchParams.delete('from');
		if (toDate) u.searchParams.set('to', toDate); else u.searchParams.delete('to');
		selectedProcesses.length ? u.searchParams.set('processes', selectedProcesses.join(',')) : u.searchParams.delete('processes');
		selectedOperators.length ? u.searchParams.set('operators', selectedOperators.join(',')) : u.searchParams.delete('operators');
		selectedRobots.length ? u.searchParams.set('robots', selectedRobots.join(',')) : u.searchParams.delete('robots');
		selectedShifts.length ? u.searchParams.set('shifts', selectedShifts.join(',')) : u.searchParams.delete('shifts');
		const lots = inputLotBarcodes.split(',').map(s => s.trim()).filter(Boolean);
		lots.length ? u.searchParams.set('lots', lots.join(',')) : u.searchParams.delete('lots');
		goto(u.pathname + u.search, { invalidateAll: true });
	}

	function setDateRange(days: number) {
		const now = new Date();
		const then = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		fromDate = then.toISOString().slice(0, 10);
		toDate = now.toISOString().slice(0, 10);
		applyFilters();
	}

	function resetFilters() {
		fromDate = '';
		toDate = '';
		selectedProcesses = [];
		selectedOperators = [];
		selectedRobots = [];
		selectedShifts = [];
		inputLotBarcodes = '';
		applyFilters();
	}

	// =========================================================================
	// Formatters
	// =========================================================================
	function fmtPct(v: number | null | undefined, digits = 1): string {
		if (v == null || !Number.isFinite(v)) return '—';
		return (v * 100).toFixed(digits) + '%';
	}
	function fmtNum(v: number | null | undefined, digits = 2): string {
		if (v == null || !Number.isFinite(v)) return '—';
		return Number(v).toFixed(digits);
	}
	function fmtInt(v: number | null | undefined): string {
		if (v == null || !Number.isFinite(v)) return '—';
		return Math.round(v).toLocaleString();
	}
	function fmtDate(iso: string | null | undefined): string {
		if (!iso) return '—';
		return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
	}

	// =========================================================================
	// CSV export helpers (client-side)
	// =========================================================================
	function toCsv(rows: Record<string, any>[]): string {
		if (rows.length === 0) return '';
		const keys = Array.from(new Set(rows.flatMap(r => Object.keys(r))));
		const esc = (v: any): string => {
			if (v == null) return '';
			const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
			return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
		};
		return [keys.join(','), ...rows.map(r => keys.map(k => esc(r[k])).join(','))].join('\n');
	}
	function downloadCsv(name: string, rows: Record<string, any>[]) {
		const csv = toCsv(rows);
		const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
		a.click();
		URL.revokeObjectURL(url);
	}

	// =========================================================================
	// Manual input
	// =========================================================================
	let manualEventType = $state('observation');
	let manualProcessType = $state('general');
	let manualOccurredAt = $state(new Date().toISOString().slice(0, 16));
	let manualNotes = $state('');
	let manualNumeric = $state<string>('');
	let manualNumericUnit = $state('');
	let manualRejectionCode = $state('');
	let manualSeverity = $state<string>('');
	let manualLinkedRunId = $state('');
	let manualLinkedLotId = $state('');

	// =========================================================================
	// FMEA editor
	// =========================================================================
	let fmeaEditingId = $state<string | null>(null);
	let fmeaDraft = $state({
		processType: 'wax',
		processStep: '',
		failureMode: '',
		failureEffect: '',
		cause: '',
		currentControls: '',
		severity: 5,
		occurrence: 5,
		detection: 5,
		classification: 'quality',
		status: 'active'
	});
	const fmeaRpn = $derived(fmeaDraft.severity * fmeaDraft.occurrence * fmeaDraft.detection);

	function editFmea(row: any) {
		fmeaEditingId = row.id;
		fmeaDraft = {
			processType: row.processType, processStep: row.processStep, failureMode: row.failureMode,
			failureEffect: row.effect, cause: row.cause, currentControls: row.currentControls,
			severity: row.severity, occurrence: row.occurrence, detection: row.detection,
			classification: row.classification ?? 'quality', status: row.status
		};
	}
	function clearFmeaDraft() {
		fmeaEditingId = null;
		fmeaDraft = { processType: 'wax', processStep: '', failureMode: '', failureEffect: '', cause: '', currentControls: '', severity: 5, occurrence: 5, detection: 5, classification: 'quality', status: 'active' };
	}

	// =========================================================================
	// Spec Limit editor
	// =========================================================================
	let specEditingId = $state<string | null>(null);
	let specDraft = $state({
		processType: 'wax', metric: 'cycleTime', metricLabel: 'Cycle Time', unit: 'min',
		LSL: '', USL: '', target: '', cpkMin: 1.33, rationale: ''
	});
	function editSpec(s: any) {
		specEditingId = s.id;
		specDraft = {
			processType: s.processType, metric: s.metric, metricLabel: s.metricLabel ?? s.metric, unit: s.unit ?? '',
			LSL: s.LSL ?? '', USL: s.USL ?? '', target: s.target ?? '', cpkMin: s.cpkMin ?? 1.33, rationale: s.rationale ?? ''
		};
	}
	function clearSpecDraft() {
		specEditingId = null;
		specDraft = { processType: 'wax', metric: 'cycleTime', metricLabel: 'Cycle Time', unit: 'min', LSL: '', USL: '', target: '', cpkMin: 1.33, rationale: '' };
	}

	// =========================================================================
	// SPC close dialog
	// =========================================================================
	let spcClosingId = $state<string | null>(null);
	let spcRootCause = $state('');
	let spcCorrectiveAction = $state('');

	// =========================================================================
	// DOE planner (local state only — calculates a run matrix client-side)
	// =========================================================================
	let doeFactors = $state<{ name: string; low: string; high: string }[]>([
		{ name: 'Factor A', low: '-', high: '+' },
		{ name: 'Factor B', low: '-', high: '+' }
	]);
	let doeReplicates = $state(1);
	function addDoeFactor() { if (doeFactors.length < 7) doeFactors = [...doeFactors, { name: `Factor ${String.fromCharCode(65 + doeFactors.length)}`, low: '-', high: '+' }]; }
	function removeDoeFactor(i: number) { doeFactors = doeFactors.filter((_, idx) => idx !== i); }
	const doeRuns = $derived.by(() => {
		const k = doeFactors.length;
		const n = 2 ** k;
		const rows: Record<string, string>[] = [];
		for (let rep = 0; rep < doeReplicates; rep++) {
			for (let i = 0; i < n; i++) {
				const row: Record<string, string> = { Run: String(rows.length + 1), Replicate: String(rep + 1) };
				for (let f = 0; f < k; f++) {
					const bit = (i >> f) & 1;
					row[doeFactors[f].name] = bit ? doeFactors[f].high : doeFactors[f].low;
				}
				rows.push(row);
			}
		}
		// Fisher–Yates shuffle for random run order (reproducible-ish seed-free)
		const shuffled = [...rows];
		for (let i = shuffled.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
		}
		shuffled.forEach((r, i) => r['Std Order'] = r.Run);
		shuffled.forEach((r, i) => r.Run = String(i + 1));
		return shuffled;
	});

	// =========================================================================
	// Chart helper — inline SVG histogram / pareto / p-chart / I-MR
	// =========================================================================
	function svgPathForLine(pts: { x: number; y: number }[]): string {
		if (pts.length === 0) return '';
		return 'M' + pts.map(p => `${p.x},${p.y}`).join(' L');
	}

	// =========================================================================
	// Highest-n cycle-time process (for default chart)
	// =========================================================================
	const topCycleProcess = $derived((data.cycleTime ?? [])[0] ?? null);
</script>

<div class="mx-auto max-w-[1600px] space-y-6 p-4">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan)">Manufacturing Analysis</h1>
			<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
				Unified time + failure + yield analysis across every process. Phase 1 — descriptive + SPC. Targets &amp; capability analysis turn on once spec limits are defined.
			</p>
		</div>
		<div class="flex gap-2">
			<button onclick={() => downloadCsv('runs', data.runs)}
				class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs font-medium hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)] transition-colors"
				style="color: var(--color-tron-text)">
				Export runs CSV
			</button>
		</div>
	</div>

	<!-- Global filter bar -->
	<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]/40 p-4">
		<div class="grid gap-3 lg:grid-cols-6">
			<div>
				<label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">From</label>
				<input type="date" bind:value={fromDate} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs" style="color: var(--color-tron-text)" />
			</div>
			<div>
				<label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">To</label>
				<input type="date" bind:value={toDate} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs" style="color: var(--color-tron-text)" />
			</div>
			<div>
				<label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Processes</label>
				<select multiple bind:value={selectedProcesses} class="mt-1 h-20 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs" style="color: var(--color-tron-text)">
					{#each data.filterOptions.processes as p}
						<option value={p.id}>{p.label}</option>
					{/each}
				</select>
			</div>
			<div>
				<label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Operators</label>
				<select multiple bind:value={selectedOperators} class="mt-1 h-20 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs" style="color: var(--color-tron-text)">
					{#each data.filterOptions.operators as o}
						<option value={o.id}>{o.username}</option>
					{/each}
				</select>
			</div>
			<div>
				<label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Robots</label>
				<select multiple bind:value={selectedRobots} class="mt-1 h-20 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs" style="color: var(--color-tron-text)">
					{#each data.filterOptions.robots as r}
						<option value={r.id}>{r.name}</option>
					{/each}
				</select>
			</div>
			<div>
				<label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Shifts</label>
				<select multiple bind:value={selectedShifts} class="mt-1 h-20 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs" style="color: var(--color-tron-text)">
					<option value="morning">Morning (06–14)</option>
					<option value="afternoon">Afternoon (14–22)</option>
					<option value="night">Night (22–06)</option>
				</select>
			</div>
		</div>
		<div class="mt-3 flex items-center gap-2">
			<div class="flex gap-1">
				<button onclick={() => setDateRange(1)} class="rounded border border-[var(--color-tron-border)] px-2 py-1 text-[10px] hover:border-[var(--color-tron-cyan)]">Today</button>
				<button onclick={() => setDateRange(7)} class="rounded border border-[var(--color-tron-border)] px-2 py-1 text-[10px] hover:border-[var(--color-tron-cyan)]">7d</button>
				<button onclick={() => setDateRange(30)} class="rounded border border-[var(--color-tron-border)] px-2 py-1 text-[10px] hover:border-[var(--color-tron-cyan)]">30d</button>
				<button onclick={() => setDateRange(90)} class="rounded border border-[var(--color-tron-border)] px-2 py-1 text-[10px] hover:border-[var(--color-tron-cyan)]">QTD</button>
			</div>
			<input type="text" placeholder="Input lot barcode filter (comma-separated)" bind:value={inputLotBarcodes} class="flex-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs" style="color: var(--color-tron-text)" />
			<button onclick={applyFilters} class="rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-3 py-1.5 text-xs font-medium text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/20">Apply</button>
			<button onclick={resetFilters} class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs hover:border-red-500">Reset</button>
		</div>
	</section>

	<!-- Tab bar -->
	<nav class="flex flex-wrap gap-1 border-b border-[var(--color-tron-border)]">
		{#each TABS as tab}
			<button onclick={() => setTab(tab.id)}
				class="relative px-3 py-2 text-xs font-medium transition-colors {activeTab === tab.id ? 'text-[var(--color-tron-cyan)]' : 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}"
				style="border-bottom: 2px solid {activeTab === tab.id ? 'var(--color-tron-cyan)' : 'transparent'}">
				{tab.label}
			</button>
		{/each}
	</nav>

	{#if form?.success}
		<div class="rounded border border-green-500/50 bg-green-900/10 p-2 text-xs text-green-300">Saved.</div>
	{/if}
	{#if form?.error}
		<div class="rounded border border-red-500/50 bg-red-900/10 p-2 text-xs text-red-300">{form.error}</div>
	{/if}

	<!-- ========================================================================== -->
	<!-- TAB: OVERVIEW                                                               -->
	<!-- ========================================================================== -->
	{#if activeTab === 'overview'}
		{@const o = data.overview}
		<section class="space-y-4">
			<!-- KPI strip -->
			<div class="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
				<div class="rounded-lg border border-[var(--color-tron-border)] p-4 text-center">
					<div class="text-2xl font-bold text-[var(--color-tron-cyan)]">{fmtInt(o.totalRuns)}</div>
					<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Total Runs</div>
				</div>
				<div class="rounded-lg border border-[var(--color-tron-border)] p-4 text-center">
					<div class="text-2xl font-bold text-green-400">{fmtInt(o.totalProduced)}</div>
					<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Produced</div>
				</div>
				<div class="rounded-lg border border-[var(--color-tron-border)] p-4 text-center">
					<div class="text-2xl font-bold text-red-400">{fmtInt(o.totalScrapped)}</div>
					<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Scrapped</div>
				</div>
				<div class="rounded-lg border border-[var(--color-tron-border)] p-4 text-center">
					<div class="text-2xl font-bold text-amber-400">{fmtInt(o.totalRejected)}</div>
					<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Rejected</div>
				</div>
				<div class="rounded-lg border border-[var(--color-tron-border)] p-4 text-center">
					<div class="text-2xl font-bold" style="color: {(o.overallFpy ?? 0) >= 0.95 ? '#4ade80' : (o.overallFpy ?? 0) >= 0.8 ? '#fbbf24' : '#ef4444'}">{fmtPct(o.overallFpy)}</div>
					<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Overall FPY</div>
				</div>
				<div class="rounded-lg border border-[var(--color-tron-border)] p-4 text-center">
					<div class="text-2xl font-bold" style="color: {o.rty >= 0.9 ? '#4ade80' : o.rty >= 0.75 ? '#fbbf24' : '#ef4444'}">{fmtPct(o.rty)}</div>
					<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Rolled Yield (RTY)</div>
				</div>
			</div>

			<!-- Per-stage yield breakdown -->
			<div class="rounded-lg border border-[var(--color-tron-border)] p-4">
				<h3 class="mb-3 text-sm font-semibold" style="color: var(--color-tron-text)">First-Pass Yield by Process</h3>
				{#if o.stageYields.length === 0}
					<p class="text-xs" style="color: var(--color-tron-text-secondary)">No inspected cartridges in the selected range.</p>
				{:else}
					<div class="space-y-1.5">
						{#each o.stageYields as s}
							<div class="flex items-center gap-3">
								<span class="w-40 text-xs" style="color: var(--color-tron-text)">{s.process}</span>
								<div class="flex-1 h-5 rounded-sm bg-[var(--color-tron-surface)] overflow-hidden">
									<div class="h-full" style="width: {(s.fpy * 100).toFixed(1)}%; background: {s.fpy >= 0.95 ? '#10b981' : s.fpy >= 0.8 ? '#f59e0b' : '#ef4444'}"></div>
								</div>
								<span class="w-16 text-right font-mono text-xs" style="color: var(--color-tron-text)">{fmtPct(s.fpy)}</span>
								<span class="w-16 text-right text-[10px]" style="color: var(--color-tron-text-secondary)">n={s.n}</span>
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Runs per process -->
			<div class="rounded-lg border border-[var(--color-tron-border)] p-4">
				<h3 class="mb-3 text-sm font-semibold" style="color: var(--color-tron-text)">Runs per Process</h3>
				<div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
					{#each Object.entries(o.runsPerProcess) as [p, n]}
						<div class="rounded border border-[var(--color-tron-border)] p-2">
							<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">{p}</div>
							<div class="font-mono text-base" style="color: var(--color-tron-text)">{n}</div>
						</div>
					{/each}
				</div>
			</div>

			<div class="rounded-lg border border-amber-500/30 bg-amber-900/5 p-4 text-xs text-amber-200/80">
				<strong>Open SPC signals:</strong> {o.openSignals}. See the SPC Alerts tab.
			</div>
		</section>
	{/if}

	<!-- ========================================================================== -->
	<!-- TAB: CYCLE TIME                                                             -->
	<!-- ========================================================================== -->
	{#if activeTab === 'cycle'}
		<section class="space-y-5">
			{#if (data.cycleTime ?? []).length === 0}
				<p class="text-xs" style="color: var(--color-tron-text-secondary)">No cycle-time data in the selected range.</p>
			{:else}
				{#each data.cycleTime as p}
					<div class="rounded-lg border border-[var(--color-tron-border)] p-4">
						<div class="mb-3 flex items-center justify-between">
							<h3 class="text-sm font-semibold" style="color: var(--color-tron-text)">{p.label} · n={p.n}</h3>
							{#if p.capability.cpk != null}
								<div class="text-xs" style="color: {p.capability.cpk >= (p.specLimits?.cpkMin ?? 1.33) ? '#4ade80' : '#ef4444'}">
									Cp={fmtNum(p.capability.cp)} · Cpk={fmtNum(p.capability.cpk)} · σ={fmtNum(p.capability.stdDev)} · DPMO={fmtInt(p.capability.dpmo)}
									{#if p.capability.warningSmallN}
										<span class="ml-2 text-amber-400">(n&lt;30 — unreliable)</span>
									{/if}
								</div>
							{:else}
								<div class="text-[10px] italic" style="color: var(--color-tron-text-secondary)">
									No spec limits defined — capability analysis disabled. Set limits on the Spec Limits sub-page.
								</div>
							{/if}
						</div>

						<!-- Descriptive strip -->
						<div class="mb-3 grid grid-cols-3 gap-2 text-xs sm:grid-cols-6">
							<div><span style="color: var(--color-tron-text-secondary)">Mean</span> <span class="font-mono">{fmtNum(p.descriptive.mean)} min</span></div>
							<div><span style="color: var(--color-tron-text-secondary)">Median</span> <span class="font-mono">{fmtNum(p.descriptive.median)}</span></div>
							<div><span style="color: var(--color-tron-text-secondary)">StdDev</span> <span class="font-mono">{fmtNum(p.descriptive.stdDev)}</span></div>
							<div><span style="color: var(--color-tron-text-secondary)">Min</span> <span class="font-mono">{fmtNum(p.descriptive.min)}</span></div>
							<div><span style="color: var(--color-tron-text-secondary)">Max</span> <span class="font-mono">{fmtNum(p.descriptive.max)}</span></div>
							<div><span style="color: var(--color-tron-text-secondary)">IQR</span> <span class="font-mono">{fmtNum(p.descriptive.iqr)}</span></div>
						</div>

						<!-- Histogram SVG -->
						{#if p.histogram.bins.length > 0}
							{@const maxCount = Math.max(...p.histogram.bins.map((b: any) => b.count), 1)}
							<div class="rounded border border-[var(--color-tron-border)] p-3">
								<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Histogram (20 bins)</div>
								<svg viewBox="0 0 600 150" class="mt-2 w-full">
									{#each p.histogram.bins as b, i}
										{@const x = (i / p.histogram.bins.length) * 580 + 10}
										{@const h = (b.count / maxCount) * 120}
										<rect x={x} y={140 - h} width={580 / p.histogram.bins.length - 1} height={h} fill="var(--color-tron-cyan)" opacity="0.7" />
									{/each}
								</svg>
								<div class="mt-1 flex justify-between text-[10px]" style="color: var(--color-tron-text-secondary)">
									<span>{fmtNum(p.histogram.min)} min</span>
									<span>{fmtNum(p.histogram.max)} min</span>
								</div>
							</div>
						{/if}

						<!-- I-MR chart SVG -->
						{#if p.imr.points.length > 1}
							{@const cl = p.imr.centerlineI ?? 0}
							{@const ucl = p.imr.uclI ?? cl}
							{@const lcl = p.imr.lclI ?? cl}
							{@const yMax = Math.max(ucl, Math.max(...p.imr.points.map((pt: any) => pt.value)), cl) * 1.05}
							{@const yMin = Math.min(lcl, Math.min(...p.imr.points.map((pt: any) => pt.value)), cl) * 0.95}
							{@const yRange = yMax - yMin || 1}
							<div class="mt-3 rounded border border-[var(--color-tron-border)] p-3">
								<div class="flex items-center justify-between">
									<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">I-Chart (individuals)</div>
									{#if p.imr.signals.length > 0}
										<span class="text-[10px] text-red-400">{p.imr.signals.length} SPC signal{p.imr.signals.length > 1 ? 's' : ''}</span>
									{/if}
								</div>
								<svg viewBox="0 0 800 200" class="mt-2 w-full">
									<!-- Zones -->
									<line x1="10" y1={((yMax - ucl) / yRange) * 180 + 10} x2="790" y2={((yMax - ucl) / yRange) * 180 + 10} stroke="#ef4444" stroke-dasharray="4,4" stroke-width="1" />
									<line x1="10" y1={((yMax - cl) / yRange) * 180 + 10} x2="790" y2={((yMax - cl) / yRange) * 180 + 10} stroke="#10b981" stroke-width="1" />
									<line x1="10" y1={((yMax - lcl) / yRange) * 180 + 10} x2="790" y2={((yMax - lcl) / yRange) * 180 + 10} stroke="#ef4444" stroke-dasharray="4,4" stroke-width="1" />
									<!-- Points -->
									{#each p.imr.points as pt, i}
										{@const x = (i / Math.max(p.imr.points.length - 1, 1)) * 780 + 10}
										{@const y = ((yMax - pt.value) / yRange) * 180 + 10}
										{@const isSignal = p.imr.signals.some((s: any) => s.pointIndex === i)}
										<circle cx={x} cy={y} r={isSignal ? 4 : 2} fill={isSignal ? '#ef4444' : 'var(--color-tron-cyan)'} />
										{#if i > 0}
											{@const prevX = ((i - 1) / Math.max(p.imr.points.length - 1, 1)) * 780 + 10}
											{@const prevY = ((yMax - p.imr.points[i - 1].value) / yRange) * 180 + 10}
											<line x1={prevX} y1={prevY} x2={x} y2={y} stroke="var(--color-tron-cyan)" stroke-width="1" opacity="0.6" />
										{/if}
									{/each}
								</svg>
								<div class="mt-1 flex justify-between text-[10px] font-mono" style="color: var(--color-tron-text-secondary)">
									<span>UCL: {fmtNum(ucl)}</span>
									<span>CL: {fmtNum(cl)}</span>
									<span>LCL: {fmtNum(lcl)}</span>
								</div>
								{#if p.imr.signals.length > 0}
									<ul class="mt-2 space-y-0.5 text-[10px] text-red-300">
										{#each p.imr.signals.slice(0, 5) as s}
											<li>• Point #{s.pointIndex + 1}: {s.description}</li>
										{/each}
									</ul>
								{/if}
							</div>
						{/if}
					</div>
				{/each}
			{/if}
		</section>
	{/if}

	<!-- ========================================================================== -->
	<!-- TAB: YIELD & FAILURES                                                       -->
	<!-- ========================================================================== -->
	{#if activeTab === 'failures'}
		<section class="space-y-4">
			<!-- Pareto -->
			<div class="rounded-lg border border-[var(--color-tron-border)] p-4">
				<h3 class="mb-3 text-sm font-semibold" style="color: var(--color-tron-text)">Pareto — Rejection / Abort Reasons</h3>
				{#if data.yieldFailures.pareto.length === 0}
					<p class="text-xs" style="color: var(--color-tron-text-secondary)">No rejection reasons logged in the selected range.</p>
				{:else}
					{@const maxC = Math.max(...data.yieldFailures.pareto.map((p: any) => p.count), 1)}
					<div class="space-y-1.5">
						{#each data.yieldFailures.pareto.slice(0, 15) as p}
							<div class="flex items-center gap-3">
								<span class="w-48 truncate text-xs" style="color: var(--color-tron-text)">{p.label}</span>
								<div class="flex-1 h-5 rounded-sm bg-[var(--color-tron-surface)] overflow-hidden">
									<div class="h-full bg-red-500" style="width: {(p.count / maxC * 100).toFixed(1)}%"></div>
								</div>
								<span class="w-10 text-right font-mono text-xs" style="color: var(--color-tron-text)">{p.count}</span>
								<span class="w-14 text-right text-[10px]" style="color: var(--color-tron-text-secondary)">{p.cumPct.toFixed(0)}% cum</span>
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<!-- p-chart -->
			<div class="rounded-lg border border-[var(--color-tron-border)] p-4">
				<h3 class="mb-3 text-sm font-semibold" style="color: var(--color-tron-text)">p-Chart — Daily Rejection Rate (wax + reagent)</h3>
				{#if data.yieldFailures.dailyRejectionPChart.points.length === 0}
					<p class="text-xs" style="color: var(--color-tron-text-secondary)">No inspected cartridges in the selected range.</p>
				{:else}
					{@const pc = data.yieldFailures.dailyRejectionPChart}
					{@const pMax = Math.max(...pc.points.map((p: any) => p.ucl), pc.centerline) * 1.05}
					<svg viewBox="0 0 800 150" class="w-full">
						<line x1="10" y1={((pMax - pc.centerline) / pMax) * 130 + 10} x2="790" y2={((pMax - pc.centerline) / pMax) * 130 + 10} stroke="#10b981" stroke-width="1" />
						{#each pc.points as pt, i}
							{@const x = (i / Math.max(pc.points.length - 1, 1)) * 780 + 10}
							{@const y = ((pMax - pt.p) / pMax) * 130 + 10}
							{@const yUpper = ((pMax - pt.ucl) / pMax) * 130 + 10}
							{@const yLower = ((pMax - pt.lcl) / pMax) * 130 + 10}
							<line x1={x - 3} y1={yUpper} x2={x + 3} y2={yUpper} stroke="#ef4444" stroke-dasharray="2,2" stroke-width="1" />
							<line x1={x - 3} y1={yLower} x2={x + 3} y2={yLower} stroke="#ef4444" stroke-dasharray="2,2" stroke-width="1" />
							<circle cx={x} cy={y} r="2.5" fill="var(--color-tron-cyan)" />
							{#if i > 0}
								{@const prevX = ((i - 1) / Math.max(pc.points.length - 1, 1)) * 780 + 10}
								{@const prevY = ((pMax - pc.points[i - 1].p) / pMax) * 130 + 10}
								<line x1={prevX} y1={prevY} x2={x} y2={y} stroke="var(--color-tron-cyan)" stroke-width="1" />
							{/if}
						{/each}
					</svg>
					<div class="mt-1 flex justify-between text-[10px] font-mono" style="color: var(--color-tron-text-secondary)">
						<span>{data.yieldFailures.dailyRejectionDays[0] ?? ''}</span>
						<span>CL: {(pc.centerline * 100).toFixed(2)}%</span>
						<span>{data.yieldFailures.dailyRejectionDays.at(-1) ?? ''}</span>
					</div>
					{#if pc.signals.length > 0}
						<p class="mt-2 text-[10px] text-red-300">{pc.signals.length} Nelson rule hit(s): {pc.signals.map((s: any) => `R${s.ruleNumber}@${s.pointIndex + 1}`).join(', ')}</p>
					{/if}
				{/if}
			</div>

			<!-- Cause-effect link -->
			<div class="rounded-lg border border-[var(--color-tron-border)] p-4">
				<h3 class="mb-3 text-sm font-semibold" style="color: var(--color-tron-text)">Cause-Effect Diagrams</h3>
				{#if data.causeEffectDiagrams.length === 0}
					<p class="text-xs" style="color: var(--color-tron-text-secondary)">No diagrams yet. Add one to capture 5M1E root-cause analysis.</p>
				{:else}
					<div class="space-y-2">
						{#each data.causeEffectDiagrams as d}
							<div class="rounded border border-[var(--color-tron-border)] p-3">
								<div class="flex items-center justify-between">
									<span class="text-xs font-semibold" style="color: var(--color-tron-text)">{d.processType} — {d.problemStatement}</span>
									<span class="text-[10px]" style="color: var(--color-tron-text-secondary)">{d.nodes.length} causes</span>
								</div>
								{#each ['Man','Machine','Material','Method','Measurement','Environment'] as cat}
									{@const ns = d.nodes.filter((n: any) => n.category === cat)}
									{#if ns.length > 0}
										<div class="mt-2">
											<span class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-cyan)">{cat}</span>
											<ul class="ml-2 mt-1 space-y-0.5">
												{#each ns as n}<li class="text-xs" style="color: var(--color-tron-text)">• {n.cause}</li>{/each}
											</ul>
										</div>
									{/if}
								{/each}
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</section>
	{/if}

	<!-- ========================================================================== -->
	<!-- TAB: MATERIAL FLOW                                                          -->
	<!-- ========================================================================== -->
	{#if activeTab === 'material'}
		<section class="space-y-4">
			<div class="rounded-lg border border-[var(--color-tron-border)] p-4">
				<h3 class="mb-3 text-sm font-semibold" style="color: var(--color-tron-text)">Input Lot Consumption</h3>
				{#if data.materialFlow.lotUsage.length === 0}
					<p class="text-xs" style="color: var(--color-tron-text-secondary)">No input lot data in the selected range.</p>
				{:else}
					<div class="overflow-x-auto">
						<table class="w-full text-xs">
							<thead>
								<tr class="border-b border-[var(--color-tron-border)] text-left" style="color: var(--color-tron-text-secondary)">
									<th class="px-2 py-1">Barcode</th><th class="px-2 py-1">Material</th><th class="px-2 py-1">Runs</th>
									<th class="px-2 py-1">Produced</th><th class="px-2 py-1">Scrapped</th><th class="px-2 py-1">Yield</th>
								</tr>
							</thead>
							<tbody>
								{#each data.materialFlow.lotUsage as l}
									<tr class="border-b border-[var(--color-tron-border)]/50">
										<td class="px-2 py-1 font-mono" style="color: var(--color-tron-text)">{l.barcode}</td>
										<td class="px-2 py-1" style="color: var(--color-tron-text)">{l.material ?? '—'}</td>
										<td class="px-2 py-1 font-mono">{l.runCount}</td>
										<td class="px-2 py-1 font-mono">{fmtInt(l.totalProduced)}</td>
										<td class="px-2 py-1 font-mono text-red-300">{fmtInt(l.totalScrapped)}</td>
										<td class="px-2 py-1 font-mono">{fmtPct(l.yield)}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</div>
		</section>
	{/if}

	<!-- ========================================================================== -->
	<!-- TAB: COMPARE (operator / robot)                                             -->
	<!-- ========================================================================== -->
	{#if activeTab === 'compare'}
		<section class="space-y-4">
			<div class="rounded-lg border border-[var(--color-tron-border)] p-4">
				<h3 class="mb-3 text-sm font-semibold" style="color: var(--color-tron-text)">Cycle Time by Operator</h3>
				{#if data.compare.operatorGroups.length === 0}
					<p class="text-xs" style="color: var(--color-tron-text-secondary)">Not enough data.</p>
				{:else}
					<table class="w-full text-xs">
						<thead><tr class="border-b border-[var(--color-tron-border)] text-left" style="color: var(--color-tron-text-secondary)">
							<th class="px-2 py-1">Operator</th><th class="px-2 py-1">n</th><th class="px-2 py-1">Mean</th>
							<th class="px-2 py-1">Median</th><th class="px-2 py-1">StdDev</th><th class="px-2 py-1">Range</th>
						</tr></thead>
						<tbody>
							{#each data.compare.operatorGroups as g}
								<tr class="border-b border-[var(--color-tron-border)]/50">
									<td class="px-2 py-1" style="color: var(--color-tron-text)">{g.name}</td>
									<td class="px-2 py-1 font-mono">{g.descriptive.n}</td>
									<td class="px-2 py-1 font-mono">{fmtNum(g.descriptive.mean)}</td>
									<td class="px-2 py-1 font-mono">{fmtNum(g.descriptive.median)}</td>
									<td class="px-2 py-1 font-mono">{fmtNum(g.descriptive.stdDev)}</td>
									<td class="px-2 py-1 font-mono">{fmtNum(g.descriptive.min)}—{fmtNum(g.descriptive.max)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
					{#if data.compare.operatorAnova}
						<div class="mt-3 rounded border border-[var(--color-tron-border)] p-2 text-xs">
							<strong>One-way ANOVA:</strong>
							F = {fmtNum(data.compare.operatorAnova.fStat)} · df = ({data.compare.operatorAnova.dfBetween}, {data.compare.operatorAnova.dfWithin}) · p ≈ {fmtNum(data.compare.operatorAnova.pValue, 4)}
							{#if (data.compare.operatorAnova.pValue ?? 1) < 0.05}
								<span class="ml-2 text-red-400">— statistically significant (α=0.05)</span>
							{:else if data.compare.operatorAnova.pValue != null}
								<span class="ml-2 text-green-400">— not significant</span>
							{/if}
						</div>
					{/if}
				{/if}
			</div>

			<div class="rounded-lg border border-[var(--color-tron-border)] p-4">
				<h3 class="mb-3 text-sm font-semibold" style="color: var(--color-tron-text)">Cycle Time by Robot</h3>
				{#if data.compare.robotGroups.length === 0}
					<p class="text-xs" style="color: var(--color-tron-text-secondary)">Not enough data.</p>
				{:else}
					<table class="w-full text-xs">
						<thead><tr class="border-b border-[var(--color-tron-border)] text-left" style="color: var(--color-tron-text-secondary)">
							<th class="px-2 py-1">Robot</th><th class="px-2 py-1">n</th><th class="px-2 py-1">Mean</th>
							<th class="px-2 py-1">Median</th><th class="px-2 py-1">StdDev</th>
						</tr></thead>
						<tbody>
							{#each data.compare.robotGroups as g}
								<tr class="border-b border-[var(--color-tron-border)]/50">
									<td class="px-2 py-1" style="color: var(--color-tron-text)">{g.name}</td>
									<td class="px-2 py-1 font-mono">{g.descriptive.n}</td>
									<td class="px-2 py-1 font-mono">{fmtNum(g.descriptive.mean)}</td>
									<td class="px-2 py-1 font-mono">{fmtNum(g.descriptive.median)}</td>
									<td class="px-2 py-1 font-mono">{fmtNum(g.descriptive.stdDev)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
					{#if data.compare.robotAnova}
						<div class="mt-3 rounded border border-[var(--color-tron-border)] p-2 text-xs">
							<strong>One-way ANOVA:</strong>
							F = {fmtNum(data.compare.robotAnova.fStat)} · p ≈ {fmtNum(data.compare.robotAnova.pValue, 4)}
							{#if (data.compare.robotAnova.pValue ?? 1) < 0.05}<span class="ml-2 text-red-400">— significant</span>{/if}
						</div>
					{/if}
				{/if}
			</div>
		</section>
	{/if}

	<!-- ========================================================================== -->
	<!-- TAB: SPC ALERTS                                                             -->
	<!-- ========================================================================== -->
	{#if activeTab === 'spc'}
		<section class="space-y-4">
			<div class="grid grid-cols-2 gap-3 sm:grid-cols-5">
				{#each Object.entries(data.spcSignals.byStatus) as [status, n]}
					<div class="rounded border border-[var(--color-tron-border)] p-3 text-center">
						<div class="text-lg font-bold" style="color: {status === 'open' ? '#ef4444' : status === 'closed' ? '#10b981' : 'var(--color-tron-text)'}">{n}</div>
						<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">{status}</div>
					</div>
				{/each}
			</div>

			<div class="rounded-lg border border-[var(--color-tron-border)] p-4">
				<h3 class="mb-3 text-sm font-semibold" style="color: var(--color-tron-text)">Recent Signals</h3>
				{#if data.spcSignals.recent.length === 0}
					<p class="text-xs" style="color: var(--color-tron-text-secondary)">No signals recorded yet. Signals auto-open when Nelson rules trip on incoming data.</p>
				{:else}
					<table class="w-full text-xs">
						<thead><tr class="border-b border-[var(--color-tron-border)] text-left" style="color: var(--color-tron-text-secondary)">
							<th class="px-2 py-1">Detected</th><th class="px-2 py-1">Process</th><th class="px-2 py-1">Metric</th>
							<th class="px-2 py-1">Rule</th><th class="px-2 py-1">Value</th><th class="px-2 py-1">Status</th><th class="px-2 py-1">Actions</th>
						</tr></thead>
						<tbody>
							{#each data.spcSignals.recent as s}
								<tr class="border-b border-[var(--color-tron-border)]/50">
									<td class="px-2 py-1 font-mono">{fmtDate(s.detectedAt)}</td>
									<td class="px-2 py-1">{s.processType}</td>
									<td class="px-2 py-1">{s.metric}</td>
									<td class="px-2 py-1">R{s.ruleNumber} — {s.ruleDescription}</td>
									<td class="px-2 py-1 font-mono">{fmtNum(s.value)}</td>
									<td class="px-2 py-1">
										<span class="rounded px-1.5 py-0.5 text-[10px]" style="background: {s.status === 'open' ? '#ef444433' : s.status === 'closed' ? '#10b98133' : 'transparent'}">{s.status}</span>
									</td>
									<td class="px-2 py-1">
										{#if s.status === 'open'}
											<form method="POST" action="?/ackSignal" class="inline">
												<input type="hidden" name="id" value={s.id} />
												<button class="rounded border border-[var(--color-tron-border)] px-2 py-0.5 text-[10px] hover:border-[var(--color-tron-cyan)]">Ack</button>
											</form>
										{/if}
										{#if s.status !== 'closed' && s.status !== 'dismissed'}
											<button onclick={() => spcClosingId = s.id} class="ml-1 rounded border border-[var(--color-tron-border)] px-2 py-0.5 text-[10px] hover:border-green-500">Close</button>
										{/if}
									</td>
								</tr>
								{#if spcClosingId === s.id}
									<tr><td colspan="7" class="p-3" style="background: var(--color-tron-surface)">
										<form method="POST" action="?/closeSignal" class="flex flex-wrap items-end gap-2">
											<input type="hidden" name="id" value={s.id} />
											<div class="flex-1 min-w-[240px]">
												<label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Root cause</label>
												<textarea name="rootCause" required bind:value={spcRootCause} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs" rows="2"></textarea>
											</div>
											<div class="flex-1 min-w-[240px]">
												<label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Corrective action</label>
												<textarea name="correctiveAction" required bind:value={spcCorrectiveAction} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs" rows="2"></textarea>
											</div>
											<button type="submit" class="rounded border border-green-500/50 bg-green-900/20 px-3 py-1.5 text-xs text-green-300 hover:bg-green-900/40">Close signal</button>
											<button type="button" onclick={() => spcClosingId = null} class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs">Cancel</button>
										</form>
									</td></tr>
								{/if}
							{/each}
						</tbody>
					</table>
				{/if}
			</div>
		</section>
	{/if}

	<!-- ========================================================================== -->
	<!-- TAB: FMEA                                                                   -->
	<!-- ========================================================================== -->
	{#if activeTab === 'fmea'}
		<section class="space-y-4">
			<div class="rounded-lg border border-[var(--color-tron-border)] p-4">
				<h3 class="mb-3 text-sm font-semibold" style="color: var(--color-tron-text)">{fmeaEditingId ? 'Edit' : 'New'} FMEA Entry</h3>
				<form method="POST" action="?/saveFmea" class="grid gap-3 md:grid-cols-2">
					{#if fmeaEditingId}<input type="hidden" name="id" value={fmeaEditingId} />{/if}
					<div><label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Process</label>
						<select name="processType" bind:value={fmeaDraft.processType} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs">
							{#each data.filterOptions.processes as p}<option value={p.id}>{p.label}</option>{/each}
						</select></div>
					<div><label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Process step (optional)</label>
						<input name="processStep" bind:value={fmeaDraft.processStep} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs" /></div>
					<div class="md:col-span-2"><label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Failure mode *</label>
						<input name="failureMode" required bind:value={fmeaDraft.failureMode} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs" /></div>
					<div><label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Effect</label>
						<textarea name="failureEffect" bind:value={fmeaDraft.failureEffect} rows="2" class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs"></textarea></div>
					<div><label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Cause</label>
						<textarea name="cause" bind:value={fmeaDraft.cause} rows="2" class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs"></textarea></div>
					<div class="md:col-span-2"><label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Current controls</label>
						<textarea name="currentControls" bind:value={fmeaDraft.currentControls} rows="2" class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs"></textarea></div>
					<div class="flex gap-2">
						<div class="flex-1"><label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Severity (1-10)</label>
							<input type="number" name="severity" min="1" max="10" bind:value={fmeaDraft.severity} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs" /></div>
						<div class="flex-1"><label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Occurrence</label>
							<input type="number" name="occurrence" min="1" max="10" bind:value={fmeaDraft.occurrence} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs" /></div>
						<div class="flex-1"><label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Detection</label>
							<input type="number" name="detection" min="1" max="10" bind:value={fmeaDraft.detection} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs" /></div>
					</div>
					<div class="rounded border border-[var(--color-tron-cyan)]/30 p-3 text-center">
						<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">RPN</div>
						<div class="text-2xl font-bold" style="color: {fmeaRpn >= 200 ? '#ef4444' : fmeaRpn >= 100 ? '#f59e0b' : '#10b981'}">{fmeaRpn}</div>
					</div>
					<div><label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Classification</label>
						<select name="classification" bind:value={fmeaDraft.classification} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs">
							<option value="safety">Safety</option><option value="quality">Quality</option>
							<option value="compliance">Compliance</option><option value="productivity">Productivity</option>
						</select></div>
					<div><label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Status</label>
						<select name="status" bind:value={fmeaDraft.status} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs">
							<option value="draft">Draft</option><option value="active">Active</option><option value="archived">Archived</option>
						</select></div>
					<div class="md:col-span-2 flex gap-2">
						<button type="submit" class="rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-3 py-1.5 text-xs text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/20">Save</button>
						{#if fmeaEditingId}<button type="button" onclick={clearFmeaDraft} class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs">New entry</button>{/if}
					</div>
				</form>
			</div>

			<!-- FMEA table -->
			<div class="rounded-lg border border-[var(--color-tron-border)] p-4">
				<h3 class="mb-3 text-sm font-semibold" style="color: var(--color-tron-text)">FMEA Register (sorted by RPN)</h3>
				{#if data.fmeaSummary.all.length === 0}
					<p class="text-xs" style="color: var(--color-tron-text-secondary)">No FMEA entries yet.</p>
				{:else}
					<table class="w-full text-xs">
						<thead><tr class="border-b border-[var(--color-tron-border)] text-left" style="color: var(--color-tron-text-secondary)">
							<th class="px-2 py-1">Process</th><th class="px-2 py-1">Failure mode</th>
							<th class="px-2 py-1">S</th><th class="px-2 py-1">O</th><th class="px-2 py-1">D</th><th class="px-2 py-1">RPN</th>
							<th class="px-2 py-1">Class</th><th class="px-2 py-1">Status</th><th></th>
						</tr></thead>
						<tbody>
							{#each data.fmeaSummary.all as r}
								<tr class="border-b border-[var(--color-tron-border)]/50">
									<td class="px-2 py-1">{r.processType}</td>
									<td class="px-2 py-1">{r.failureMode}</td>
									<td class="px-2 py-1 font-mono">{r.severity}</td>
									<td class="px-2 py-1 font-mono">{r.occurrence}</td>
									<td class="px-2 py-1 font-mono">{r.detection}</td>
									<td class="px-2 py-1 font-mono font-bold" style="color: {r.rpn >= 200 ? '#ef4444' : r.rpn >= 100 ? '#f59e0b' : '#10b981'}">{r.rpn}</td>
									<td class="px-2 py-1">{r.classification ?? '—'}</td>
									<td class="px-2 py-1">{r.status}</td>
									<td class="px-2 py-1">
										<button onclick={() => editFmea(r)} class="rounded border border-[var(--color-tron-border)] px-2 py-0.5 text-[10px] hover:border-[var(--color-tron-cyan)]">Edit</button>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{/if}
			</div>
		</section>
	{/if}

	<!-- ========================================================================== -->
	<!-- TAB: MANUAL INPUT                                                           -->
	<!-- ========================================================================== -->
	{#if activeTab === 'manual'}
		<section class="space-y-4">
			<div class="rounded-lg border border-[var(--color-tron-border)] p-4">
				<h3 class="mb-3 text-sm font-semibold" style="color: var(--color-tron-text)">New Event</h3>
				<form method="POST" action="?/createManualEvent" class="grid gap-3 md:grid-cols-2">
					<div><label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Event type</label>
						<select name="eventType" bind:value={manualEventType} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs">
							<option value="observation">Observation</option>
							<option value="deviation">Deviation</option>
							<option value="environmental">Environmental</option>
							<option value="msa_measurement">MSA Measurement</option>
							<option value="corrective_action">Corrective Action</option>
							<option value="preventive_action">Preventive Action</option>
							<option value="training">Training</option>
							<option value="calibration">Calibration</option>
							<option value="maintenance">Maintenance</option>
							<option value="visual_defect">Visual Defect</option>
							<option value="rework">Rework</option>
							<option value="other">Other</option>
						</select></div>
					<div><label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Process</label>
						<select name="processType" bind:value={manualProcessType} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs">
							{#each data.filterOptions.processes as p}<option value={p.id}>{p.label}</option>{/each}
						</select></div>
					<div><label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Occurred at</label>
						<input type="datetime-local" name="occurredAt" bind:value={manualOccurredAt} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs" /></div>
					<div><label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Linked run ID (optional)</label>
						<input name="linkedRunId" bind:value={manualLinkedRunId} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs font-mono" /></div>
					<div><label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Linked lot (optional)</label>
						<input name="linkedLotId" bind:value={manualLinkedLotId} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs font-mono" /></div>
					<div><label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Linked cartridges (comma IDs)</label>
						<input name="linkedCartridgeIds" class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs font-mono" /></div>
					<div class="flex gap-2">
						<div class="flex-1"><label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Numeric value</label>
							<input type="number" step="any" name="numericValue" bind:value={manualNumeric} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs" /></div>
						<div class="w-24"><label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Unit</label>
							<input name="numericUnit" bind:value={manualNumericUnit} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs" /></div>
					</div>
					<div><label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Categorical value</label>
						<input name="categoricalValue" class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs" /></div>
					<div><label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Rejection code (optional)</label>
						<select name="rejectionReasonCode" bind:value={manualRejectionCode} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs">
							<option value="">— none —</option>
							{#each data.rejectionReasonCodes as rc}<option value={rc.code}>{rc.code} — {rc.label}</option>{/each}
						</select></div>
					<div><label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Severity</label>
						<select name="severity" bind:value={manualSeverity} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs">
							<option value="">—</option><option value="minor">Minor</option><option value="major">Major</option><option value="critical">Critical</option>
						</select></div>
					<div class="md:col-span-2"><label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Notes *</label>
						<textarea name="notes" required bind:value={manualNotes} rows="3" class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs"></textarea></div>
					<div class="md:col-span-2">
						<button type="submit" class="rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-4 py-2 text-xs font-medium text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/20">Save event</button>
					</div>
				</form>
			</div>

			<!-- Recent events -->
			<div class="rounded-lg border border-[var(--color-tron-border)] p-4">
				<h3 class="mb-3 text-sm font-semibold" style="color: var(--color-tron-text)">Recent Events</h3>
				{#if data.manualEvents.length === 0}
					<p class="text-xs" style="color: var(--color-tron-text-secondary)">No events yet.</p>
				{:else}
					<table class="w-full text-xs">
						<thead><tr class="border-b border-[var(--color-tron-border)] text-left" style="color: var(--color-tron-text-secondary)">
							<th class="px-2 py-1">When</th><th class="px-2 py-1">Type</th><th class="px-2 py-1">Process</th>
							<th class="px-2 py-1">Operator</th><th class="px-2 py-1">Notes</th><th class="px-2 py-1">Numeric</th>
							<th class="px-2 py-1">Linked</th><th></th>
						</tr></thead>
						<tbody>
							{#each data.manualEvents as e}
								<tr class="border-b border-[var(--color-tron-border)]/50">
									<td class="px-2 py-1 font-mono">{fmtDate(e.occurredAt)}</td>
									<td class="px-2 py-1">{e.eventType}</td>
									<td class="px-2 py-1">{e.processType}</td>
									<td class="px-2 py-1">{e.operator ?? '—'}</td>
									<td class="px-2 py-1">{e.notes.slice(0, 80)}{e.notes.length > 80 ? '…' : ''}</td>
									<td class="px-2 py-1 font-mono">{e.numericValue != null ? `${e.numericValue} ${e.numericUnit ?? ''}` : '—'}</td>
									<td class="px-2 py-1 font-mono text-[10px]">{e.linkedRunId ?? e.linkedLotId ?? '—'}</td>
									<td class="px-2 py-1">
										<form method="POST" action="?/deleteManualEvent" class="inline">
											<input type="hidden" name="id" value={e.id} />
											<button class="rounded border border-[var(--color-tron-border)] px-2 py-0.5 text-[10px] hover:border-red-500 hover:text-red-400">Delete</button>
										</form>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{/if}
			</div>
		</section>
	{/if}

	<!-- ========================================================================== -->
	<!-- TAB: ALL RUNS                                                               -->
	<!-- ========================================================================== -->
	{#if activeTab === 'runs'}
		<section class="space-y-4">
			<div class="flex items-center justify-between">
				<h3 class="text-sm font-semibold" style="color: var(--color-tron-text)">All Runs · {data.runs.length}</h3>
				<button onclick={() => downloadCsv('runs', data.runs)} class="rounded border border-[var(--color-tron-border)] px-3 py-1 text-xs hover:border-[var(--color-tron-cyan)]">CSV</button>
			</div>
			{#if data.runs.length === 0}
				<p class="text-xs" style="color: var(--color-tron-text-secondary)">No runs in the selected range.</p>
			{:else}
				<div class="overflow-x-auto rounded-lg border border-[var(--color-tron-border)]">
					<table class="w-full text-xs">
						<thead class="bg-[var(--color-tron-surface)]">
							<tr class="text-left" style="color: var(--color-tron-text-secondary)">
								<th class="px-2 py-1">Start</th><th class="px-2 py-1">Process</th><th class="px-2 py-1">Run</th>
								<th class="px-2 py-1">Status</th><th class="px-2 py-1">Operator</th><th class="px-2 py-1">Robot</th>
								<th class="px-2 py-1">Deck</th><th class="px-2 py-1">Cycle(min)</th><th class="px-2 py-1">Planned</th>
								<th class="px-2 py-1">Actual</th><th class="px-2 py-1">Accept</th><th class="px-2 py-1">Reject</th>
								<th class="px-2 py-1">Scrap</th><th class="px-2 py-1">Shift</th>
							</tr>
						</thead>
						<tbody>
							{#each data.runs as r}
								<tr class="border-t border-[var(--color-tron-border)]/30 hover:bg-[var(--color-tron-surface)]/30">
									<td class="px-2 py-1 font-mono">{fmtDate(r.startTime)}</td>
									<td class="px-2 py-1">{r.processLabel}</td>
									<td class="px-2 py-1 font-mono text-[10px]">{r.runId.slice(-8)}</td>
									<td class="px-2 py-1">{r.status}</td>
									<td class="px-2 py-1">{r.operator ?? '—'}</td>
									<td class="px-2 py-1">{r.robotName ?? '—'}</td>
									<td class="px-2 py-1">{r.deckId ?? '—'}</td>
									<td class="px-2 py-1 font-mono">{fmtNum(r.cycleTimeMin)}</td>
									<td class="px-2 py-1 font-mono">{fmtInt(r.plannedCount)}</td>
									<td class="px-2 py-1 font-mono">{fmtInt(r.actualCount)}</td>
									<td class="px-2 py-1 font-mono text-green-300">{fmtInt(r.acceptedCount)}</td>
									<td class="px-2 py-1 font-mono text-amber-300">{fmtInt(r.rejectedCount)}</td>
									<td class="px-2 py-1 font-mono text-red-300">{fmtInt(r.scrapCount)}</td>
									<td class="px-2 py-1">{r.shift ?? '—'}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>
	{/if}

	<!-- ========================================================================== -->
	<!-- TAB: REPORTS & EXPORT                                                       -->
	<!-- ========================================================================== -->
	{#if activeTab === 'export'}
		<section class="space-y-4">
			<div class="rounded-lg border border-[var(--color-tron-border)] p-4">
				<h3 class="mb-3 text-sm font-semibold" style="color: var(--color-tron-text)">Exports (current filter)</h3>
				<div class="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
					<button onclick={() => downloadCsv('runs', data.runs)} class="rounded border border-[var(--color-tron-border)] p-3 text-left text-xs hover:border-[var(--color-tron-cyan)]">
						<div class="font-semibold" style="color: var(--color-tron-text)">All Runs (CSV)</div>
						<div class="text-[10px]" style="color: var(--color-tron-text-secondary)">{data.runs.length} rows · all processes</div>
					</button>
					<button onclick={() => downloadCsv('manual-events', data.manualEvents)} class="rounded border border-[var(--color-tron-border)] p-3 text-left text-xs hover:border-[var(--color-tron-cyan)]">
						<div class="font-semibold" style="color: var(--color-tron-text)">Manual Events (CSV)</div>
						<div class="text-[10px]" style="color: var(--color-tron-text-secondary)">{data.manualEvents.length} rows</div>
					</button>
					<button onclick={() => downloadCsv('pareto', data.yieldFailures.pareto)} class="rounded border border-[var(--color-tron-border)] p-3 text-left text-xs hover:border-[var(--color-tron-cyan)]">
						<div class="font-semibold" style="color: var(--color-tron-text)">Pareto (CSV)</div>
						<div class="text-[10px]" style="color: var(--color-tron-text-secondary)">{data.yieldFailures.pareto.length} reasons</div>
					</button>
					<button onclick={() => downloadCsv('fmea', data.fmeaSummary.all)} class="rounded border border-[var(--color-tron-border)] p-3 text-left text-xs hover:border-[var(--color-tron-cyan)]">
						<div class="font-semibold" style="color: var(--color-tron-text)">FMEA (CSV)</div>
						<div class="text-[10px]" style="color: var(--color-tron-text-secondary)">{data.fmeaSummary.all.length} entries</div>
					</button>
					<button onclick={() => downloadCsv('spc-signals', data.spcSignals.recent)} class="rounded border border-[var(--color-tron-border)] p-3 text-left text-xs hover:border-[var(--color-tron-cyan)]">
						<div class="font-semibold" style="color: var(--color-tron-text)">SPC Signals (CSV)</div>
						<div class="text-[10px]" style="color: var(--color-tron-text-secondary)">{data.spcSignals.recent.length} rows</div>
					</button>
					<button onclick={() => downloadCsv('material-flow', data.materialFlow.lotUsage)} class="rounded border border-[var(--color-tron-border)] p-3 text-left text-xs hover:border-[var(--color-tron-cyan)]">
						<div class="font-semibold" style="color: var(--color-tron-text)">Material Flow (CSV)</div>
						<div class="text-[10px]" style="color: var(--color-tron-text-secondary)">{data.materialFlow.lotUsage.length} lots</div>
					</button>
				</div>
			</div>
			<div class="rounded-lg border border-[var(--color-tron-border)] p-4 text-xs" style="color: var(--color-tron-text-secondary)">
				<p>CSV output opens directly in Minitab, JMP, Excel, or Python/pandas. Column names kept stable so saved Minitab worksheets keep working across exports.</p>
				<p class="mt-1">Excel export (<code>xlsx</code>) coming Phase 2 — will preserve multi-sheet structure: Runs, Events, Pareto, SPC, FMEA, Filter State.</p>
			</div>
		</section>
	{/if}

	<!-- ========================================================================== -->
	<!-- TAB: DOE PLANNER                                                            -->
	<!-- ========================================================================== -->
	{#if activeTab === 'doe'}
		<section class="space-y-4">
			<div class="rounded-lg border border-[var(--color-tron-border)] p-4">
				<h3 class="mb-3 text-sm font-semibold" style="color: var(--color-tron-text)">Full Factorial 2^k Planner</h3>
				<div class="space-y-2">
					{#each doeFactors as f, i}
						<div class="flex gap-2">
							<input bind:value={f.name} class="flex-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs" placeholder="Factor name" />
							<input bind:value={f.low} class="w-24 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs" placeholder="Low" />
							<input bind:value={f.high} class="w-24 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs" placeholder="High" />
							<button onclick={() => removeDoeFactor(i)} class="rounded border border-[var(--color-tron-border)] px-2 py-1 text-[10px] hover:border-red-500 hover:text-red-400">×</button>
						</div>
					{/each}
					<div class="flex items-center gap-2">
						<button onclick={addDoeFactor} class="rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-3 py-1 text-xs text-[var(--color-tron-cyan)]">+ Add factor</button>
						<label class="ml-4 text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Replicates</label>
						<input type="number" min="1" max="10" bind:value={doeReplicates} class="w-16 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs" />
					</div>
				</div>
				<div class="mt-4">
					<div class="mb-2 flex items-center justify-between">
						<span class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Run matrix · {doeRuns.length} runs (randomized order)</span>
						<button onclick={() => downloadCsv('doe-run-matrix', doeRuns)} class="rounded border border-[var(--color-tron-border)] px-3 py-1 text-xs hover:border-[var(--color-tron-cyan)]">CSV</button>
					</div>
					<div class="overflow-x-auto rounded border border-[var(--color-tron-border)]">
						<table class="w-full text-xs">
							<thead class="bg-[var(--color-tron-surface)]">
								<tr class="text-left" style="color: var(--color-tron-text-secondary)">
									<th class="px-2 py-1">Run</th><th class="px-2 py-1">Std</th><th class="px-2 py-1">Rep</th>
									{#each doeFactors as f}<th class="px-2 py-1">{f.name}</th>{/each}
								</tr>
							</thead>
							<tbody>
								{#each doeRuns as r}
									<tr class="border-t border-[var(--color-tron-border)]/30">
										<td class="px-2 py-1 font-mono">{r.Run}</td>
										<td class="px-2 py-1 font-mono">{r['Std Order']}</td>
										<td class="px-2 py-1 font-mono">{r.Replicate}</td>
										{#each doeFactors as f}<td class="px-2 py-1 font-mono">{r[f.name]}</td>{/each}
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</div>
			</div>
			<div class="rounded-lg border border-[var(--color-tron-border)] p-4 text-xs" style="color: var(--color-tron-text-secondary)">
				<p>Fractional factorials, response-surface designs (CCD, Box-Behnken), and the analysis side (main effects, interactions, standardized effects Pareto) land in Phase 3. For now, export this run matrix and capture responses externally — we'll ingest them via Manual Input later.</p>
			</div>
		</section>
	{/if}
</div>
