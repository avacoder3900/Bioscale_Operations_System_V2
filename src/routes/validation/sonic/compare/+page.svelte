<script lang="ts">
	import { goto } from '$app/navigation';
	import SonicChart, { type ChartMarker, type ChartSeries } from '$lib/components/validation/sonic/SonicChart.svelte';
	import { sonicColor } from '$lib/components/validation/sonic/palette';
	import SonicFleet from '$lib/components/validation/sonic/SonicFleet.svelte';

	let { data } = $props();

	const THIRD_OCT = Array.from({ length: 22 }, (_, k) => 100 * 2 ** (k / 3));
	const bandCenters = THIRD_OCT.slice(0, -1).map((lo, i) => Math.sqrt(lo * THIRD_OCT[i + 1]));

	// ── picker ────────────────────────────────────────────────────────────
	// The picker mirrors the URL. Seed it for SSR, then re-seed whenever the load data changes:
	// back/forward navigation reuses this component, so a mount-only seed goes stale.
	const urlPicked = (): Record<string, boolean> => Object.fromEntries(data.ids.map((id: string) => [id, true]));
	const urlSections = (): string => data.sections ?? '';
	const urlAgainst = (): boolean => data.againstRefs;
	const urlFleet = () => ({ ...data.fleetOpts });
	let picked = $state<Record<string, boolean>>(urlPicked());
	let sectionsText = $state(urlSections());
	let against = $state(urlAgainst());
	// Two views of the same picked recordings (2026-10-06): Fleet check (quick
	// triage, fits / outside per unit) and Detailed compare (sections, tone colour).
	const urlView = (): 'fleet' | 'detail' => data.view;
	let view = $state<'fleet' | 'detail'>(urlView());
	let fleetOpts = $state(urlFleet());
	$effect.pre(() => {
		picked = urlPicked();
		sectionsText = urlSections();
		against = urlAgainst();
		view = urlView();
		fleetOpts = urlFleet();
	});
	const minPicked = $derived(view === 'fleet' ? 3 : against ? 1 : 2);
	function setView(v: 'fleet' | 'detail') {
		view = v;
		// Same recordings, other view — re-run straight away when there are enough.
		if (pickedIds.length >= (v === 'fleet' ? 3 : against ? 1 : 2)) run();
	}
	let pickerAssay = $state('ALL');
	const pickedIds = $derived(Object.keys(picked).filter((k) => picked[k]));
	const pickerRows = $derived(data.available.filter((a: { assay: string | null }) => pickerAssay === 'ALL' || (a.assay ?? 'UNKNOWN') === pickerAssay));

	/** One row per SPU: its recordings newest first (data.available is already newest first). */
	const spuGroups = $derived.by(() => {
		const m = new Map<string, { udi: string; short: string; recs: typeof pickerRows }>();
		for (const a of pickerRows) {
			const g = m.get(a.spuUdi) ?? { udi: a.spuUdi, short: a.short, recs: [] };
			g.recs.push(a);
			m.set(a.spuUdi, g);
		}
		return [...m.values()].sort((a, b) => a.short.localeCompare(b.short, undefined, { numeric: true }));
	});
	const spuPicked = (g: { recs: { id: string }[] }) => g.recs.some((r) => picked[r.id]);
	/** Ticking an SPU picks its latest recording; unticking drops every recording of it. */
	function toggleSpu(g: { recs: { id: string }[] }) {
		const next = { ...picked };
		if (spuPicked(g)) for (const r of g.recs) delete next[r.id];
		else next[g.recs[0].id] = true;
		picked = next;
	}
	function pickAllSpus() {
		const next = { ...picked };
		for (const g of spuGroups) if (!spuPicked(g)) next[g.recs[0].id] = true;
		picked = next;
	}

	let copied = $state(false);
	async function copyLink() {
		try {
			await navigator.clipboard.writeText(location.href);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			/* clipboard blocked — the address bar has the same link */
		}
	}

	function run() {
		const q = new URLSearchParams();
		q.set('view', view);
		q.set('ids', pickedIds.join(','));
		if (view === 'fleet') {
			q.set('metric', fleetOpts.metric);
			q.set('interval', String(fleetOpts.intervalS));
			q.set('k', String(fleetOpts.k));
			q.set('min', String(fleetOpts.minInsidePct));
			q.set('shape', fleetOpts.shapeOnly ? '1' : '0');
		} else {
			if (sectionsText.trim()) q.set('sections', sectionsText.trim());
			if (against) q.set('against', 'reference');
		}
		goto(`/validation/sonic/compare?${q.toString()}`);
	}

	// ── result ────────────────────────────────────────────────────────────
	const R = $derived(data.result);
	const n = $derived(R?.items.length ?? 0);
	const color = (i: number) => sonicColor(i);
	const vsIdx = $derived(R ? (R.mode === 'reference' ? R.items.map((_: unknown, i: number) => i).slice(1) : R.items.map((_: unknown, i: number) => i)) : []);
	const phaseSections = $derived(R ? R.phases.map(([a, b]: [number, number], p: number) => ({ name: `P${p + 1}`, a, b })) : []);
	const hasScores = $derived(R ? R.scores.some((row: unknown[]) => row.some((s) => s)) : false);

	// ── show / hide + hover focus (charts only; nothing is recomputed) ───
	let hidden = $state<Record<string, boolean>>({});
	let focusId = $state<string | null>(null);
	const shown = (i: number) => !!R && !hidden[R.items[i].id];
	const focusLabel = $derived(R && focusId ? (R.items.find((it: { id: string }) => it.id === focusId)?.label ?? null) : null);
	const setAll = (on: boolean) => {
		hidden = on ? {} : Object.fromEntries((R?.items ?? []).map((it: { id: string }) => [it.id, true]));
	};
	const passCount = (i: number) => (R ? R.scores[i].filter((s: { pass: boolean } | null) => s?.pass).length : 0);
	const scoredCount = (i: number) => (R ? R.scores[i].filter((s: unknown) => s).length : 0);
	/** Scorecard rows: most sections passed first, like the report. */
	const scoreOrder = $derived(R ? R.items.map((_: unknown, i: number) => i).sort((a: number, b: number) => passCount(b) - passCount(a)) : []);

	// ── key findings, generated from the comparison ──────────────────────
	type Finding = { kind: 'fail' | 'warn' | 'ok'; title: string; text: string };
	const findings = $derived.by((): Finding[] => {
		if (!R) return [];
		const out: Finding[] = [];
		const idx: number[] = vsIdx;
		const label = (i: number) => R.items[i].label as string;
		if (hasScores) {
			const scored = idx.filter((i) => scoredCount(i) > 0);
			const worst = [...scored].sort((a, b) => passCount(a) / scoredCount(a) - passCount(b) / scoredCount(b))[0];
			if (worst != null && passCount(worst) < scoredCount(worst)) {
				const tone = R.tones[worst]?.[0] as [number, number] | undefined;
				const shape = R.sim[worst]?.avgShape as number | null;
				const bits = [
					shape != null ? `sound shape differs by ${shape.toFixed(1)} dB on average` : null,
					tone ? `strongest extra tone ${tone[0].toLocaleString()} Hz (+${tone[1]} dB over the others)` : null
				].filter(Boolean);
				out.push({
					kind: 'fail',
					title: `${label(worst)} — ${passCount(worst)} of ${scoredCount(worst)} sections`,
					text: `Clearest outlier in this set${bits.length ? `: ${bits.join('; ')}` : ''}.`
				});
			}
			const clean = scored.filter((i) => passCount(i) === scoredCount(i));
			if (clean.length) {
				out.push({
					kind: 'ok',
					title: `${clean.map(label).join(', ')} — all sections`,
					text: `${clean.length === 1 ? 'Sits' : 'These sit'} inside the ${R.scoredAgainst === 'references' ? 'reference' : 'group'} band in every section judged.`
				});
			}
		}
		// Motor pitch: lowest / highest, and families (sorted typical Hz, split on a > 10 % jump).
		const hz = idx
			.map((i) => ({ i, hz: R.sim[i]?.medianHz as number | null }))
			.filter((r): r is { i: number; hz: number } => r.hz != null)
			.sort((a, b) => a.hz - b.hz);
		if (hz.length >= 2) {
			const fam: { i: number; hz: number }[][] = [[hz[0]]];
			for (let k = 1; k < hz.length; k++) {
				if (hz[k].hz / hz[k - 1].hz > 1.1) fam.push([]);
				fam[fam.length - 1].push(hz[k]);
			}
			const lo = hz[0];
			const hi = hz[hz.length - 1];
			out.push({
				kind: 'warn',
				title: `Pitch ${lo.hz}–${hi.hz} Hz`,
				text: `Lowest motor pitch ${label(lo.i)} (~${lo.hz} Hz), highest ${label(hi.i)} (~${hi.hz} Hz).`
			});
			if (fam.length > 1 && fam.length < hz.length) {
				const rng = (f: { hz: number }[]) => (f[0].hz === f[f.length - 1].hz ? `~${f[0].hz} Hz` : `~${f[0].hz}–${f[f.length - 1].hz} Hz`);
				out.push({
					kind: 'warn',
					title: `${fam.length} pitch families`,
					text: `${fam.map((f) => `${rng(f)} (${f.map((r) => label(r.i).replace(/^SPU /, '')).join(', ')})`).join(' · ')}. Worth checking against build records.`
				});
			}
		}
		return out;
	});

	// ── summary sort ─────────────────────────────────────────────────────
	type SortKey = 'label' | 'medianHz' | 'avgAbsPct' | 'matchPct' | 'avgAbsLvl' | 'avgShape' | 'peakDb' | 'minDb';
	let sortKey = $state<SortKey>('avgShape');
	let sortDir = $state<1 | -1>(-1);
	function sortBy(k: SortKey) {
		sortDir = k === sortKey ? (-sortDir as 1 | -1) : -1;
		sortKey = k;
	}
	const summaryOrder = $derived.by(() => {
		if (!R) return [] as number[];
		const val = (i: number): number | string | null => (sortKey === 'label' ? R.items[i].label : R.sim[i][sortKey]);
		return R.items
			.map((_: unknown, i: number) => i)
			.sort((a: number, b: number) => {
				const va = val(a);
				const vb = val(b);
				if (va == null) return 1;
				if (vb == null) return -1;
				return (va > vb ? 1 : va < vb ? -1 : 0) * sortDir;
			});
	});

	let gridTab = $state<'hz' | 'db' | 'pattern'>('hz');
	const GRID_TABS: [typeof gridTab, string][] = [['hz', 'Typical frequency (Hz)'], ['db', 'Average loudness (dBFS)'], ['pattern', 'Loudness pattern']];

	/** Per phase: the SPU with the highest (▲) and lowest (▼) value of `key`. */
	function phaseMarkers(key: 'hz' | 'avgDb', fmt: (v: number) => string): ChartMarker[] {
		if (!R) return [];
		const out: ChartMarker[] = [];
		R.phases.forEach(([a, b]: [number, number], p: number) => {
			const vals = R.pstats.map((row: { hz: number | null; avgDb: number | null }[]) => row[p][key]);
			const idx = vals.map((v: number | null, i: number) => [v, i] as const).filter(([v, i]: readonly [number | null, number]) => v != null && shown(i)) as [number, number][];
			if (idx.length < 2) return;
			const hi = idx.reduce((m, x) => (x[0] > m[0] ? x : m));
			const lo = idx.reduce((m, x) => (x[0] < m[0] ? x : m));
			const mid = (a + b) / 2;
			out.push({ x: mid, v: hi[0], side: 1, color: color(hi[1]), text: `${R.items[hi[1]].label}\n${fmt(hi[0])}` });
			if (lo[1] !== hi[1]) out.push({ x: mid, v: lo[0], side: -1, color: color(lo[1]), text: `${R.items[lo[1]].label}\n${fmt(lo[0])}` });
		});
		return out;
	}

	const freqSeries = $derived<ChartSeries[]>(
		R ? R.items.flatMap((it: { label: string }, i: number) => (shown(i) ? [{ label: it.label, color: color(i), values: R.series[i].domHz, width: 2 }] : [])) : []
	);
	const freqMarkers = $derived<ChartMarker[]>(
		!R
			? []
			: n <= 2
				? R.extremes.flatMap((row: [number, number, string][], i: number) =>
						(shown(i) ? row : []).map(([x, v, kind]) => ({ x, v, side: (kind === 'peak' ? 1 : -1) as 1 | -1, color: color(i), text: `${v} Hz` }))
					)
				: phaseMarkers('hz', (v) => `${Math.round(v)} Hz`)
	);
	const loudSeries = $derived<ChartSeries[]>(
		R ? R.items.flatMap((it: { label: string }, i: number) => (shown(i) ? [{ label: it.label, color: color(i), values: R.series[i].levelSmooth, width: 1.8 }] : [])) : []
	);
	const loudMarkers = $derived<ChartMarker[]>(phaseMarkers('avgDb', (v) => `${v.toFixed(1)} dB`));

	const diff = (key: 'dHz' | 'dLvl' | 'shapeDb'): ChartSeries[] =>
		R ? vsIdx.filter((i: number) => shown(i)).map((i: number) => ({ label: R.items[i].label, color: color(i), values: R.sim[i][key], width: 1.4 })) : [];

	// Phase grids: value + difference from the group median (or from the first SPU when there are two).
	function grid(key: 'hz' | 'avgDb', pattern = false) {
		if (!R) return { rows: [] as { v: (number | null)[]; d: (number | null)[] }[], lim: 1 };
		const M: (number | null)[][] = R.pstats.map((row: { hz: number | null; avgDb: number | null }[]) => row.map((p) => p[key]));
		const cols = R.phases.length;
		const base = Array.from({ length: cols }, (_, p) => {
			if (R.mode === 'reference') return M[0][p];
			const v = M.map((r) => r[p]).filter((x): x is number => x != null).sort((a, b) => a - b);
			return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null;
		});
		let D = M.map((r) => r.map((v, p) => (v == null || base[p] == null ? null : v - base[p]!)));
		if (pattern) {
			D = D.map((r) => {
				const s = r.filter((x): x is number => x != null).sort((a, b) => a - b);
				const med = s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
				return r.map((x) => (x == null ? null : x - med));
			});
		}
		const lim = Math.max(pattern ? 2 : key === 'hz' ? 30 : 3, ...D.flat().filter((x): x is number => x != null).map(Math.abs));
		return { rows: M.map((v, i) => ({ v, d: D[i] })), lim };
	}
	const hzGrid = $derived(grid('hz'));
	const dbGrid = $derived(grid('avgDb'));
	const patGrid = $derived(grid('avgDb', true));

	function cellBg(d: number | null, lim: number) {
		if (d == null) return 'transparent';
		const a = Math.min(Math.abs(d) / lim, 1) * 0.75;
		return d >= 0 ? `rgba(248,113,113,${a})` : `rgba(96,165,250,${a})`;
	}
	function scoreBg(s: { loudIn: number; specIn: number; pass: boolean } | null) {
		if (!s) return 'transparent';
		const worst = Math.min(s.loudIn, s.specIn);
		return worst >= data.passPct ? 'rgba(74,222,128,0.25)' : worst >= 75 ? 'rgba(250,204,21,0.3)' : 'rgba(248,113,113,0.35)';
	}

	/** RFC 4180 cell: quote anything with a comma, quote or newline (labels and file names can). */
	const csv = (v: string | number) => {
		const s = String(v);
		return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
	};

	function downloadCsv() {
		if (!R) return;
		const lines: string[] = [];
		// Score columns follow R.envelopes — the scores are indexed by envelope, not by section.
		lines.push(['SPU', 'file', ...R.envelopes.flatMap((s: { name: string; a: number; b: number }) => [`${s.name} ${s.a}-${s.b}s loudness %`, `${s.name} tone %`, `${s.name} result`])].map(csv).join(','));
		R.items.forEach((it: { label: string; fileName: string | null }, i: number) => {
			const cells = R.scores[i].flatMap((s: { loudIn: number; specIn: number; pass: boolean } | null) => (s ? [s.loudIn, s.specIn, s.pass ? 'PASS' : 'CHECK'] : ['', '', 'n/a']));
			lines.push([it.label, it.fileName ?? '', ...cells].map(csv).join(','));
		});
		lines.push('');
		lines.push(['phase', 'start_s', 'end_s', ...R.items.flatMap((it: { label: string }) => [`${it.label} avg dBFS`, `${it.label} Hz`])].map(csv).join(','));
		R.phases.forEach(([a, b]: [number, number], p: number) => {
			lines.push([`P${p + 1}`, a ?? '', b ?? '', ...R.pstats.flatMap((row: { avgDb: number | null; hz: number | null }[]) => [row[p]?.avgDb ?? '', row[p]?.hz ?? ''])].map(csv).join(','));
		});
		const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
		const a = document.createElement('a');
		const href = URL.createObjectURL(blob);
		a.href = href;
		a.download = `sonic-compare-${new Date().toISOString().slice(0, 10)}.csv`;
		document.body.appendChild(a);
		a.click();
		a.remove();
		// Revoking synchronously can cancel the download in Firefox/Safari.
		setTimeout(() => URL.revokeObjectURL(href), 1000);
	}

	const fmt = (v: number | null | undefined, d = 1) => (v == null ? '—' : v.toFixed(d));
</script>

{#snippet th(k: SortKey, name: string, cls = 'px-2')}
	<th class="{cls} cursor-pointer select-none hover:text-[var(--color-tron-text-primary)]" onclick={() => sortBy(k)} aria-sort={sortKey === k ? (sortDir > 0 ? 'ascending' : 'descending') : 'none'}>
		{name}{sortKey === k ? (sortDir > 0 ? ' ▲' : ' ▼') : ''}
	</th>
{/snippet}

<div class="space-y-6">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<h1 class="tron-heading text-2xl font-bold">Sonic Compare</h1>
			<div class="mt-2 inline-flex rounded-lg border border-[var(--color-tron-border)] p-1" role="group" aria-label="Comparison view">
				{#each [['fleet', 'Fleet check'], ['detail', 'Detailed compare']] as [v, name] (v)}
					<button
						type="button"
						aria-pressed={view === v}
						onclick={() => setView(v as 'fleet' | 'detail')}
						class="rounded-md px-4 text-sm font-semibold {view === v ? 'bg-[var(--color-tron-cyan)] text-[var(--color-tron-bg-primary)]' : 'tron-text-muted hover:text-[var(--color-tron-cyan)]'}"
						style="min-height: 40px;"
					>{name}</button>
				{/each}
			</div>
			<p class="tron-text-muted mt-2 max-w-3xl text-sm">
				{#if view === 'fleet'}
					<strong>Which units are odd?</strong> The run is cut into fixed intervals; in each one the fleet's mean and standard
					deviation make a band, and each unit fits or falls outside it. Quick triage — then switch to Detailed compare to see what differs.
				{:else}
					<strong>How and where is it different?</strong> Recordings are lined up in time, cut into sections (P = operating phase,
					B = the stretch between phases, or your own), and each SPU is judged on loudness shape and tone colour against the
					others' average ± {data.envelopeK}σ — or against the reference set of its assay.
				{/if}
			</p>
		</div>
		<a href="/validation/sonic" class="inline-flex items-center text-sm text-[var(--color-tron-cyan)] hover:underline" style="min-height: 44px;">← Recordings</a>
	</div>

	<!-- picker -->
	<div class="tron-card space-y-3 p-4">
		<div class="flex flex-wrap items-center gap-3">
			<h2 class="tron-heading text-sm font-semibold uppercase tracking-wide">Recordings to compare ({pickedIds.length})</h2>
			<select bind:value={pickerAssay} aria-label="Filter recordings by assay" class="tron-select text-sm" style="min-height: 44px;">
				<option value="ALL">All assays</option>
				<option value="SONIC">SONIC</option>
				<option value="BCODE">BCODE</option>
				<option value="OTHER">OTHER</option>
				<option value="UNKNOWN">Assay not set</option>
			</select>
		</div>
		<div class="flex flex-wrap gap-2">
			{#each spuGroups as g (g.udi)}
				<button
					type="button"
					onclick={() => toggleSpu(g)}
					aria-pressed={spuPicked(g)}
					title={`${g.udi} — ${g.recs.length} recording${g.recs.length === 1 ? '' : 's'}; picks the latest`}
					class="rounded-full border px-3 font-mono text-sm {spuPicked(g)
						? 'border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/15 text-[var(--color-tron-cyan)]'
						: 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]'}"
					style="min-height: 40px;"
				>
					{g.short}{#if g.recs.some((r: { reference: boolean }) => r.reference)}<span class="ml-1 text-[var(--color-tron-orange)]">★</span>{/if}
				</button>
			{:else}
				<p class="tron-text-muted text-sm">No analyzed recordings yet — upload on the Recordings page; they are analyzed automatically.</p>
			{/each}
		</div>
		{#if spuGroups.length}
			<div class="flex flex-wrap gap-2 text-sm">
				<button type="button" onclick={pickAllSpus} class="rounded border border-[var(--color-tron-border)] px-3" style="min-height: 40px;">All SPUs</button>
				<button type="button" onclick={() => (picked = {})} class="rounded border border-[var(--color-tron-border)] px-3" style="min-height: 40px;">Clear</button>
			</div>
		{/if}
		<details class="text-sm">
			<summary class="tron-text-muted cursor-pointer" style="min-height: 32px;">Pick individual recordings (e.g. two runs of the same SPU)</summary>
		<div class="mt-2 grid max-h-56 grid-cols-1 gap-1 overflow-y-auto text-sm md:grid-cols-2 lg:grid-cols-3">
			{#each pickerRows as a (a.id)}
				<label class="flex items-center gap-2 rounded px-2 py-1 hover:bg-[var(--color-tron-bg-tertiary)]" style="min-height: 44px;">
					<input type="checkbox" bind:checked={picked[a.id]} class="h-4 w-4" />
					<span class="font-mono font-bold">{a.spuUdi}</span>
					{#if a.reference}<span class="text-[var(--color-tron-orange)]" title="reference">★</span>{/if}
					<span class="tron-text-muted text-xs">{a.assay ?? 'assay?'} · {a.at ? new Date(a.at).toLocaleDateString() : ''} · {a.fileName ?? ''}</span>
				</label>
			{:else}
				<p class="tron-text-muted">No analyzed recordings yet.</p>
			{/each}
		</div>
		</details>
		<div class="flex flex-wrap items-end gap-3">
			{#if view === 'fleet'}
			<label class="text-sm">
				<span class="tron-label">Compare</span>
				<select bind:value={fleetOpts.metric} class="tron-select" style="min-height: 44px;">
					{#each data.metrics as m (m.key)}<option value={m.key}>{m.label} ({m.unit})</option>{/each}
				</select>
			</label>
			<label class="text-sm">
				<span class="tron-label">Interval (s)</span>
				<input type="number" min="1" max="120" step="1" bind:value={fleetOpts.intervalS} class="tron-input w-24" style="min-height: 44px;" />
			</label>
			<label class="text-sm">
				<span class="tron-label">Band (K·σ)</span>
				<input type="number" min="0.5" max="4" step="0.5" bind:value={fleetOpts.k} class="tron-input w-24" style="min-height: 44px;" />
			</label>
			<label class="text-sm">
				<span class="tron-label">Fits if ≥ % inside</span>
				<input type="number" min="0" max="100" step="5" bind:value={fleetOpts.minInsidePct} class="tron-input w-24" style="min-height: 44px;" />
			</label>
			{#if fleetOpts.metric === 'loudness'}
				<label class="flex items-center gap-2 text-sm" style="min-height: 44px;" title="Removes each recording's overall level, so a phone held closer or farther does not count">
					<input type="checkbox" bind:checked={fleetOpts.shapeOnly} class="h-4 w-4" />
					Shape only (ignore overall loudness)
				</label>
			{/if}
			{:else}
			<label class="text-sm">
				<span class="tron-label">Sections (seconds; blank = automatic)</span>
				<input bind:value={sectionsText} onkeydown={(e) => { if (e.key === 'Enter' && pickedIds.length >= minPicked) run(); }} class="tron-input w-72" style="min-height: 44px;" placeholder="e.g. 40-57, 110-130" />
			</label>
			<label class="flex items-center gap-2 text-sm" style="min-height: 44px;">
				<input type="checkbox" bind:checked={against} class="h-4 w-4" />
				Judge against the reference set (★) of their assay
			</label>
			{/if}
			<button type="button" onclick={run} disabled={pickedIds.length < minPicked} class="rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-semibold text-[var(--color-tron-bg-primary)] disabled:opacity-40" style="min-height: 44px;">
				{view === 'fleet' ? 'Run fleet check' : 'Generate comparison'} ({pickedIds.length})
			</button>
		</div>
	</div>

	{#if data.error}
		<div class="rounded-lg bg-[var(--color-tron-orange)]/10 p-3 text-sm text-[var(--color-tron-orange)]">{data.error}</div>
	{/if}

	{#if R && data.view === 'fleet' && data.fleet}
		<SonicFleet fleet={data.fleet} items={R.items} t={R.t} window={R.window} tickS={data.tickS} />
	{/if}

	{#if R && data.view === 'detail'}
		<!-- key findings -->
		{#if findings.length}
			<div class="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4" aria-label="Key findings">
				{#each findings as f (f.title)}
					<div
						class="tron-card space-y-1 border-l-4 p-3"
						style="border-left-color: {f.kind === 'fail' ? 'rgb(248,113,113)' : f.kind === 'warn' ? 'rgb(250,204,21)' : 'rgb(74,222,128)'}"
					>
						<div class="tron-text-primary text-base font-semibold">{f.title}</div>
						<div class="tron-text-muted text-sm">{f.text}</div>
					</div>
				{/each}
			</div>
		{/if}

		<!-- units: show / hide + hover to highlight -->
		<div class="tron-card space-y-2 p-4 text-sm">
			<div class="flex flex-wrap gap-2">
				{#each R.items as it, i (it.id)}
					<button
						type="button"
						aria-pressed={!hidden[it.id]}
						onclick={() => (hidden = { ...hidden, [it.id]: !hidden[it.id] })}
						onpointerenter={() => (focusId = it.id)}
						onpointerleave={() => (focusId = null)}
						onfocus={() => (focusId = it.id)}
						onblur={() => (focusId = null)}
						title={`${it.assay ?? '?'} · offset ${it.offset >= 0 ? '+' : ''}${it.offset.toFixed(2)} s${it.fileName ? ` · ${it.fileName}` : ''}`}
						class="inline-flex items-center gap-2 rounded-full border border-[var(--color-tron-border)] px-3 font-mono"
						style="min-height: 40px; opacity: {hidden[it.id] ? 0.38 : 1}"
					>
						<span class="inline-block h-3 w-3 rounded-full" style="background: {color(i)}"></span>{it.label}{#if it.isReference}<span class="text-[var(--color-tron-orange)]">★</span>{/if}
					</button>
				{/each}
			</div>
			<div class="flex flex-wrap items-center gap-3">
				<button type="button" onclick={() => setAll(true)} class="rounded border border-[var(--color-tron-border)] px-3" style="min-height: 40px;">Show all</button>
				<button type="button" onclick={() => setAll(false)} class="rounded border border-[var(--color-tron-border)] px-3" style="min-height: 40px;">Hide all</button>
				<span class="tron-text-muted text-xs">Click a unit to show or hide it on the charts; hover to highlight it.</span>
			</div>
			<p class="tron-text-muted text-xs">
				Compared window {R.window[0]}–{R.window[1]} s (time of {R.items[0].label}). Differences are against <b>{R.against}</b>. Recordings:
				{#each R.items as it, i (it.id)}<a href={`/validation/sonic/${it.id}`} class="mr-2 hover:underline" style="color: {color(i)}">{it.label}</a>{/each}
			</p>
			<div class="flex flex-wrap gap-4">
				<button type="button" onclick={downloadCsv} class="text-[var(--color-tron-cyan)] hover:underline" style="min-height: 40px;">Download CSV</button>
				<button type="button" onclick={copyLink} class="text-[var(--color-tron-cyan)] hover:underline" style="min-height: 40px;">{copied ? 'Link copied' : 'Copy link to this comparison'}</button>
			</div>
		</div>

		<!-- 1. section scorecard -->
		<div class="tron-card space-y-3 p-4">
			<h2 class="tron-heading text-lg font-semibold">Section-by-section acceptance</h2>
			{#if hasScores}
				<p class="tron-text-muted text-xs">
					Each cell: <b>loudness shape %</b> | <b>tone colour %</b> of points inside the {R.scoredAgainst === 'references' ? 'reference set' : 'other SPUs'}' mean ± {data.envelopeK}σ
					(the SPU itself is left out). PASS needs ≥ {data.passPct}% on both. Advisory only.
				</p>
				<div class="overflow-x-auto">
					<table class="w-full text-center text-xs">
						<thead>
							<tr>
								<th class="px-2 py-1 text-left">SPU</th>
								<!-- scores[i][k] line up with envelopes[k] (a section with no bins is skipped there), not with sections[k] -->
								{#each R.envelopes as s (s.name)}<th class="px-2 py-1">{s.name}<br /><span class="tron-text-muted font-normal">{s.a.toFixed(0)}–{s.b.toFixed(0)}s</span></th>{/each}
								<th class="px-2 py-1">passed</th>
							</tr>
						</thead>
						<tbody>
							{#each scoreOrder as i (R.items[i].id)}
								{@const it = R.items[i]}
								<tr class="border-t border-[var(--color-tron-border)]/40" style={focusId && focusId !== it.id ? 'opacity: 0.5' : ''}>
									<td class="px-2 py-1 text-left font-mono font-bold" style="color: {color(i)}">{it.label}{it.isReference ? ' ★' : ''}</td>
									{#each R.scores[i] as s, k (k)}
										<td class="px-1 py-1" style="background: {scoreBg(s)}">
											{#if s}<b>{s.pass ? 'PASS' : 'CHECK'}</b><br />{s.loudIn}% | {s.specIn}%{:else}<span class="tron-text-muted">—</span>{/if}
										</td>
									{/each}
									<td class="px-2 py-1 font-semibold">
										{#if R.scores[i].some((s: unknown) => s)}{R.scores[i].filter((s: { pass: boolean } | null) => s?.pass).length}/{R.scores[i].length}{:else}—{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{:else}
				<p class="tron-text-muted text-sm">
					{R.scoredAgainst === 'references'
						? `Needs at least ${data.minReferences} reference recordings (★) of this assay to build a band.`
						: 'Needs at least 3 SPUs to build a group average and standard deviation — add more recordings.'}
				</p>
			{/if}
		</div>

		<!-- 2. envelopes -->
		{#if R.envelopes.length && hasScores}
			<div class="tron-card space-y-3 p-4">
				<h2 class="tron-heading text-lg font-semibold">Loudness shape per section</h2>
				<p class="tron-text-muted text-xs">Each SPU's own average level in the section is removed — only rise/fall and timing count. Thick line = outside the band in that section.</p>
				<div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
					{#each R.envelopes as e, k (e.name)}
						<SonicChart
							title={`${e.name} ${e.a}–${e.b}s`}
							x={e.t}
							xDomain={[e.a, e.b]}
							tickS={e.b - e.a > 15 ? data.tickS : 2}
							height={260}
							yLabel="dB"
							band={{ mu: e.loudMu, sd: e.loudSd, k: data.envelopeK }}
							focus={focusLabel}
							series={R.items.flatMap((it: { label: string }, i: number) =>
								shown(i)
									? [{ label: it.label, color: color(i), values: e.loud[i], width: (R.scores[i]?.[k]?.loudIn ?? 100) < data.passPct ? 3 : 1.2 }]
									: []
							)}
							legend={k === 0}
						/>
					{/each}
				</div>
				<h2 class="tron-heading pt-2 text-lg font-semibold">Tone colour per section</h2>
				<p class="tron-text-muted text-xs">1/3-octave spectrum shape with loudness removed. Thick line = outside the band.</p>
				<div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
					{#each R.envelopes as e, k (e.name)}
						<SonicChart
							title={`${e.name} ${e.a}–${e.b}s`}
							x={bandCenters}
							xLog
							xDomain={[bandCenters[0], bandCenters[bandCenters.length - 1]]}
							height={260}
							yLabel="relative dB"
							band={{ mu: e.specMu, sd: e.specSd, k: data.envelopeK }}
							focus={focusLabel}
							series={R.items.flatMap((it: { label: string }, i: number) =>
								shown(i)
									? [{ label: it.label, color: color(i), values: e.spec[i], width: (R.scores[i]?.[k]?.specIn ?? 100) < data.passPct ? 3 : 1.2 }]
									: []
							)}
							legend={k === 0}
						/>
					{/each}
				</div>
			</div>
		{/if}

		<!-- 3. frequency over time -->
		<div class="tron-card space-y-3 p-4">
			<h2 class="tron-heading text-lg font-semibold">Dominant frequency over time</h2>
			<p class="tron-text-muted text-xs">
				Strongest tone between 100 and 2000 Hz (motor pitch), shown only while each SPU is running.
				{n <= 2 ? '▲ peak / ▼ valley of every running stretch.' : 'Per phase: ▲ highest SPU, ▼ lowest SPU.'} Grey = running; {data.tickS} s grid.
			</p>
			<SonicChart x={R.t} xDomain={R.window} tickS={data.tickS} height={440} yLabel="Hz" xLabel={`time (s), aligned to ${R.items[0].label}`} series={freqSeries} markers={freqMarkers} shade={R.shade} sections={phaseSections} focus={focusLabel} tooltip fmt={(v) => `${Math.round(v)} Hz`} />
		</div>

		<!-- 4. loudness over time -->
		<div class="tron-card space-y-3 p-4">
			<h2 class="tron-heading text-lg font-semibold">Loudness over time</h2>
			<p class="tron-text-muted text-xs">2 s average. Per phase: ▲ loudest SPU, ▼ quietest SPU (phase-average level). Absolute level also depends on how close the phone was.</p>
			<SonicChart x={R.t} xDomain={R.window} tickS={data.tickS} height={440} yLabel="dBFS" xLabel={`time (s), aligned to ${R.items[0].label}`} series={loudSeries} markers={loudMarkers} shade={R.shade} sections={phaseSections} focus={focusLabel} tooltip fmt={(v) => `${v.toFixed(1)} dB`} />
		</div>

		<!-- 5. per-phase grids -->
		{#if R.phases.length}
			<div class="tron-card space-y-4 p-4">
				<h2 class="tron-heading text-lg font-semibold">Per phase</h2>
				<p class="tron-text-muted text-xs">Colour shows how far each SPU is from {R.mode === 'reference' ? R.items[0].label : 'the group median'} in that phase: red above, blue below.</p>
				<div class="flex flex-wrap gap-2 text-sm" role="group" aria-label="Measure">
					{#each GRID_TABS as [k, name] (k)}
						<button
							type="button"
							aria-pressed={gridTab === k}
							onclick={() => (gridTab = k)}
							class="rounded border px-3 {gridTab === k ? 'border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)] text-[var(--color-tron-bg-primary)]' : 'border-[var(--color-tron-border)]'}"
							style="min-height: 40px;">{name}</button
						>
					{/each}
				</div>
				{#each [{ k: 'hz', title: 'Typical frequency (Hz)', g: hzGrid, unit: 'Hz', dp: 0, pattern: false }, { k: 'db', title: 'Average loudness (dBFS)', g: dbGrid, unit: 'dB', dp: 1, pattern: false }, { k: 'pattern', title: "Loudness pattern — each SPU's constant offset (phone distance) removed; 0 = same rise/fall as the group", g: patGrid, unit: 'dB', dp: 1, pattern: true }].filter((G) => G.k === gridTab) as G (G.title)}
					<div>
						<div class="tron-text-primary mb-1 text-sm font-semibold">{G.title}</div>
						<div class="overflow-x-auto">
							<table class="w-full text-center text-xs">
								<thead>
									<tr>
										<th class="px-2 py-1 text-left">SPU</th>
										{#each R.phases as [a, b], p (p)}<th class="px-2 py-1">P{p + 1}<br /><span class="tron-text-muted font-normal">{fmt(a, 0)}–{fmt(b, 0)}s</span></th>{/each}
									</tr>
								</thead>
								<tbody>
									{#each G.g.rows as row, i (i)}
										<tr class="border-t border-[var(--color-tron-border)]/40">
											<td class="px-2 py-1 text-left font-mono font-bold" style="color: {color(i)}">{R.items[i].label}</td>
											{#each row.v as v, p (p)}
												<td class="px-1 py-1" style="background: {cellBg(row.d[p], G.g.lim)}">
													{#if G.pattern}{row.d[p] == null ? '—' : `${row.d[p]! >= 0 ? '+' : ''}${row.d[p]!.toFixed(1)}`}
													{:else}{v == null ? '—' : v.toFixed(G.dp)}<br /><span class="tron-text-muted">({row.d[p] == null ? '—' : `${row.d[p]! >= 0 ? '+' : ''}${row.d[p]!.toFixed(G.dp)}`})</span>{/if}
												</td>
											{/each}
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					</div>
				{/each}
			</div>
		{/if}

		<!-- 6. similarity table -->
		<div class="tron-card space-y-3 p-4">
			<h2 class="tron-heading text-lg font-semibold">Similarity summary</h2>
			<p class="tron-text-muted text-xs">Averages count only the time both are clearly running. Peak / min are the loudest and quietest half-seconds of the test. Click a column to sort.</p>
			<div class="overflow-x-auto">
				<table class="w-full text-right text-xs">
					<thead>
						<tr class="text-[var(--color-tron-text-secondary)]">
							{@render th('label', 'SPU', 'px-2 py-1 text-left')}{@render th('medianHz', 'typical Hz')}<th class="px-2">avg |Δ freq| Hz</th>{@render th('avgAbsPct', 'avg |Δ freq| %')}
							{@render th('matchPct', 'freq within ±5 %')}{@render th('avgAbsLvl', 'avg |Δ loudness| dB')}{@render th('avgShape', 'avg shape diff dB')}
							{@render th('peakDb', 'peak dBFS @ s')}{@render th('minDb', 'min dBFS @ s')}<th class="px-2">tones above the others</th>
						</tr>
					</thead>
					<tbody>
						{#each summaryOrder as i (R.items[i].id)}
							{@const it = R.items[i]}
							{@const s = R.sim[i]}
							{@const isRef = !vsIdx.includes(i)}
							<tr class="border-t border-[var(--color-tron-border)]/40">
								<td class="px-2 py-1 text-left font-mono font-bold" style="color: {color(i)}">{it.label}</td>
								<td class="px-2">{s.medianHz ?? '—'}</td>
								<td class="px-2">{isRef ? 'ref' : fmt(s.avgAbsHz)}</td>
								<td class="px-2">{isRef ? 'ref' : fmt(s.avgAbsPct)}</td>
								<td class="px-2">{isRef ? 'ref' : s.matchPct == null ? '—' : `${s.matchPct}%`}</td>
								<td class="px-2">{isRef ? 'ref' : fmt(s.avgAbsLvl)}</td>
								<td class="px-2">{isRef ? 'ref' : fmt(s.avgShape)}</td>
								<td class="px-2">{fmt(s.peakDb)} @ {fmt(s.peakT)}</td>
								<td class="px-2">{fmt(s.minDb)} @ {fmt(s.minT)}</td>
								<td class="px-2">{R.tones[i].map(([hz, dbv]: [number, number]) => `${hz} Hz (+${dbv})`).join(', ') || '—'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>

		<!-- 7. differences over time -->
		<div class="tron-card space-y-3 p-4">
			<h2 class="tron-heading text-lg font-semibold">Differences over time (vs {R.against})</h2>
			<SonicChart title="Frequency difference (Hz)" x={R.t} xDomain={R.window} tickS={data.tickS} height={260} yLabel="Δ Hz" series={diff('dHz')} shade={R.shade} focus={focusLabel} tooltip fmt={(v) => `${v > 0 ? '+' : ''}${Math.round(v)} Hz`} />
			<SonicChart title="Loudness difference (dB)" x={R.t} xDomain={R.window} tickS={data.tickS} height={260} yLabel="Δ dB" series={diff('dLvl')} shade={R.shade} focus={focusLabel} tooltip fmt={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`} />
			<SonicChart title="Sound-shape difference (dB, 0 = identical tone colour)" x={R.t} xDomain={R.window} tickS={data.tickS} height={260} yLabel="dB" series={diff('shapeDb')} shade={R.shade} focus={focusLabel} tooltip fmt={(v) => `${v.toFixed(1)} dB`} />
		</div>
	{/if}
</div>
