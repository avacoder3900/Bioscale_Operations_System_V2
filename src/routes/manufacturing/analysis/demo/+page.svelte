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

	// Defensive defaults — when data.locked is true, data.filters is undefined
	const initialFilters: any = (data as any).filters ?? {};
	let fromDate = $state<string>(toInputDate(initialFilters.from ?? null));
	let toDate = $state<string>(toInputDate(initialFilters.to ?? null));
	let selectedProcesses = $state<string[]>(initialFilters.processTypes ?? []);
	let selectedOperators = $state<string[]>(initialFilters.operatorIds ?? []);
	let selectedRobots = $state<string[]>(initialFilters.robotIds ?? []);
	let selectedShifts = $state<string[]>((initialFilters.shifts as string[]) ?? []);
	let inputLotBarcodes = $state<string>((initialFilters.inputLotBarcodes ?? []).join(','));

	// Training-mode toggle (shows/hides the green "Training Guide" panels)
	let trainingMode = $state(true);
	let showGlossary = $state(false);

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

{#if data.locked}
	<!-- =================================================================== -->
	<!-- PASSWORD LOCK — enter "processadmin" to unlock the training demo     -->
	<!-- =================================================================== -->
	<div class="mx-auto max-w-md space-y-4 p-8">
		<div class="rounded-lg border-2 border-amber-500/60 bg-amber-900/10 p-6">
			<div class="mb-3 flex items-center gap-2">
				<svg class="h-6 w-6 text-amber-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
				<h1 class="text-xl font-bold text-amber-300">Analytics Demo — Training Mode</h1>
			</div>
			<p class="mb-4 text-sm" style="color: var(--color-tron-text-secondary)">
				This is a guided walkthrough of the manufacturing analytics module. Everything on this page is fabricated — it's a safe sandbox to learn process-engineering statistics (Cp/Cpk, control charts, Pareto, ANOVA, FMEA, DOE) without touching production data.
			</p>
			<p class="mb-4 text-sm" style="color: var(--color-tron-text-secondary)">
				Enter the training password to continue. Access lasts 24 hours per device.
			</p>
			<form method="POST" action="?/unlock" class="space-y-3">
				<input type="password" name="password" required autofocus
					placeholder="Training password"
					class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm"
					style="color: var(--color-tron-text)" />
				<button type="submit"
					class="w-full rounded border border-amber-500/50 bg-amber-500/20 px-4 py-2 text-sm font-medium text-amber-200 hover:bg-amber-500/30">
					Unlock Training Session
				</button>
				{#if form?.error}
					<p class="text-xs text-red-400">{form.error}</p>
				{/if}
			</form>
			<div class="mt-4 border-t border-[var(--color-tron-border)] pt-3 text-[11px]" style="color: var(--color-tron-text-secondary)">
				<p><strong>What you'll find inside:</strong></p>
				<ul class="mt-1 ml-4 list-disc space-y-0.5">
					<li>Every tab annotated with "how to read this" training panels</li>
					<li>Every statistical term (Cp, Cpk, DPMO, FPY, RTY, ANOVA, Nelson rules, RPN, DOE) explained in plain language</li>
					<li>How each chart connects to the others</li>
					<li>When a process engineer would use each tab in real work</li>
				</ul>
				<p class="mt-2 italic">
					Nothing in this demo is written to the database. Forms render but don't persist.
				</p>
			</div>
			<div class="mt-4 text-center">
				<a href="/manufacturing/analysis" class="text-xs" style="color: var(--color-tron-text-secondary)">
					← Back to the real analytics page
				</a>
			</div>
		</div>
	</div>
{:else}
<div class="mx-auto max-w-[1600px] space-y-6 p-4">
	<!-- DEMO banner — fabricated data, NOT from Mongo, NOT persisted -->
	<div class="rounded-lg border-2 border-amber-500/60 bg-amber-900/20 p-3">
		<div class="flex items-center justify-between gap-3">
			<div class="flex items-center gap-2 text-sm font-semibold text-amber-300">
				<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
				DEMO MODE — fabricated data for preview only. Nothing here is in Mongo. Forms do not persist.
			</div>
			<a href="/manufacturing/analysis"
				class="rounded border border-amber-500/50 bg-amber-900/30 px-3 py-1 text-xs font-medium text-amber-200 hover:bg-amber-900/50 whitespace-nowrap">
				← Switch to Real Data
			</a>
		</div>
	</div>

	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan)">Manufacturing Analysis <span class="ml-2 text-xs font-normal text-amber-400">[DEMO · TRAINING]</span></h1>
			<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
				Seeded demo — 9 robots, 12 decks, 16 trays, 4 ovens, 6 fridges, 4 assays, 12 operators. 1,115 runs across 30 days moving ~4,100 cartridges end-to-end (backing → wax → reagent → top-seal → QA/QC) with coherent per-stage flow and ~89.6% rolled yield. Nothing below is in Mongo.
			</p>
		</div>
		<div class="flex flex-wrap gap-2">
			<button onclick={() => { trainingMode = !trainingMode; }}
				class="rounded border px-3 py-1.5 text-xs font-medium transition-colors"
				class:bg-green-900={trainingMode}
				style="border-color: {trainingMode ? '#10b981' : 'var(--color-tron-border)'}; color: {trainingMode ? '#86efac' : 'var(--color-tron-text)'}">
				{trainingMode ? '📚 Training ON' : '📚 Training OFF'}
			</button>
			<button onclick={() => { showGlossary = !showGlossary; }}
				class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs font-medium hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)] transition-colors"
				style="color: var(--color-tron-text)">
				{showGlossary ? 'Hide' : 'Show'} Glossary
			</button>
			<button onclick={() => downloadCsv('runs-demo', data.runs)}
				class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs font-medium hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)] transition-colors"
				style="color: var(--color-tron-text)">
				Export runs CSV (demo)
			</button>
			<form method="POST" action="?/lock" class="inline">
				<button class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs hover:border-red-500 hover:text-red-400">🔒 Lock</button>
			</form>
		</div>
	</div>

	<!-- ==================================================================== -->
	<!-- TRAINING INTRO — always shown when Training ON, collapsible           -->
	<!-- ==================================================================== -->
	{#if trainingMode}
		<section class="rounded-lg border-2 border-green-500/40 bg-green-950/20 p-5">
			<h2 class="mb-3 text-lg font-semibold text-green-300">📚 Start Here — How This Whole Page Fits Together</h2>
			<div class="grid gap-4 text-xs leading-relaxed md:grid-cols-2" style="color: var(--color-tron-text)">
				<div>
					<p class="mb-2"><strong class="text-green-300">The goal of this page:</strong> Turn raw manufacturing data into decisions. Every tab answers a different question a process engineer might ask on a Monday morning.</p>
					<p class="mb-2"><strong class="text-green-300">Process engineering in one paragraph:</strong> Factories produce things. Things go right or wrong. Your job is to (a) measure what's happening, (b) tell whether the variation you see is "normal noise" or "something changed," (c) figure out the root cause when something did change, (d) fix it, and (e) prove the fix worked. This page is the measurement + detection + analysis layer of that loop.</p>
					<p class="mb-2"><strong class="text-green-300">The two kinds of variation (most important concept on this page):</strong></p>
					<ul class="ml-4 list-disc space-y-1">
						<li><strong>Common cause</strong> — the normal jitter that's always there. Comes from dozens of tiny sources (ambient temp, operator-to-operator, tiny part differences). You can't eliminate it by firing someone or tweaking one knob; you'd have to redesign the process. Shows up as the width of your histogram.</li>
						<li><strong>Special cause</strong> — something unusual happened. A tip got clogged, a new lot is different, a sensor drifted. You CAN chase it down and fix it. Shows up as a point outside the control limits.</li>
					</ul>
					<p class="mt-2">SPC (Statistical Process Control) is the set of tools that lets you tell these apart using data, not gut feel.</p>
				</div>
				<div>
					<p class="mb-2"><strong class="text-green-300">How the tabs connect:</strong></p>
					<ol class="ml-4 list-decimal space-y-1">
						<li><strong>Overview</strong> — the 10,000-ft view. "How many cartridges, how is yield doing, are any alarms open?"</li>
						<li><strong>Cycle Time</strong> — how long each stage takes. Tells you about capacity and variation.</li>
						<li><strong>Yield &amp; Failures</strong> — what's going wrong and how often. Pareto chart narrows you to the top 1–3 issues.</li>
						<li><strong>Material Flow</strong> — trace a bad cartridge back to its raw-material lots, or forward to the shipment.</li>
						<li><strong>Compare</strong> — is the difference I see between two operators / two robots real, or is it just noise? ANOVA answers this.</li>
						<li><strong>SPC Alerts</strong> — the automatic watchdog — yells when something goes off-pattern. Workflow: ack → investigate → close with root cause.</li>
						<li><strong>FMEA</strong> — prospective (not reactive). "Here's everything that could go wrong; prioritize fixes before customers see them."</li>
						<li><strong>Manual Input</strong> — capture things no sensor sees (operator observations, environmental notes, lab measurements, training events).</li>
						<li><strong>All Runs</strong> — flat log, for exports + spot-checks.</li>
						<li><strong>Reports &amp; Export</strong> — dump any dataset to CSV for Minitab / Excel / Python.</li>
						<li><strong>DOE Planner</strong> — when you need to experiment on purpose: which knobs actually move the needle?</li>
					</ol>
					<p class="mt-2"><strong class="text-green-300">Your main loop on this page:</strong> Overview → spot an outlier → dig into Cycle Time or Yield &amp; Failures → use Compare / SPC Alerts to isolate the cause → record action in FMEA or Manual Input → verify on next week's Overview.</p>
				</div>
			</div>
			<p class="mt-3 text-[11px] italic" style="color: var(--color-tron-text-secondary)">Toggle "Training OFF" at the top right to hide these green panels and see only the real page.</p>
		</section>
	{/if}

	<!-- ==================================================================== -->
	<!-- GLOSSARY — toggleable drawer                                          -->
	<!-- ==================================================================== -->
	{#if showGlossary}
		<section class="rounded-lg border border-blue-500/40 bg-blue-950/20 p-5">
			<h2 class="mb-3 text-lg font-semibold text-blue-300">🔤 Glossary — quick reference</h2>
			<div class="grid gap-3 text-xs md:grid-cols-3" style="color: var(--color-tron-text)">
				<div><strong class="text-blue-300">FPY (First Pass Yield)</strong><br>Of the units you inspected, what fraction passed on the first try. FPY = accepted / inspected.</div>
				<div><strong class="text-blue-300">RTY (Rolled Throughput Yield)</strong><br>Multiply every stage's FPY together. RTY = FPY₁ × FPY₂ × … If each stage is 95%, five stages gives 77%. Stages compound; small losses add up fast.</div>
				<div><strong class="text-blue-300">Scrap vs. Reject</strong><br>Scrap = physically unusable (trash). Reject = failed inspection (might be reworkable or destroyed). We track them separately so recovery programs can focus.</div>
				<div><strong class="text-blue-300">Cycle Time</strong><br>Wall-clock duration of one run, start to finish. Drives throughput, operator scheduling, and whether one station is a bottleneck.</div>
				<div><strong class="text-blue-300">Mean, Median, StdDev, IQR</strong><br>Mean = average. Median = middle value (robust to outliers). StdDev (σ) = typical distance from mean. IQR = middle 50% width (Q3−Q1). Compare mean vs median — if they're far apart you have skew.</div>
				<div><strong class="text-blue-300">Histogram</strong><br>Bar chart of how often each value range occurred. Shape tells you: normal (bell) = healthy; skewed = constrained; bimodal (two humps) = you have two mixed populations.</div>
				<div><strong class="text-blue-300">Control Chart (I-MR, X-bar/R, p-chart)</strong><br>Time series of a metric with a centerline and ±3σ limits. Points inside the limits = common-cause; points outside = special-cause, investigate. I-MR = Individuals + Moving Range (one measurement per time point). p-chart = proportion defective over time, for yes/no data.</div>
				<div><strong class="text-blue-300">UCL / LCL (Upper/Lower Control Limits)</strong><br>Drawn at mean ± 3σ. Statistically 99.7% of points should fall inside if the process is stable. NOT spec limits — control limits come from the data itself.</div>
				<div><strong class="text-blue-300">LSL / USL (Lower/Upper Spec Limits)</strong><br>The limits you (or the customer) set — what's acceptable. Very different from control limits. Always compare process mean + spread to spec, not to control limits.</div>
				<div><strong class="text-blue-300">Cp (Potential Capability)</strong><br>Cp = (USL − LSL) / 6σ. "If the process were perfectly centered, how much room is there?" Cp ≥ 1.33 is the conventional "capable" threshold. Cp ignores where the mean actually is.</div>
				<div><strong class="text-blue-300">Cpk (Actual Capability)</strong><br>Cpk = min of (USL − μ)/3σ and (μ − LSL)/3σ. Accounts for how far off-center you are. Cpk ≤ Cp always. If Cp=2.0 but Cpk=0.6, you have plenty of room but you're hugging one spec limit — re-center and you're fine.</div>
				<div><strong class="text-blue-300">Pp / Ppk</strong><br>Same formulas as Cp/Cpk, but using "long-term" σ from the full dataset rather than "within-subgroup" σ. For non-subgrouped I-MR data they're the same.</div>
				<div><strong class="text-blue-300">DPMO</strong><br>Defects Per Million Opportunities. Scaled scrap rate. 3.4 DPMO = legendary Six Sigma quality (6σ capability + 1.5σ shift).</div>
				<div><strong class="text-blue-300">Process Sigma</strong><br>How many standard deviations fit between your mean and your nearest spec. 3σ = ~66,807 DPMO. 6σ = ~3.4 DPMO. More sigmas = more room = fewer defects.</div>
				<div><strong class="text-blue-300">Pareto Chart</strong><br>Bar chart sorted big-to-small with a cumulative % line. 80/20 rule — usually the top 2–3 bars explain 70–80% of defects. Tells you what to fix first.</div>
				<div><strong class="text-blue-300">Nelson Rules</strong><br>8 patterns on a control chart that signal "something changed." Rule 1 = one point beyond 3σ. Rule 2 = 9 in a row on one side of the centerline. Rule 3 = 6 trending. Firing any rule = special-cause alert.</div>
				<div><strong class="text-blue-300">ANOVA (Analysis of Variance)</strong><br>Statistical test: "are the means of these groups actually different, or am I just seeing noise?" Outputs F-statistic and p-value. p &lt; 0.05 means "yes, different."</div>
				<div><strong class="text-blue-300">p-value</strong><br>"If there were really no difference, what's the chance I'd see data this extreme by accident?" Small p = effect is probably real. Threshold α = 0.05 is convention, not law.</div>
				<div><strong class="text-blue-300">Cause-Effect / Ishikawa / Fishbone</strong><br>Brainstorming diagram that organizes possible root causes by 5M1E (Man, Machine, Material, Method, Measurement, Environment). Used for root-cause work.</div>
				<div><strong class="text-blue-300">FMEA (Failure Mode and Effects Analysis)</strong><br>A table of "what could go wrong." For each row: <strong>Severity</strong> (how bad if it happens, 1–10), <strong>Occurrence</strong> (how often, 1–10), <strong>Detection</strong> (how likely you'd catch it before it leaves, 1–10). <strong>RPN = S×O×D</strong>. Sort descending, fix the top ones.</div>
				<div><strong class="text-blue-300">DOE (Design of Experiments)</strong><br>Planned experiments — vary multiple factors at once to learn which matters. 2^k factorial = 2 levels of each of k factors. Always randomize run order to prevent drift from masquerading as an effect.</div>
				<div><strong class="text-blue-300">Common Cause vs Special Cause</strong><br>Common = baseline noise, inherent to the process. Special = something unusual happened. Don't tamper with common cause (you'll make it worse); do chase special cause.</div>
				<div><strong class="text-blue-300">Gage R&amp;R</strong><br>Measurement-system study. Tells you how much of the variation you see is the process itself vs. the measurement instrument + operator. High R&amp;R = your "data" is mostly noise, don't trust downstream analysis.</div>
				<div><strong class="text-blue-300">SPC vs. Capability</strong><br>SPC (control charts) = "is the process stable over time?" Capability (Cp/Cpk) = "is a stable process meeting spec?" You need stability BEFORE capability makes sense.</div>
			</div>
		</section>
	{/if}

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
			{#if trainingMode}
				<div class="rounded-lg border border-green-500/40 bg-green-950/10 p-4 text-xs leading-relaxed" style="color: var(--color-tron-text)">
					<h3 class="mb-2 text-sm font-semibold text-green-300">📚 Training — Overview Tab</h3>
					<p class="mb-2"><strong>What you're looking at:</strong> The top-level dashboard. Six KPI tiles, one yield-bar chart, one runs-per-process table, and an alert counter.</p>
					<p class="mb-2"><strong>How to read the KPIs:</strong></p>
					<ul class="ml-4 list-disc space-y-1">
						<li><strong>Total Runs</strong> — every manufacturing run in the filter window (backing, wax, reagent, all of them). Gives you rough activity volume.</li>
						<li><strong>Produced</strong> — accepted cartridges (or sheets, for cut stages). Counts only what passed.</li>
						<li><strong>Scrapped</strong> — physically discarded. Usually happens at the backing step when a raw cartridge is damaged.</li>
						<li><strong>Rejected</strong> — failed inspection. Tracked separately because rework may be possible.</li>
						<li><strong>Overall FPY</strong> — First Pass Yield across every inspection. Green ≥ 95%, amber 80–94%, red &lt; 80%.</li>
						<li><strong>RTY</strong> — Rolled Throughput Yield. Multiply every stage's FPY together. This is the KPI that matters most — it answers "if I start 100 cartridges at backing, how many make it to shipping without rework?"</li>
					</ul>
					<p class="mb-2 mt-2"><strong>Stage-yield bars</strong> show FPY per process. Each bar's height is the pass rate for that process alone; chaining them multiplicatively gives RTY. Watch for one stage being dramatically lower than the others — that's your "weakest link" and probably where to spend fix effort first.</p>
					<p class="mb-2"><strong>Open SPC signals</strong> (amber box at bottom) = how many automated alerts are currently unresolved. Non-zero means "look at the SPC Alerts tab right now."</p>
					<p><strong>Connects to:</strong> If FPY is trending down → Cycle Time + Yield &amp; Failures. If one stage is low → Compare (is it an operator? a robot?). If SPC signals are open → SPC Alerts tab.</p>
					<p class="mt-2"><strong>Real-world use:</strong> Scan this every morning. 3 numbers matter: runs yesterday, today's RTY, open signals. If all green, move on to projects. If anything red, this is where your day starts.</p>
				</div>
			{/if}
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
			{#if trainingMode}
				<div class="rounded-lg border border-green-500/40 bg-green-950/10 p-4 text-xs leading-relaxed" style="color: var(--color-tron-text)">
					<h3 class="mb-2 text-sm font-semibold text-green-300">📚 Training — Cycle Time Tab</h3>
					<p class="mb-2"><strong>What you're looking at:</strong> For each process, a 3-part view of cycle-time distribution — descriptive statistics, a histogram, and a control chart — plus capability indices (Cp/Cpk) when spec limits exist.</p>

					<p class="mt-3 mb-1 font-semibold text-green-300">1. Descriptive statistics</p>
					<ul class="ml-4 list-disc space-y-0.5">
						<li><strong>Mean</strong> — arithmetic average. Sensitive to outliers.</li>
						<li><strong>Median</strong> — middle value when sorted. Not pulled by outliers. If mean and median differ significantly, your data is skewed.</li>
						<li><strong>StdDev (σ)</strong> — the "typical distance from the mean." Most data lives in mean ± 3σ.</li>
						<li><strong>IQR (interquartile range)</strong> — middle 50% spread (Q3 − Q1). A non-parametric measure of variation; robust to outliers.</li>
						<li><strong>Min / Max</strong> — extremes. Useful for spotting impossible values (e.g. negative cycle times mean a data bug).</li>
					</ul>

					<p class="mt-3 mb-1 font-semibold text-green-300">2. Histogram — the shape tells a story</p>
					<ul class="ml-4 list-disc space-y-0.5">
						<li><strong>Bell shape</strong> (approximately normal) — process behaving typically; classical SPC tools apply directly.</li>
						<li><strong>Right-skewed</strong> (long tail right) — most runs fast, a few unusually slow. Very common for cycle times because hardware can jam but can't go faster than physics.</li>
						<li><strong>Bimodal</strong> (two humps) — you have two populations mixed. E.g. two shifts, two robots, two operating modes. Separate them before analyzing.</li>
						<li><strong>Flat / uniform</strong> — usually indicates a constraint that caps variation, or a bug in how you're binning.</li>
					</ul>

					<p class="mt-3 mb-1 font-semibold text-green-300">3. I-MR control chart (Individuals + Moving Range)</p>
					<p class="mb-1">A time-series plot with three horizontal lines: centerline (mean), UCL (mean + 3σ), LCL (mean − 3σ). Each point is one run in time order.</p>
					<ul class="ml-4 list-disc space-y-0.5">
						<li>Points <em>inside</em> the limits = common-cause noise; do NOT react.</li>
						<li>Points <em>outside</em> the limits = special cause; investigate that specific run.</li>
						<li>The chart also applies <strong>Nelson rules</strong> (runs of points, trends, patterns) to catch smaller-magnitude shifts.</li>
						<li>Red dots mark Nelson-rule hits. The list below names each rule triggered.</li>
					</ul>
					<p class="mt-1"><strong>Important — control limits are NOT spec limits.</strong> Control limits come from the data (what this process does). Spec limits come from design/customer (what this process should do). A perfectly capable process can be wildly out of control, and vice versa.</p>

					<p class="mt-3 mb-1 font-semibold text-green-300">4. Capability indices (Cp, Cpk, DPMO, Process Sigma)</p>
					<ul class="ml-4 list-disc space-y-0.5">
						<li><strong>Cp</strong> = (USL − LSL) / 6σ. "Is there room between the spec walls for your process spread?" Ignores where the mean is.</li>
						<li><strong>Cpk</strong> = min of (USL − μ)/3σ and (μ − LSL)/3σ. Same idea but penalizes being off-center. Cpk ≤ Cp always.</li>
						<li><strong>Conventional targets:</strong> Cpk ≥ 1.33 = capable. Cpk ≥ 1.67 = highly capable. Cpk &lt; 1.0 = not capable, expect defects.</li>
						<li><strong>DPMO</strong> — Defects Per Million Opportunities estimated from Cpk. 3.4 DPMO = six-sigma quality.</li>
						<li><strong>Process Sigma</strong> — how many standard deviations fit between the mean and the nearest spec. A rephrased Cpk in σ-units.</li>
						<li><strong>When the warning "n &lt; 30 — unreliable" appears:</strong> small-sample capability estimates are notoriously fragile. Don't make decisions off capability numbers with n &lt; 30; wait for more data.</li>
					</ul>

					<p class="mt-3"><strong>Connects to:</strong> If cycle time is drifting → SPC Alerts. If one process is much slower than target → Compare (which operator/robot?). If capability is poor → consider whether the process needs redesign (FMEA) or just recentering (easier).</p>
					<p class="mt-2"><strong>Real-world use:</strong> The chart you live in as a process engineer. Weekly review: scan each process, look for Nelson rule hits, look at Cp/Cpk trending, identify the worst-performing stage and assign an improvement project.</p>
				</div>
			{/if}
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
			{#if trainingMode}
				<div class="rounded-lg border border-green-500/40 bg-green-950/10 p-4 text-xs leading-relaxed" style="color: var(--color-tron-text)">
					<h3 class="mb-2 text-sm font-semibold text-green-300">📚 Training — Yield &amp; Failures Tab</h3>
					<p class="mb-2"><strong>What you're looking at:</strong> Three connected views for defect analysis — a Pareto chart of reject reasons, a p-chart of defect rate over time, and editable cause-effect (fishbone) diagrams.</p>

					<p class="mt-3 mb-1 font-semibold text-green-300">1. Pareto chart — the 80/20 rule</p>
					<p class="mb-1">Bars sorted biggest-to-smallest, with a cumulative-% indicator on the right. The core insight: <strong>in any defect population, usually 2–3 reasons explain 70–80% of the defects.</strong> So if you want to move the needle on yield, don't boil the ocean — fix the top 3 bars.</p>
					<p><strong>Named after Vilfredo Pareto</strong> (Italian economist who noticed 80% of Italy's land was owned by 20% of the people; Joseph Juran later applied it to quality). The rule isn't exact — sometimes it's 70/30, sometimes 90/10 — but the <em>pattern</em> (a few big issues + a long tail) is universal.</p>
					<p class="mt-1"><strong>How to use it:</strong> The top bar is almost always your next improvement project. Pick the top 1–3 and build an FMEA entry or a corrective action.</p>

					<p class="mt-3 mb-1 font-semibold text-green-300">2. p-chart (proportion defective)</p>
					<p class="mb-1">A control chart for yes/no outcomes (this cartridge passed / didn't pass). One point per day; vertical axis = defect fraction; horizontal dashes per point = UCL/LCL specific to that day's sample size (variable sample size → variable limits).</p>
					<p class="mb-1"><strong>Why a p-chart and not an I-MR?</strong> Defect rate is bounded (0 to 1) and depends on sample size — larger samples have tighter natural limits. The p-chart math accounts for that.</p>
					<p><strong>How to read:</strong> Centerline = long-run average defect rate. Flat points = stable process. Points above UCL = a day with unusually high rejects. Multiple points above UCL = something shifted, investigate.</p>

					<p class="mt-3 mb-1 font-semibold text-green-300">3. Cause-effect (Ishikawa / fishbone) diagrams</p>
					<p class="mb-1">Brainstorming tool invented by Kaoru Ishikawa. Looks like a fish skeleton: the "head" is the problem statement (e.g. "Why do cartridges fail wax QC?"), and the "bones" are the six standard cause categories — <strong>5M1E: Man, Machine, Material, Method, Measurement, Environment.</strong></p>
					<ul class="ml-4 list-disc space-y-0.5">
						<li><strong>Man</strong> — operator skill, fatigue, training, shift effects.</li>
						<li><strong>Machine</strong> — robot calibration, tooling wear, sensor drift.</li>
						<li><strong>Material</strong> — raw material lot variation, supplier issues.</li>
						<li><strong>Method</strong> — SOP gaps, procedure ambiguity, sequence issues.</li>
						<li><strong>Measurement</strong> — inspection reliability, gage R&amp;R, human grading subjectivity.</li>
						<li><strong>Environment</strong> — temperature, humidity, vibration, ambient cleanliness.</li>
					</ul>
					<p class="mt-1">Each cause can link to rejection codes — so you can go from "this Pareto bar is tall" → "which 5M1E buckets contribute?" → "write an action to address it."</p>

					<p class="mt-3"><strong>Connects to:</strong> Top Pareto bar → new FMEA entry (treat as a failure mode). Cause-effect findings → FMEA occurrence scores. p-chart special-cause points → SPC Alerts signal. Operator patterns → Compare tab.</p>
					<p class="mt-2"><strong>Real-world use:</strong> This is your "why did quality drop this week?" tab. Start with Pareto → pick top bar → open fishbone for that problem → narrow to one 5M1E cause → go look at the relevant raw data → write the action.</p>
				</div>
			{/if}
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
			{#if trainingMode}
				<div class="rounded-lg border border-green-500/40 bg-green-950/10 p-4 text-xs leading-relaxed" style="color: var(--color-tron-text)">
					<h3 class="mb-2 text-sm font-semibold text-green-300">📚 Training — Material Flow Tab</h3>
					<p class="mb-2"><strong>What you're looking at:</strong> A per-lot ledger showing which raw-material lot was consumed by which manufacturing runs, how many units were produced, how many were scrapped, and per-lot yield.</p>

					<p class="mb-2"><strong>Why this matters (the regulatory reason):</strong> Medical device manufacturing requires bidirectional traceability. Given a defective shipped cartridge, you must be able to trace back to every raw-material lot that went into it (so you can bracket a recall). Given a recalled raw-material lot, you must be able to trace forward to every cartridge that consumed it (so you know what to pull from inventory/field). This tab is the engineering-friendly window into that linkage.</p>

					<p class="mb-2"><strong>Why this matters (the engineering reason):</strong> Sometimes a yield drop is caused by <em>material lot variation</em> — a new lot arrives that's slightly different, and everything downstream wobbles. If you can line up a yield dip with a specific input lot, you've diagnosed the problem in minutes instead of weeks.</p>

					<p class="mb-2"><strong>How to read the columns:</strong></p>
					<ul class="ml-4 list-disc space-y-0.5">
						<li><strong>Barcode</strong> — the scanned ID of the incoming material lot (e.g. a receiving lot, a wax tube, a backing bucket).</li>
						<li><strong>Material</strong> — human-readable name.</li>
						<li><strong>Runs</strong> — how many manufacturing runs consumed from this lot.</li>
						<li><strong>Produced</strong> — total units made in those runs.</li>
						<li><strong>Scrapped</strong> — of those, how many were physically discarded.</li>
						<li><strong>Yield</strong> — (produced − scrapped) / produced. Quick health indicator per lot.</li>
					</ul>

					<p class="mt-2"><strong>Connects to:</strong> Low-yield lot → cross-check in Yield &amp; Failures (which reject codes spiked when this lot was running?). Suspicious lot → Manual Input event linking the lot to an investigation. Recall scenario → filter runs to "only runs that consumed lot X" and list every cartridge.</p>

					<p class="mt-2"><strong>Real-world use:</strong> When an assay fails in the field three months after shipping, this is the tab you start from. Trace forward from the suspected input lot to every cartridge made from it, then to every customer site.</p>
				</div>
			{/if}
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
			{#if trainingMode}
				<div class="rounded-lg border border-green-500/40 bg-green-950/10 p-4 text-xs leading-relaxed" style="color: var(--color-tron-text)">
					<h3 class="mb-2 text-sm font-semibold text-green-300">📚 Training — Compare Tab</h3>
					<p class="mb-2"><strong>What you're looking at:</strong> A statistical comparison of cycle time across operators and across robots, with a one-way ANOVA result telling you whether the differences are real or just noise.</p>

					<p class="mt-3 mb-1 font-semibold text-green-300">The core question:</p>
					<p class="mb-2">"Nick Fox's average run is 54 min; Alejandro Hernandez's is 59 min. Is he actually slower, or is that just random variation in 30 runs?" ANOVA answers this rigorously.</p>

					<p class="mt-3 mb-1 font-semibold text-green-300">ANOVA — Analysis of Variance</p>
					<p class="mb-1">Despite the name, ANOVA compares <em>means</em> of multiple groups. Intuition:</p>
					<ul class="ml-4 list-disc space-y-0.5">
						<li><strong>If groups are the same:</strong> variation between group means ≈ variation within each group. Ratio ≈ 1.</li>
						<li><strong>If groups really differ:</strong> variation between group means &gt;&gt; variation within each group. Ratio &gt;&gt; 1.</li>
						<li>That ratio is the <strong>F-statistic</strong>.</li>
					</ul>

					<p class="mt-2 mb-1 font-semibold text-green-300">Reading the output:</p>
					<ul class="ml-4 list-disc space-y-0.5">
						<li><strong>F</strong> — the test statistic (bigger = more evidence groups differ).</li>
						<li><strong>df</strong> — degrees of freedom, two numbers: between-group (# groups − 1) and within-group (total n − # groups).</li>
						<li><strong>p-value</strong> — probability of seeing an F this big by chance if all groups were truly identical.</li>
						<li><strong>α = 0.05 convention</strong> — if p &lt; 0.05, we reject the "no difference" hypothesis. "Statistically significant."</li>
						<li><strong>Important:</strong> "significant" ≠ "big." With enough data, tiny differences become significant. Always look at the actual means + spreads in context.</li>
					</ul>

					<p class="mt-3 mb-1 font-semibold text-green-300">Common pitfalls</p>
					<ul class="ml-4 list-disc space-y-0.5">
						<li><strong>Small n per group</strong> — with 2-3 runs per operator the test can't reliably detect anything. Aim for ≥ 10 per group.</li>
						<li><strong>ANOVA assumes roughly normal data with similar variances.</strong> Heavy skew or one group with wildly different spread → consider Kruskal-Wallis (non-parametric) instead.</li>
						<li><strong>Significant ≠ caused by.</strong> Operators may differ because they work different shifts, on different robots. Confounding.</li>
					</ul>

					<p class="mt-3"><strong>Connects to:</strong> Significant operator difference → check Manual Input for training records. Significant robot difference → SPC Alerts may have flagged the slower robot. Either way → decide if it's a fix target.</p>
					<p class="mt-2"><strong>Real-world use:</strong> Before blaming a person, check the stats. Operator-to-operator variation is often explained by training level, shift, or workstation assignment — not skill. This tab helps you separate signal from story.</p>
				</div>
			{/if}
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
			{#if trainingMode}
				<div class="rounded-lg border border-green-500/40 bg-green-950/10 p-4 text-xs leading-relaxed" style="color: var(--color-tron-text)">
					<h3 class="mb-2 text-sm font-semibold text-green-300">📚 Training — SPC Alerts Tab</h3>
					<p class="mb-2"><strong>What you're looking at:</strong> The automated watchdog. Whenever a Nelson rule trips on any control chart across the factory, a signal is automatically opened here. Think of it as the "check engine light" for the process.</p>

					<p class="mt-3 mb-1 font-semibold text-green-300">The 8 Nelson rules (the rule numbers in the table)</p>
					<p class="mb-1">Each rule is a pattern that's statistically rare if the process is truly stable. Seeing any one = investigate.</p>
					<ul class="ml-4 list-disc space-y-0.5">
						<li><strong>Rule 1</strong> — 1 point beyond 3σ. The obvious one: a big jump.</li>
						<li><strong>Rule 2</strong> — 9 consecutive points on the same side of the centerline. A sustained shift, even if small.</li>
						<li><strong>Rule 3</strong> — 6 points trending up or down. A drift — sensor aging, tooling wear.</li>
						<li><strong>Rule 4</strong> — 14 points alternating up/down. Often indicates two processes mixed (shift effect, sample-swap bug).</li>
						<li><strong>Rule 5</strong> — 2 of 3 points beyond 2σ on the same side. Near-miss cluster.</li>
						<li><strong>Rule 6</strong> — 4 of 5 points beyond 1σ on the same side. Slower shift than rule 2 would catch.</li>
						<li><strong>Rule 7</strong> — 15 points within 1σ. Suspicious — either the process truly tightened (check gage R&amp;R) or someone is filtering data.</li>
						<li><strong>Rule 8</strong> — 8 points outside 1σ (both sides). Mixture — indicates sub-populations with different means.</li>
					</ul>

					<p class="mt-3 mb-1 font-semibold text-green-300">The signal workflow</p>
					<ol class="ml-4 list-decimal space-y-0.5">
						<li><strong>Open</strong> — just detected. Nobody has looked at it yet.</li>
						<li><strong>Acknowledged</strong> — someone saw it and took ownership. Click "Ack."</li>
						<li><strong>Investigating</strong> — root cause work in progress.</li>
						<li><strong>Closed</strong> — root cause identified, corrective action taken, verification planned. Click "Close" and enter root cause + corrective action (both required — regulatory trace).</li>
						<li><strong>Dismissed</strong> (admin only) — the signal was a false alarm or duplicate. Must supply a dismiss reason.</li>
					</ol>

					<p class="mt-3 mb-1 font-semibold text-green-300">Common cause vs. special cause (again)</p>
					<p class="mb-1">This tab ONLY surfaces special-cause events. If you're seeing a lot of them and all chase down to "variation was always this wide" — your control limits are too tight (sample was small when limits were set). If you're seeing very few signals but yield is poor — you have a lot of common-cause variation; the process itself needs improvement, no amount of special-cause-chasing will fix it.</p>

					<p class="mt-3"><strong>Connects to:</strong> Open signal → look at the Cycle Time tab for the referenced process to see the offending point on the chart. Root cause → feed into FMEA (update occurrence score). Closed signal → references become part of the compliance record (21 CFR 820.250).</p>
					<p class="mt-2"><strong>Real-world use:</strong> Treat open + acknowledged signals like open bug tickets. Daily triage. Close with real root cause and corrective action — don't rubber-stamp close, because the accumulated evidence is what you'll cite in an audit.</p>
				</div>
			{/if}
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
			{#if trainingMode}
				<div class="rounded-lg border border-green-500/40 bg-green-950/10 p-4 text-xs leading-relaxed" style="color: var(--color-tron-text)">
					<h3 class="mb-2 text-sm font-semibold text-green-300">📚 Training — FMEA Tab</h3>
					<p class="mb-2"><strong>What you're looking at:</strong> A living register of "things that could go wrong with this process" — each with a risk score (RPN). Unlike the other tabs (which are reactive — analyzing what already happened), FMEA is <em>prospective</em>. It asks: before anything goes wrong, what's most at risk, and what are we doing about it?</p>

					<p class="mt-3 mb-1 font-semibold text-green-300">FMEA = Failure Mode and Effects Analysis</p>
					<p class="mb-1">Developed by NASA in the 1960s for Apollo. Now standard in medical devices (ISO 14971), automotive (AIAG-VDA), aerospace, and food. Every row is a <strong>failure mode</strong> — one specific way a process step could produce a bad outcome.</p>

					<p class="mt-3 mb-1 font-semibold text-green-300">The three scores (1–10 each, multiplied together = RPN)</p>
					<ul class="ml-4 list-disc space-y-1">
						<li><strong>Severity (S)</strong> — if this failure <em>does</em> happen, how bad is it? 1 = barely noticeable, 10 = safety incident / customer harm / regulatory impact. Severity does NOT change based on how often it happens.</li>
						<li><strong>Occurrence (O)</strong> — how often does this failure happen? 1 = once in 10+ years, 10 = every run. Use historical data if available.</li>
						<li><strong>Detection (D)</strong> — if it happens, how likely are current controls to catch it before it reaches the customer? <strong>1 = almost certain to catch; 10 = almost certainly ships.</strong> Note this is inverted from intuition — high detection score is bad.</li>
					</ul>

					<p class="mt-3 mb-1 font-semibold text-green-300">RPN = S × O × D</p>
					<p class="mb-1">Ranges 1 to 1000. The table sorts descending by RPN. <strong>Conventional action thresholds:</strong></p>
					<ul class="ml-4 list-disc space-y-0.5">
						<li><strong>RPN ≥ 200</strong> — high risk, action required with documented plan and due date.</li>
						<li><strong>RPN 100–199</strong> — moderate risk, action strongly recommended.</li>
						<li><strong>RPN &lt; 100</strong> — acceptable, but review annually.</li>
					</ul>
					<p class="mt-1"><strong>Watch out — RPN can hide severity.</strong> A score of S=10, O=1, D=2 gives RPN=20 but is a safety failure that ships if it happens. Many modern FMEAs use a "Critical" flag for any row with S=9 or S=10, regardless of RPN.</p>

					<p class="mt-3 mb-1 font-semibold text-green-300">Classification (Safety / Quality / Compliance / Productivity)</p>
					<p class="mb-1">Flag the type of risk. Safety rows go to regulatory review even at low RPN. Productivity rows can wait. Lets you filter the register by what matters to whom.</p>

					<p class="mt-3 mb-1 font-semibold text-green-300">How FMEA drives action</p>
					<p class="mb-1">High RPN → pick one of: (a) reduce Severity (redesign to eliminate the mode — expensive), (b) reduce Occurrence (fix the root cause so it doesn't happen — usually the target), (c) reduce Detection (add an inspection / sensor / automated check — cheaper, catches it but doesn't prevent it).</p>

					<p class="mt-3"><strong>Connects to:</strong> Top Pareto bar (Yield &amp; Failures) → new FMEA entry. Closed SPC signal with a new root cause → update FMEA occurrence. Cause-effect diagram findings → FMEA rows.</p>
					<p class="mt-2"><strong>Real-world use:</strong> Quarterly review cadence. Team walks through every high-RPN row, decides if action is on track. New failure mode observed in the field → add to FMEA with high Detection score (we didn't catch it) and work from there.</p>
				</div>
			{/if}
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
			{#if trainingMode}
				<div class="rounded-lg border border-green-500/40 bg-green-950/10 p-4 text-xs leading-relaxed" style="color: var(--color-tron-text)">
					<h3 class="mb-2 text-sm font-semibold text-green-300">📚 Training — Manual Input Tab</h3>
					<p class="mb-2"><strong>What you're looking at:</strong> A structured way to log anything that doesn't come from a sensor. Sensors tell you cycle times, counts, weights. Humans tell you everything else — and humans still notice the most important stuff.</p>

					<p class="mt-3 mb-1 font-semibold text-green-300">The event types — when to use each</p>
					<ul class="ml-4 list-disc space-y-1">
						<li><strong>Observation</strong> — anything noticed in passing. Low-stakes capture.</li>
						<li><strong>Deviation</strong> — something went outside procedure. Regulatory: must be captured with severity.</li>
						<li><strong>Environmental</strong> — ambient conditions (humidity, temp, vibration). Used for correlation studies.</li>
						<li><strong>MSA Measurement</strong> — repeated measurements for a Gage R&amp;R or calibration study. Use the numeric value + unit.</li>
						<li><strong>Corrective Action</strong> — the fix for a specific problem. Links to root cause.</li>
						<li><strong>Preventive Action</strong> — change made to avoid a potential problem before it happens.</li>
						<li><strong>Training</strong> — operator training event. Critical for regulatory records.</li>
						<li><strong>Calibration</strong> — equipment calibration record (complements the Calibration module).</li>
						<li><strong>Maintenance</strong> — PM event on a piece of equipment.</li>
						<li><strong>Visual Defect</strong> — a defect someone spotted but isn't in the automated count. Often gets a rejection code.</li>
						<li><strong>Rework</strong> — a unit that was repaired / reprocessed.</li>
					</ul>

					<p class="mt-3 mb-1 font-semibold text-green-300">Linking (why the "Linked run / lot / equipment" fields matter)</p>
					<p class="mb-1">A standalone note is worth less than a note tied to a specific run ID, material lot, or machine. The links are what let you later pull up "everything that happened to lot X" or "every event on Robot 4" in one filter.</p>

					<p class="mt-3 mb-1 font-semibold text-green-300">Numeric vs. Categorical values</p>
					<ul class="ml-4 list-disc space-y-0.5">
						<li><strong>Numeric</strong> (with unit) — for measurements you'll later analyze statistically. "Wax bead height = 2.35 mm." 20 of these from one operator is a Gage R&amp;R dataset.</li>
						<li><strong>Categorical</strong> — for pass/fail, severity, named states. Useful for filtering.</li>
						<li>Leave either blank if the event is just a note.</li>
					</ul>

					<p class="mt-3 mb-1 font-semibold text-green-300">Severity (Minor / Major / Critical)</p>
					<p class="mb-1">Only required for deviations. Maps to regulatory escalation — Critical events often must be reported to QA within 24 hours.</p>

					<p class="mt-3"><strong>Connects to:</strong> Every event writes an AuditLog row (compliance trace). Events tagged with rejection codes show up in the Yield &amp; Failures Pareto. MSA events feed eventual Gage R&amp;R analysis (Phase 3). Linked events surface on the relevant run / lot / equipment detail pages.</p>
					<p class="mt-2"><strong>Real-world use:</strong> This is your factory's shared notebook. Every operator, every shift, every walk-through → a few taps capture the observation. In an audit, this log is worth its weight in gold.</p>
				</div>
			{/if}
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
			{#if trainingMode}
				<div class="rounded-lg border border-green-500/40 bg-green-950/10 p-4 text-xs leading-relaxed" style="color: var(--color-tron-text)">
					<h3 class="mb-2 text-sm font-semibold text-green-300">📚 Training — All Runs Tab</h3>
					<p class="mb-2"><strong>What you're looking at:</strong> The raw data. Every run in the filter window, flat. One row per run, sortable and exportable.</p>
					<p class="mb-2"><strong>Why this tab exists:</strong> Every other tab is an aggregated view. Eventually you need to spot-check — "which specific run produced that outlier point?" This tab is the ground truth you drill down to.</p>
					<p class="mb-2"><strong>Filtering:</strong> Uses the global filter bar at the top. Change dates, processes, operators, robots, shifts — this table updates.</p>
					<p class="mb-2"><strong>Export:</strong> CSV button dumps the currently-filtered set into a spreadsheet. Great for Minitab / Excel / pandas.</p>
					<p class="mb-2"><strong>The important columns:</strong></p>
					<ul class="ml-4 list-disc space-y-0.5">
						<li><strong>Cycle(min)</strong> — this is the number that drives the I-MR chart.</li>
						<li><strong>Planned vs Actual</strong> — gap indicates mid-run scrap or abort.</li>
						<li><strong>Accept / Reject / Scrap</strong> — feeds FPY + Pareto.</li>
						<li><strong>Shift</strong> — derived from start time. Shifts often explain unexpected patterns.</li>
					</ul>
					<p class="mt-2"><strong>Connects to:</strong> Everything. This IS the data behind every chart on every other tab.</p>
					<p class="mt-2"><strong>Real-world use:</strong> "The I-MR chart flagged a weird point on Tuesday. Which run was that?" → filter by date → scan the table. You can also use this as an operations log to see what each shift produced.</p>
				</div>
			{/if}
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
			{#if trainingMode}
				<div class="rounded-lg border border-green-500/40 bg-green-950/10 p-4 text-xs leading-relaxed" style="color: var(--color-tron-text)">
					<h3 class="mb-2 text-sm font-semibold text-green-300">📚 Training — Reports &amp; Export Tab</h3>
					<p class="mb-2"><strong>What you're looking at:</strong> One-click CSV dumps of every dataset on the page. Column names are stable, so saved Minitab / JMP / Excel analysis workbooks keep working across exports.</p>

					<p class="mt-3 mb-1 font-semibold text-green-300">Why a process engineer exports data</p>
					<ul class="ml-4 list-disc space-y-0.5">
						<li><strong>Specialized stats</strong> — Minitab and JMP do capability studies, DOE analysis, and Gage R&amp;R with more bells and whistles than this page.</li>
						<li><strong>Ad-hoc investigation</strong> — sometimes you want to ask a question the page doesn't answer ("runs with cycle time &gt;60 AND reject count &gt;2 AND operator Leandro Valdez"). SQL or Python on the CSV.</li>
						<li><strong>Regulatory submissions</strong> — FDA / ISO audits want the data behind the dashboard. CSV is the universal format.</li>
						<li><strong>Cross-site comparison</strong> — stack two CSVs from two facilities.</li>
					</ul>

					<p class="mt-3 mb-1 font-semibold text-green-300">Which export to use for what</p>
					<ul class="ml-4 list-disc space-y-0.5">
						<li><strong>All Runs</strong> — the big one. Starting point for any deep analysis.</li>
						<li><strong>Manual Events</strong> — the narrative log. Useful as a supporting doc in audits.</li>
						<li><strong>Pareto</strong> — already aggregated. Use for quarterly review slides.</li>
						<li><strong>FMEA</strong> — the risk register. Your QA team wants this monthly.</li>
						<li><strong>SPC Signals</strong> — the alert log. Useful for trend analysis ("are we catching more signals this month?").</li>
						<li><strong>Material Flow</strong> — lot traceability snapshot.</li>
					</ul>

					<p class="mt-3"><strong>Connects to:</strong> Every tab's data is exportable. The filter bar applies.</p>
					<p class="mt-2"><strong>Real-world use:</strong> End of quarter — export Pareto + FMEA + Runs. Load into Minitab. Run capability studies on the current cycle-time baseline (for spec-limit updates next quarter). Generate trend slides for the operations review.</p>
				</div>
			{/if}
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
			{#if trainingMode}
				<div class="rounded-lg border border-green-500/40 bg-green-950/10 p-4 text-xs leading-relaxed" style="color: var(--color-tron-text)">
					<h3 class="mb-2 text-sm font-semibold text-green-300">📚 Training — DOE Planner Tab</h3>
					<p class="mb-2"><strong>What you're looking at:</strong> A Design of Experiments (DOE) planner. Choose your factors, set their levels, pick replicates — the page generates a randomized run matrix you can use at the bench.</p>

					<p class="mt-3 mb-1 font-semibold text-green-300">What is DOE, and why not just change one thing at a time?</p>
					<p class="mb-1">The "intuitive" way to experiment is OFAT — One Factor At a Time. Try temperature 50 vs 60, pick the winner, then try humidity 30 vs 60 with that temperature. <strong>OFAT is statistically weak</strong> — it needs many runs, misses interactions, and the result depends on which factor you chose to test first.</p>
					<p class="mb-1"><strong>DOE varies multiple factors simultaneously</strong> in a planned way so you can, in few runs, measure:</p>
					<ul class="ml-4 list-disc space-y-0.5">
						<li><strong>Main effects</strong> — how much each factor shifts the response on its own.</li>
						<li><strong>Interactions</strong> — whether two factors matter more together than alone (e.g. "temp alone does nothing, humidity alone does nothing, but together they matter a lot").</li>
					</ul>

					<p class="mt-3 mb-1 font-semibold text-green-300">2^k Full Factorial — what the planner generates</p>
					<p class="mb-1">k factors, each with 2 levels (low, high) → 2^k runs covers every combination. So 3 factors = 8 runs. 5 factors = 32 runs. Grows fast, which is why <em>fractional</em> designs exist (Phase 3).</p>

					<p class="mt-3 mb-1 font-semibold text-green-300">Why randomize run order?</p>
					<p class="mb-1">If you run in standard order (all low-temp first, then all high-temp), and something drifts during the experiment (ambient cooling, operator fatigue, reagent aging), the drift gets <em>confounded</em> with your factor — you can't tell effect from drift. Randomizing spreads any drift across all factor levels, turning drift into noise instead of bias.</p>

					<p class="mt-3 mb-1 font-semibold text-green-300">Why replicates?</p>
					<p class="mb-1">Single run per condition gives you the effect estimate but no estimate of the noise. Replicates (doing each condition 2+ times) give you noise, which gives you p-values, which lets you say "the effect is real, not random."</p>

					<p class="mt-3"><strong>Connects to:</strong> Finished DOE responses go into Manual Input (numeric_value). Effects findings inform FMEA occurrence/detection scores. Spec limits (and hence Cp/Cpk) can be updated based on DOE-determined operating windows.</p>
					<p class="mt-2"><strong>Real-world use:</strong> When you have 3-5 knobs on a new process and don't know which matter — DOE. Factors for wax filling might be: temperature, tip dispense speed, pre-heat time, tube fill level. 4 factors at 2 levels = 16 runs. Two replicates = 32 total runs = about a day of robot time. In exchange you get a statistical model of which factors matter and the best operating point.</p>
					<p class="mt-2"><strong>Analysis not yet wired (Phase 3):</strong> Main-effects plot, interactions plot, standardized-effects Pareto, and response-surface designs (CCD, Box-Behnken) will land in a later phase. For now: export the run matrix, do the runs, capture responses via Manual Input, analyze externally in Minitab.</p>
				</div>
			{/if}
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
{/if}
