<script lang="ts">
	import { goto } from '$app/navigation';
	import SonicChart, { type ChartMarker, type ChartSeries } from '$lib/components/validation/sonic/SonicChart.svelte';
	import { sonicColor } from '$lib/components/validation/sonic/palette';

	let { data } = $props();

	const THIRD_OCT = Array.from({ length: 22 }, (_, k) => 100 * 2 ** (k / 3));
	const bandCenters = THIRD_OCT.slice(0, -1).map((lo, i) => Math.sqrt(lo * THIRD_OCT[i + 1]));

	// ── picker ────────────────────────────────────────────────────────────
	let picked = $state<Record<string, boolean>>(Object.fromEntries(data.ids.map((id: string) => [id, true])));
	let sectionsText = $state(data.sections ?? '');
	let against = $state(data.againstRefs);
	let pickerAssay = $state('ALL');
	const pickedIds = $derived(Object.keys(picked).filter((k) => picked[k]));
	const pickerRows = $derived(data.available.filter((a: { assay: string | null }) => pickerAssay === 'ALL' || (a.assay ?? 'UNKNOWN') === pickerAssay));

	function run() {
		const q = new URLSearchParams();
		q.set('ids', pickedIds.join(','));
		if (sectionsText.trim()) q.set('sections', sectionsText.trim());
		if (against) q.set('against', 'reference');
		goto(`/validation/sonic/compare?${q.toString()}`);
	}

	// ── result ────────────────────────────────────────────────────────────
	const R = $derived(data.result);
	const n = $derived(R?.items.length ?? 0);
	const color = (i: number) => sonicColor(i);
	const vsIdx = $derived(R ? (R.mode === 'reference' ? R.items.map((_: unknown, i: number) => i).slice(1) : R.items.map((_: unknown, i: number) => i)) : []);
	const phaseSections = $derived(R ? R.phases.map(([a, b]: [number, number], p: number) => ({ name: `P${p + 1}`, a, b })) : []);
	const hasScores = $derived(R ? R.scores.some((row: unknown[]) => row.some((s) => s)) : false);

	/** Per phase: the SPU with the highest (▲) and lowest (▼) value of `key`. */
	function phaseMarkers(key: 'hz' | 'avgDb', fmt: (v: number) => string): ChartMarker[] {
		if (!R) return [];
		const out: ChartMarker[] = [];
		R.phases.forEach(([a, b]: [number, number], p: number) => {
			const vals = R.pstats.map((row: { hz: number | null; avgDb: number | null }[]) => row[p][key]);
			const idx = vals.map((v: number | null, i: number) => [v, i] as const).filter(([v]: readonly [number | null, number]) => v != null) as [number, number][];
			if (!idx.length) return;
			const hi = idx.reduce((m, x) => (x[0] > m[0] ? x : m));
			const lo = idx.reduce((m, x) => (x[0] < m[0] ? x : m));
			const mid = (a + b) / 2;
			out.push({ x: mid, v: hi[0], side: 1, color: color(hi[1]), text: `${R.items[hi[1]].label}\n${fmt(hi[0])}` });
			if (lo[1] !== hi[1]) out.push({ x: mid, v: lo[0], side: -1, color: color(lo[1]), text: `${R.items[lo[1]].label}\n${fmt(lo[0])}` });
		});
		return out;
	}

	const freqSeries = $derived<ChartSeries[]>(
		R ? R.items.map((it: { label: string }, i: number) => ({ label: it.label, color: color(i), values: R.series[i].domHz, width: 2 })) : []
	);
	const freqMarkers = $derived<ChartMarker[]>(
		!R
			? []
			: n <= 2
				? R.extremes.flatMap((row: [number, number, string][], i: number) =>
						row.map(([x, v, kind]) => ({ x, v, side: (kind === 'peak' ? 1 : -1) as 1 | -1, color: color(i), text: `${v} Hz` }))
					)
				: phaseMarkers('hz', (v) => `${Math.round(v)} Hz`)
	);
	const loudSeries = $derived<ChartSeries[]>(
		R ? R.items.map((it: { label: string }, i: number) => ({ label: it.label, color: color(i), values: R.series[i].levelSmooth, width: 1.8 })) : []
	);
	const loudMarkers = $derived<ChartMarker[]>(phaseMarkers('avgDb', (v) => `${v.toFixed(1)} dB`));

	const diff = (key: 'dHz' | 'dLvl' | 'shapeDb'): ChartSeries[] =>
		R ? vsIdx.map((i: number) => ({ label: R.items[i].label, color: color(i), values: R.sim[i][key], width: 1.4 })) : [];

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

	function downloadCsv() {
		if (!R) return;
		const lines: string[] = [];
		lines.push(['SPU', 'file', ...R.sections.flatMap((s: { name: string; a: number; b: number }) => [`${s.name} ${s.a}-${s.b}s loudness %`, `${s.name} tone %`, `${s.name} result`])].join(','));
		R.items.forEach((it: { label: string; fileName: string | null }, i: number) => {
			const cells = R.scores[i].flatMap((s: { loudIn: number; specIn: number; pass: boolean } | null) => (s ? [s.loudIn, s.specIn, s.pass ? 'PASS' : 'CHECK'] : ['', '', 'n/a']));
			lines.push([it.label, `"${it.fileName ?? ''}"`, ...cells].join(','));
		});
		lines.push('');
		lines.push(['phase', 'start_s', 'end_s', ...R.items.flatMap((it: { label: string }) => [`${it.label} avg dBFS`, `${it.label} Hz`])].join(','));
		R.phases.forEach(([a, b]: [number, number], p: number) => {
			lines.push([`P${p + 1}`, a, b, ...R.pstats.flatMap((row: { avgDb: number | null; hz: number | null }[]) => [row[p].avgDb ?? '', row[p].hz ?? ''])].join(','));
		});
		const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = `sonic-compare-${new Date().toISOString().slice(0, 10)}.csv`;
		a.click();
		URL.revokeObjectURL(a.href);
	}

	const fmt = (v: number | null | undefined, d = 1) => (v == null ? '—' : v.toFixed(d));
</script>

<div class="space-y-6">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<h1 class="tron-heading text-2xl font-bold">Sonic Compare</h1>
			<p class="tron-text-muted mt-1 max-w-3xl text-sm">
				Recordings are lined up in time, cut into sections (P = operating phase, B = the stretch between phases, or your own), and each
				SPU is judged against the others' average shape ± {data.envelopeK}σ — or against the reference set of its assay.
			</p>
		</div>
		<a href="/validation/sonic" class="text-sm text-[var(--color-tron-cyan)] hover:underline">← Recordings</a>
	</div>

	<!-- picker -->
	<div class="tron-card space-y-3 p-4">
		<div class="flex flex-wrap items-center gap-3">
			<h2 class="tron-heading text-sm font-semibold uppercase tracking-wide">Recordings to compare ({pickedIds.length})</h2>
			<select bind:value={pickerAssay} class="tron-select text-sm" style="min-height: 36px;">
				<option value="ALL">All assays</option>
				<option value="SONIC">SONIC</option>
				<option value="BCODE">BCODE</option>
				<option value="OTHER">OTHER</option>
				<option value="UNKNOWN">Assay not set</option>
			</select>
		</div>
		<div class="grid max-h-56 grid-cols-1 gap-1 overflow-y-auto text-sm md:grid-cols-2 lg:grid-cols-3">
			{#each pickerRows as a (a.id)}
				<label class="flex items-center gap-2 rounded px-2 py-1 hover:bg-[var(--color-tron-bg-tertiary)]">
					<input type="checkbox" bind:checked={picked[a.id]} class="h-4 w-4" />
					<span class="font-mono font-bold">{a.spuUdi}</span>
					{#if a.reference}<span class="text-[var(--color-tron-orange)]" title="reference">★</span>{/if}
					<span class="tron-text-muted text-xs">{a.assay ?? 'assay?'} · {a.at ? new Date(a.at).toLocaleDateString() : ''} · {a.fileName ?? ''}</span>
				</label>
			{:else}
				<p class="tron-text-muted">No analyzed recordings yet.</p>
			{/each}
		</div>
		<div class="flex flex-wrap items-end gap-3">
			<label class="text-sm">
				<span class="tron-label">Sections (seconds; blank = automatic)</span>
				<input bind:value={sectionsText} class="tron-input w-72" style="min-height: 40px;" placeholder="e.g. 40-57, 110-130" />
			</label>
			<label class="flex items-center gap-2 text-sm" style="min-height: 40px;">
				<input type="checkbox" bind:checked={against} class="h-4 w-4" />
				Judge against the reference set (★) of their assay
			</label>
			<button type="button" onclick={run} disabled={pickedIds.length < (against ? 1 : 2)} class="rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-semibold text-[var(--color-tron-bg-primary)] disabled:opacity-40" style="min-height: 40px;">
				Compare
			</button>
		</div>
	</div>

	{#if data.error}
		<div class="rounded-lg bg-[var(--color-tron-orange)]/10 p-3 text-sm text-[var(--color-tron-orange)]">{data.error}</div>
	{/if}

	{#if R}
		<!-- who's in it -->
		<div class="tron-card p-4 text-sm">
			<div class="flex flex-wrap gap-x-6 gap-y-2">
				{#each R.items as it, i (it.id)}
					<span class="inline-flex items-center gap-2">
						<span class="inline-block h-3 w-3 rounded-full" style="background: {color(i)}"></span>
						<a href={`/validation/sonic/${it.id}`} class="font-mono font-bold hover:underline" style="color: {color(i)}">{it.label}</a>
						{#if it.isReference}<span class="text-[var(--color-tron-orange)]" title="reference">★</span>{/if}
						<span class="tron-text-muted text-xs">{it.assay ?? '?'} · offset {it.offset >= 0 ? '+' : ''}{it.offset.toFixed(2)} s</span>
					</span>
				{/each}
			</div>
			<p class="tron-text-muted mt-2 text-xs">
				Compared window {R.window[0]}–{R.window[1]} s (time of {R.items[0].label}). Differences are against <b>{R.against}</b>.
				<button type="button" onclick={downloadCsv} class="ml-3 text-[var(--color-tron-cyan)] hover:underline">Download CSV</button>
			</p>
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
								{#each R.sections as s (s.name)}<th class="px-2 py-1">{s.name}<br /><span class="tron-text-muted font-normal">{s.a.toFixed(0)}–{s.b.toFixed(0)}s</span></th>{/each}
								<th class="px-2 py-1">passed</th>
							</tr>
						</thead>
						<tbody>
							{#each R.items as it, i (it.id)}
								<tr class="border-t border-[var(--color-tron-border)]/40">
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
							band={{ mu: e.loudMu as number[], sd: e.loudSd as number[], k: data.envelopeK }}
							series={R.items.map((it: { label: string }, i: number) => ({
								label: it.label,
								color: color(i),
								values: e.loud[i],
								width: R.scores[i][k] && R.scores[i][k].loudIn < data.passPct ? 3 : 1.2
							}))}
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
							band={{ mu: e.specMu as number[], sd: e.specSd as number[], k: data.envelopeK }}
							series={R.items.map((it: { label: string }, i: number) => ({
								label: it.label,
								color: color(i),
								values: e.spec[i],
								width: R.scores[i][k] && R.scores[i][k].specIn < data.passPct ? 3 : 1.2
							}))}
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
			<SonicChart x={R.t} xDomain={R.window} tickS={data.tickS} height={440} yLabel="Hz" xLabel={`time (s), aligned to ${R.items[0].label}`} series={freqSeries} markers={freqMarkers} shade={R.shade} sections={phaseSections} />
		</div>

		<!-- 4. loudness over time -->
		<div class="tron-card space-y-3 p-4">
			<h2 class="tron-heading text-lg font-semibold">Loudness over time</h2>
			<p class="tron-text-muted text-xs">2 s average. Per phase: ▲ loudest SPU, ▼ quietest SPU (phase-average level). Absolute level also depends on how close the phone was.</p>
			<SonicChart x={R.t} xDomain={R.window} tickS={data.tickS} height={440} yLabel="dBFS" xLabel={`time (s), aligned to ${R.items[0].label}`} series={loudSeries} markers={loudMarkers} shade={R.shade} sections={phaseSections} />
		</div>

		<!-- 5. per-phase grids -->
		{#if R.phases.length}
			<div class="tron-card space-y-4 p-4">
				<h2 class="tron-heading text-lg font-semibold">Per phase</h2>
				{#each [{ title: 'Typical frequency (Hz)', g: hzGrid, unit: 'Hz', dp: 0 }, { title: 'Average loudness (dBFS)', g: dbGrid, unit: 'dB', dp: 1 }, { title: "Loudness pattern — each SPU's constant offset (phone distance) removed; 0 = same rise/fall as the group", g: patGrid, unit: 'dB', dp: 1, pattern: true }] as G (G.title)}
					<div>
						<div class="tron-text-primary mb-1 text-sm font-semibold">{G.title}</div>
						<div class="overflow-x-auto">
							<table class="w-full text-center text-xs">
								<thead>
									<tr>
										<th class="px-2 py-1 text-left">SPU</th>
										{#each R.phases as [a, b], p (p)}<th class="px-2 py-1">P{p + 1}<br /><span class="tron-text-muted font-normal">{a.toFixed(0)}–{b.toFixed(0)}s</span></th>{/each}
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
			<p class="tron-text-muted text-xs">Averages count only the time both are clearly running. Peak / min are the loudest and quietest half-seconds of the test.</p>
			<div class="overflow-x-auto">
				<table class="w-full text-right text-xs">
					<thead>
						<tr class="text-[var(--color-tron-text-secondary)]">
							<th class="px-2 py-1 text-left">SPU</th><th class="px-2">typical Hz</th><th class="px-2">avg |Δ freq| Hz</th><th class="px-2">avg |Δ freq| %</th>
							<th class="px-2">freq within ±5 %</th><th class="px-2">avg |Δ loudness| dB</th><th class="px-2">avg shape diff dB</th>
							<th class="px-2">peak dBFS @ s</th><th class="px-2">min dBFS @ s</th><th class="px-2">tones above the others</th>
						</tr>
					</thead>
					<tbody>
						{#each R.items as it, i (it.id)}
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
			<SonicChart title="Frequency difference (Hz)" x={R.t} xDomain={R.window} tickS={data.tickS} height={260} yLabel="Δ Hz" series={diff('dHz')} shade={R.shade} />
			<SonicChart title="Loudness difference (dB)" x={R.t} xDomain={R.window} tickS={data.tickS} height={260} yLabel="Δ dB" series={diff('dLvl')} shade={R.shade} />
			<SonicChart title="Sound-shape difference (dB, 0 = identical tone colour)" x={R.t} xDomain={R.window} tickS={data.tickS} height={260} yLabel="dB" series={diff('shapeDb')} shade={R.shade} />
		</div>
	{/if}
</div>
