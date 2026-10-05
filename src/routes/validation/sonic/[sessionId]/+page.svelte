<script lang="ts">
	import { deserialize } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import SonicChart, { type ChartMarker } from '$lib/components/validation/sonic/SonicChart.svelte';
	import SonicReview from '$lib/components/validation/sonic/SonicReview.svelte';
	import RecordingNav from '$lib/components/validation/sonic/RecordingNav.svelte';

	let { data } = $props();
	const S = $derived(data.session);
	const C = $derived(data.charts);
	const R = $derived(data.review);
	let msg = $state<string | null>(null);
	let err = $state<string | null>(null);
	let working = $state(false);

	// Moving to another recording reuses this page: clear the last one's messages.
	let shownId = '';
	$effect(() => {
		if (S.id !== shownId) {
			shownId = S.id;
			msg = null;
			err = null;
		}
	});

	const THIRD_OCT = Array.from({ length: 22 }, (_, k) => 100 * 2 ** (k / 3));
	const bandLabel = (q: number) => {
		const c = Math.sqrt(THIRD_OCT[q] * THIRD_OCT[q + 1]);
		return c >= 1000 ? `${(c / 1000).toFixed(1)}k` : `${Math.round(c)}`;
	};

	/** Run one action on the recordings page (/validation/sonic) and refresh. */
	async function act(name: string, fields: Record<string, string>, ok: string) {
		working = true;
		err = null;
		msg = null;
		try {
			const fd = new FormData();
			for (const [k, v] of Object.entries(fields)) fd.set(k, v);
			const res = await fetch(`/validation/sonic?/${name}`, { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
			const r = deserialize(await res.text());
			if (r.type === 'success') msg = ok;
			else if (r.type === 'failure') err = (r.data as { error?: string } | undefined)?.error ?? `${name} failed`;
			else err = `${name} failed${res.status ? ` (HTTP ${res.status})` : ''}`;
		} catch (e) {
			err = `${name} failed: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			working = false;
			await invalidateAll();
		}
	}

	const eventShade = $derived<[number, number][]>(C ? C.events.map((e: [number, number, number, number, number | null]) => [e[0], e[1]]) : []);
	const toneMarkers = $derived<ChartMarker[]>(
		C ? C.summary.tones.map(([hz, v]: [number, number]) => ({ x: hz, v, side: 1 as const, color: 'var(--color-tron-orange)', text: `${hz} Hz` })) : []
	);

	// Heatmap: 1/3-octave bands over time (spectrogram-lite).
	// Empty bands, or no finite level at all (silent file), draw nothing rather than NaN rects.
	const heat = $derived.by(() => {
		if (!C || !C.bands.length || !C.bands[0]?.length) return null;
		let hi = -Infinity;
		for (const col of C.bands) for (const v of col) if (Number.isFinite(v) && v > hi) hi = v;
		if (!Number.isFinite(hi)) return null;
		return { lo: hi - 50, hi, cols: C.bands.length, rows: C.bands[0].length };
	});
	/** Time labels every 30 s under the heatmap (none when the duration is unknown / zero). */
	const heatTimes = $derived(C && C.durationS > 0 ? Array.from({ length: Math.floor(C.durationS / 30) + 1 }, (_, i) => i * 30) : []);
	/** Spectrum x-range: 50 Hz to the last plotted point (the chart falls back to the data if empty). */
	const psdDomain = $derived<[number, number] | undefined>(C && C.psdX.length > 1 ? [50, C.psdX[C.psdX.length - 1]] : undefined);
	function heatColor(v: number, lo: number, hi: number) {
		const x = Number.isFinite(v) ? Math.min(Math.max((v - lo) / (hi - lo), 0), 1) : 0;
		// dark → magenta → orange → yellow
		const r = Math.round(255 * Math.min(1, x * 1.6));
		const g = Math.round(255 * Math.max(0, x - 0.45) * 1.8);
		const b = Math.round(255 * Math.max(0, 0.6 - Math.abs(x - 0.35)) * 1.2);
		return `rgb(${r},${Math.min(g, 255)},${b})`;
	}
	const fmt = (v: number | null | undefined, d = 1) => (v == null ? '—' : v.toFixed(d));
</script>

<div class="space-y-6">
	<RecordingNav items={data.nav} currentId={S.id} />

	<div class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<h1 class="tron-heading text-2xl font-bold">
				Sonic fingerprint — <a href={S.spuId ? `/spu/${S.spuId}` : '#'} class="font-mono text-[var(--color-tron-cyan)] hover:underline">{S.spuUdi}</a>
				{#if S.reference}<span class="text-[var(--color-tron-orange)]" title="reference">★</span>{/if}
			</h1>
			<p class="tron-text-muted mt-1 text-sm">
				{S.fileName ?? '—'} · {S.assay ?? 'assay not set'} · {S.at ? new Date(S.at).toLocaleString() : '—'} · {S.recordedBy ?? '—'}
				{#if S.notes}· {S.notes}{/if}
			</p>
		</div>
		<div class="flex flex-wrap gap-3 text-sm">
			<a href="/validation/sonic" class="inline-flex items-center text-[var(--color-tron-cyan)] hover:underline" style="min-height: 44px;">← Recordings</a>
			{#if C}<a href={`/validation/sonic/compare?ids=${S.id}&against=reference`} class="inline-flex items-center text-[var(--color-tron-cyan)] hover:underline" style="min-height: 44px;">Compare with references →</a>{/if}
		</div>
	</div>

	{#if err}<div class="rounded-lg bg-[var(--color-tron-red)]/10 p-3 text-sm text-[var(--color-tron-red)]">{err}</div>{/if}
	{#if msg}<div class="rounded-lg bg-[var(--color-tron-cyan)]/10 p-3 text-sm text-[var(--color-tron-cyan)]">{msg}</div>{/if}

	<!-- SONIC workflow: step 5 (trim & verify) and step 6 (step-mapped anomalies) -->
	<div class="tron-card space-y-3 p-4">
		<div class="flex flex-wrap items-center gap-3">
			<h2 class="tron-heading text-lg font-semibold">Review</h2>
			{#if R.mongoCopy}<span class="rounded bg-[var(--color-tron-green)]/15 px-2 py-0.5 text-xs text-[var(--color-tron-green)]" title={`SHA-256 ${R.mongoCopy.sha256}`}>R2 ✓ · MongoDB ✓</span>{:else}<span class="rounded bg-[var(--color-tron-orange)]/15 px-2 py-0.5 text-xs text-[var(--color-tron-orange)]">MongoDB copy missing</span>{/if}
			{#if R.windowSummary}
				<span class="text-xs">
					Analyzed {R.windowSummary.at ? new Date(R.windowSummary.at).toLocaleString() : ''} by {R.windowSummary.by ?? '—'} ·
					step fit <b class={R.windowSummary.alignment.quality === 'good' ? 'text-[var(--color-tron-green)]' : 'text-[var(--color-tron-orange)]'}>{R.windowSummary.alignment.quality}</b> (r = {R.windowSummary.alignment.corr}) ·
					<b>{R.windowSummary.summary.total}</b> anomal{R.windowSummary.summary.total === 1 ? 'y' : 'ies'}
					({R.windowSummary.summary.bySeverity.high} high, {R.windowSummary.summary.bySeverity.medium} medium, {R.windowSummary.summary.bySeverity.low} low) ·
					{R.windowSummary.referenceCount} reference{R.windowSummary.referenceCount === 1 ? '' : 's'}
				</span>
				<button type="button" disabled={working} onclick={() => act('runWindow', { sessionId: S.id }, 'Window re-analyzed.')} class="ml-auto rounded border border-[var(--color-tron-cyan)] px-3 py-2 text-sm text-[var(--color-tron-cyan)] disabled:opacity-40" style="min-height: 44px;">Re-run analysis</button>
			{/if}
		</div>
		{#if R.windowSummary?.alignment.quality === 'low'}
			<p class="text-xs text-[var(--color-tron-orange)]">The 48-step plan did not fit this recording well — check that the window covers the whole run (start before the first move, end after the last).</p>
		{/if}
		{#if R.durationS > 0}
			{#key S.id}
			<SonicReview
				durationS={R.durationS}
				envDb={R.envDb}
				frameS={R.frameS}
				audioSrc={R.audioSrc}
				spectroUrl={R.spectroUrl}
				review={R.review}
				suggested={R.suggested}
				planTotalS={R.planTotalS}
				planSteps={R.planSteps}
				mappedSteps={R.mappedSteps}
				anomalies={R.anomalies}
				{working}
				onVerify={(a, b) => act('verify', { sessionId: S.id, startS: String(a), endS: String(b) }, 'Window verified and analyzed.')}
				onUnusable={(why) => act('markUnusable', { sessionId: S.id, reason: why }, 'Marked unusable — re-record this unit.')}
			/>
			{/key}
		{:else}
			<p class="tron-text-muted text-sm">Analyze the recording first (Re-analyze above) — trimming needs its waveform.</p>
		{/if}
	</div>

	<div class="tron-card flex flex-wrap items-center gap-4 p-4 text-sm">
		{#if C}
			<span>duration <b>{fmt(C.durationS)} s</b></span>
			<span>RMS <b>{fmt(C.summary.rmsDb)} dBFS</b></span>
			<span>peak <b>{fmt(C.summary.peakDbfs)} dBFS</b></span>
			<span>noise floor <b>{fmt(C.summary.noiseFloorDb)} dBFS</b></span>
			<span>events <b>{C.events.length}</b></span>
			<span>tones <b>{C.summary.tones.map((t: [number, number]) => t[0]).join(', ')} Hz</b></span>
		{:else if S.analysis?.error}
			<span class="text-[var(--color-tron-red)]">Analysis failed: {S.analysis.error}</span>
		{:else}
			<span class="tron-text-muted">Not analyzed yet.</span>
		{/if}
		<span class="ml-auto flex flex-wrap gap-2">
			<button type="button" disabled={working} onclick={() => act('analyze', { sessionId: S.id }, 'Re-analyzed.')} class="rounded border border-[var(--color-tron-cyan)] px-3 py-2 text-[var(--color-tron-cyan)] disabled:opacity-40" style="min-height: 44px;">Re-analyze</button>
			{#if C}
				<button type="button" disabled={working || !S.assay} aria-pressed={S.reference} onclick={() => act('setReference', { sessionId: S.id, on: S.reference ? '0' : '1' }, S.reference ? 'No longer a reference.' : 'Now a reference.')} class="rounded border border-[var(--color-tron-orange)] px-3 py-2 text-[var(--color-tron-orange)] disabled:opacity-40" style="min-height: 44px;">
					{S.reference ? '★ Remove from references' : '☆ Use as reference'}
				</button>
				<button type="button" disabled={working || data.live?.status !== 'scored'} onclick={() => act('score', { sessionId: S.id }, 'Verdict stored and journaled.')} class="rounded bg-[var(--color-tron-cyan)] px-3 py-2 font-semibold text-[var(--color-tron-bg-primary)] disabled:opacity-40" style="min-height: 44px;">Store verdict</button>
			{/if}
		</span>
	</div>

	<!-- verdict -->
	{#if data.live}
		<div class="tron-card space-y-3 p-4">
			<h2 class="tron-heading text-lg font-semibold">Verdict vs the {S.assay ?? ''} reference set (advisory)</h2>
			{#if data.live.status === 'scored'}
				<p class="text-sm">
					Today: <b class={data.live.passed === data.live.total ? 'text-[var(--color-tron-green)]' : 'text-[var(--color-tron-orange)]'}>{data.live.passed}/{data.live.total} sections pass</b>
					against {data.live.referenceCount} references (inside mean ± 2σ on ≥ {data.passPct}% of points, for both loudness shape and tone colour).
					{#if S.storedVerdict}
						<span class="tron-text-muted">Stored verdict: {S.storedVerdict.passedSections}/{S.storedVerdict.totalSections} on {new Date(S.storedVerdict.at).toLocaleString()} by {S.storedVerdict.by}.</span>
					{:else}
						<span class="tron-text-muted">Not stored yet — "Store verdict" records it on the session and the unit's journal.</span>
					{/if}
				</p>
				<div class="overflow-x-auto">
					<table class="w-full text-center text-xs">
						<thead><tr>{#each data.live.perSection ?? [] as p (p.name)}<th class="px-2 py-1">{p.name}<br /><span class="tron-text-muted font-normal">{p.a.toFixed(0)}–{p.b.toFixed(0)}s</span></th>{/each}</tr></thead>
						<tbody>
							<tr>
								{#each data.live.perSection ?? [] as p (p.name)}
									<td class="px-1 py-2" style="background: {p.pass ? 'rgba(74,222,128,0.25)' : Math.min(p.loudInPct, p.toneInPct) >= 75 ? 'rgba(250,204,21,0.3)' : 'rgba(248,113,113,0.35)'}">
										<b>{p.pass ? 'PASS' : 'CHECK'}</b><br />{p.loudInPct}% | {p.toneInPct}%
									</td>
								{/each}
							</tr>
						</tbody>
					</table>
				</div>
			{:else if data.live.status === 'insufficient'}
				<p class="tron-text-muted text-sm">This assay has {data.live.referenceCount} of the {data.minReferences} reference recordings (★) needed for a verdict.</p>
			{:else if data.live.status === 'no-assay'}
				<p class="tron-text-muted text-sm">Set the assay of this recording on the recordings page first.</p>
			{/if}
		</div>
	{/if}

	{#if C}
		<div class="tron-card space-y-3 p-4">
			<h2 class="tron-heading text-lg font-semibold">Loudness over time</h2>
			<p class="tron-text-muted text-xs">50 ms level; grey = detected events ({C.events.length}).</p>
			<SonicChart x={C.envT} xDomain={[0, C.durationS]} tickS={data.tickS} height={320} yLabel="dBFS" xLabel="time (s)" shade={eventShade} series={[{ label: S.spuUdi, color: 'var(--color-tron-cyan)', values: C.envDb, width: 1 }]} legend={false} />
		</div>
		<div class="tron-card space-y-3 p-4">
			<h2 class="tron-heading text-lg font-semibold">Dominant frequency over time</h2>
			<p class="tron-text-muted text-xs">Strongest tone 100–2000 Hz, shown while the unit is running.</p>
			<SonicChart x={C.binT} xDomain={[0, C.durationS]} tickS={data.tickS} height={300} yLabel="Hz" xLabel="time (s)" shade={eventShade} series={[{ label: S.spuUdi, color: 'var(--color-tron-orange)', values: C.domHz, width: 2 }]} legend={false} />
		</div>
		{#if heat}
			<div class="tron-card space-y-3 p-4">
				<h2 class="tron-heading text-lg font-semibold">1/3-octave bands over time</h2>
				<div class="w-full overflow-x-auto">
					<svg viewBox="0 0 1200 300" class="w-full rounded bg-[var(--color-tron-bg-tertiary)]" style="min-width: 640px" preserveAspectRatio="none" role="img" aria-label="band levels over time">
						{#each C.bands as col, b (b)}
							{#each col as v, q (q)}
								<rect x={60 + (b / heat.cols) * 1130} y={10 + (1 - (q + 1) / heat.rows) * 260} width={1130 / heat.cols + 0.6} height={260 / heat.rows + 0.6} fill={heatColor(v, heat.lo, heat.hi)} />
							{/each}
						{/each}
						{#each [0, 4, 8, 12, 16, 20].filter((q) => q < heat.rows) as q (q)}
							<text x="54" y={10 + (1 - (q + 0.5) / heat.rows) * 260} text-anchor="end" dominant-baseline="middle" font-size="11" fill="var(--color-tron-text-secondary)">{bandLabel(q)}</text>
						{/each}
						{#each heatTimes as tt (tt)}
							<text x={60 + (tt / C.durationS) * 1130} y="290" text-anchor="middle" font-size="11" fill="var(--color-tron-text-secondary)">{tt}s</text>
						{/each}
					</svg>
				</div>
			</div>
		{/if}
		<div class="tron-card space-y-3 p-4">
			<h2 class="tron-heading text-lg font-semibold">Average spectrum</h2>
			<SonicChart x={C.psdX} xLog xDomain={psdDomain} height={320} yLabel="dB/Hz" xLabel="frequency (Hz)" markers={toneMarkers} series={[{ label: S.spuUdi, color: 'var(--color-tron-cyan)', values: C.psdY, width: 1.2 }]} legend={false} />
		</div>
		<details class="tron-card p-4 text-sm">
			<summary class="cursor-pointer font-semibold">Events ({C.events.length})</summary>
			<table class="mt-2 w-full text-right text-xs">
				<thead><tr class="text-[var(--color-tron-text-secondary)]"><th class="text-left">#</th><th>start s</th><th>end s</th><th>peak dBFS</th><th>mean dBFS</th><th>dominant Hz</th></tr></thead>
				<tbody>
					{#each C.events as e, i (i)}
						<tr class="border-t border-[var(--color-tron-border)]/40"><td class="text-left">{i + 1}</td><td>{e[0]}</td><td>{e[1]}</td><td>{e[2]}</td><td>{e[3]}</td><td>{e[4] ?? '—'}</td></tr>
					{/each}
				</tbody>
			</table>
		</details>
	{/if}
</div>
