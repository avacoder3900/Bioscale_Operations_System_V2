<!--
	SONIC workflow steps 5–6 on one recording: trim & verify the test window, then
	review the step-mapped anomalies by ear.
	  - waveform (50 ms level) + fine spectrogram image, zoom/pan, playback cursor
	  - start/end handles (drag, type, or "set to cursor"), play start / end / window
	  - Verify window · Unusable – re-record (reason)
	  - 48 steps as bands (approximate until verified, then placed from landmarks)
	  - "Adjust step timing": the analysis' landmark estimates shown as boxes; drag
	    or type their times, the steps between re-flow live; Save & confirm
	  - anomaly listener: pick an anomaly or click a moment, Pre/Post seconds, play the clip
	  - ignore an anomaly (reason required): just this one, or a rule for every recording
	    (e.g. end-of-test beep, compression artifacts); ignored ones stay listed, greyed
-->
<script lang="ts" module>
	import type { Landmark } from '$lib/sonic-placement';
	export interface ReviewStep {
		index: number;
		label: string;
		kind: string;
		t0: number;
		t1: number;
		landmark?: boolean;
		short?: string;
		inRecording?: boolean;
	}
	export interface ReviewPlacement {
		estimates: Landmark[];
		used: Landmark[];
		segments: { t0: number; t1: number }[];
		durations: number[];
		confirmed: boolean;
		by: string | null;
		at: string | null;
		measuredFrom: number;
	}
	export interface ReviewAnomaly {
		id: string;
		kind: string;
		t: number;
		t0: number;
		t1: number;
		step: number | null;
		stepLabel: string | null;
		fLo: number;
		fHi: number;
		deltaDb: number;
		z: number;
		severity: 'low' | 'medium' | 'high';
		note: string;
		ignored?: { source: 'manual' | 'rule'; id: string; name: string | null; reason: string; by: string | null; at: string | null } | null;
	}
	export interface ReviewIgnoreRule {
		id: string;
		name: string;
		reason: string;
		kind: string | null;
		stepFrom: number | null;
		stepTo: number | null;
		fMinHz: number | null;
		fMaxHz: number | null;
		by: string | null;
		at: string | null;
	}
	export type NewIgnoreRule = Omit<ReviewIgnoreRule, 'id' | 'by' | 'at'>;
</script>

<script lang="ts">
	import { onDestroy } from 'svelte';
	import { placeSteps, type PlanStep } from '$lib/sonic-placement';
	import SonicCompare, { type CompareRecording } from './SonicCompare.svelte';

	interface Props {
		durationS: number;
		envDb: number[]; // 50 ms level, dBFS
		frameS: number;
		audioSrc: string;
		spectroUrl: string | null;
		review: { status: 'verified' | 'unusable'; startS?: number; endS?: number; reason?: string; by?: string; at?: string } | null;
		suggested: { startS: number; endS: number };
		planTotalS: number;
		/** Nominal plan steps (seconds from the plan's start), for the approximate bands before verification. */
		planSteps: ReviewStep[];
		/** Fitted steps (recording seconds) once the window has been analyzed. */
		mappedSteps: ReviewStep[] | null;
		anomalies: ReviewAnomaly[];
		working: boolean;
		onVerify: (startS: number, endS: number) => void;
		onUnusable: (reason: string) => void;
		/** Step placement from landmarks (null until the window has been analyzed this way). */
		placement?: ReviewPlacement | null;
		onSavePlacement?: (landmarks: { step: number; t0: number; t1: number }[]) => void;
		onResetPlacement?: () => void;
		/** Other verified recordings, for listening to the same moment on other SPUs. */
		compare?: CompareRecording[];
		udi?: string;
		/** Ignoring anomalies (reason required). */
		ignoreRules?: ReviewIgnoreRule[];
		onIgnore?: (anomalyId: string, reason: string) => void;
		onRestore?: (ignoreId: string) => void;
		onAddRule?: (rule: NewIgnoreRule) => void;
		onRemoveRule?: (ruleId: string) => void;
	}
	let {
		durationS, envDb, frameS, audioSrc, spectroUrl, review, suggested, planTotalS, planSteps, mappedSteps, anomalies, working, onVerify, onUnusable,
		placement = null, onSavePlacement, onResetPlacement, compare = [], udi = 'this SPU',
		ignoreRules = [], onIgnore, onRestore, onAddRule, onRemoveRule
	}: Props = $props();

	// ---- step timing (landmarks)
	let adjusting = $state(false);
	let edit = $state<Landmark[]>([]);
	const stepByIndex = $derived(new Map(planSteps.map((p) => [p.index, p])));
	const estimateOf = (step: number) => placement?.estimates.find((l) => l.step === step) ?? null;
	function startAdjusting() {
		if (!placement) return;
		edit = placement.used.map((l) => ({ ...l }));
		adjusting = true;
		if (v1 - v0 > 120) viewWindow();
	}
	function setLm(step: number, patch: Partial<Landmark>) {
		edit = edit.map((l) => (l.step === step ? { ...l, ...patch, source: 'user' } : l));
	}
	function revertLm(step: number) {
		const est = estimateOf(step);
		if (est) edit = edit.map((l) => (l.step === step ? { ...est } : l));
	}
	/** Steps re-placed live from the landmarks being edited (same code the server uses). */
	const livePlaced = $derived(
		adjusting && placement ? placeSteps(planSteps as PlanStep[], placement.durations, edit, durationS) : null
	);
	const changedCount = $derived(edit.filter((l) => l.source === 'user').length);

	const W = 1200;
	const padL = 40;
	const padR = 12;
	const innerW = W - padL - padR;
	const SPEC_H = 150;
	const WAVE_H = 110;
	const BAND_H = 26;
	const H = SPEC_H + WAVE_H + BAND_H + 26;

	let audio = $state<HTMLAudioElement | null>(null);
	let svg = $state<SVGSVGElement | null>(null);
	let cursor = $state(0);
	let playing = $state(false);

	// Trim window (seeded from the stored review, else the suggestion).
	let startS = $state(0);
	let endS = $state(0);
	let seededFor = '';
	$effect(() => {
		const key = `${review?.startS ?? ''}|${review?.endS ?? ''}|${suggested.startS}|${suggested.endS}`;
		if (key === seededFor) return;
		seededFor = key;
		startS = review?.status === 'verified' && review.startS != null ? review.startS : suggested.startS;
		endS = review?.status === 'verified' && review.endS != null ? review.endS : suggested.endS;
	});
	const lengthS = $derived(Math.max(0, endS - startS));

	// View range (zoom/pan).
	let v0 = $state(0);
	let v1 = $state(0);
	$effect(() => {
		if (v1 <= v0 && durationS > 0) {
			v0 = 0;
			v1 = durationS;
		}
	});
	const sx = (t: number) => padL + ((t - v0) / Math.max(1e-6, v1 - v0)) * innerW;
	const tx = (x: number) => v0 + ((x - padL) / innerW) * (v1 - v0);
	const clampT = (t: number) => Math.min(durationS, Math.max(0, t));
	function zoom(f: number) {
		const span = Math.min(durationS, Math.max(2, (v1 - v0) * f));
		const c = Math.min(Math.max(cursor, v0), v1);
		let a = c - span * ((c - v0) / Math.max(1e-6, v1 - v0));
		a = Math.min(Math.max(0, a), durationS - span);
		v0 = a;
		v1 = a + span;
	}
	function pan(dir: number) {
		const span = v1 - v0;
		const a = Math.min(Math.max(0, v0 + dir * span * 0.5), durationS - span);
		v0 = a;
		v1 = a + span;
	}
	function viewAll() {
		v0 = 0;
		v1 = durationS;
	}
	function viewWindow() {
		v0 = Math.max(0, startS - 3);
		v1 = Math.min(durationS, endS + 3);
	}

	// Waveform path: max level per pixel bucket.
	const wave = $derived.by(() => {
		if (!envDb.length) return { path: '', lo: -80, hi: 0 };
		const sorted = [...envDb].filter(Number.isFinite).sort((a, b) => a - b);
		const lo = sorted[Math.floor(sorted.length * 0.05)] ?? -80;
		const hi = sorted[sorted.length - 1] ?? 0;
		const cols = 600;
		const y0 = SPEC_H + WAVE_H;
		let d = `M${padL},${y0}`;
		for (let c = 0; c <= cols; c++) {
			const ta = v0 + ((v1 - v0) * c) / cols;
			const tb = v0 + ((v1 - v0) * (c + 1)) / cols;
			const ia = Math.max(0, Math.floor(ta / frameS));
			const ib = Math.min(envDb.length, Math.max(ia + 1, Math.ceil(tb / frameS)));
			let m = -Infinity;
			for (let i = ia; i < ib; i++) if (envDb[i] > m) m = envDb[i];
			const frac = Number.isFinite(m) ? Math.min(1, Math.max(0, (m - lo) / Math.max(1, hi - lo))) : 0;
			d += `L${(padL + (innerW * c) / cols).toFixed(1)},${(y0 - frac * (WAVE_H - 6)).toFixed(1)}`;
		}
		d += `L${padL + innerW},${y0}Z`;
		return { path: d, lo, hi };
	});

	// Step bands: the fitted mapping when there is one, else the plan laid linearly
	// across the current window (approximate — real units don't run at the modelled speed).
	const bands = $derived.by<ReviewStep[]>(() => {
		if (livePlaced) return livePlaced;
		if (mappedSteps?.length) return mappedSteps;
		if (!planSteps.length || !(lengthS > 0)) return [];
		const k = lengthS / Math.max(1, planTotalS);
		return planSteps.map((s) => ({ ...s, t0: startS + s.t0 * k, t1: startS + s.t1 * k }));
	});
	const kindColor: Record<string, string> = {
		oscillate: 'rgba(250, 204, 21, 0.35)',
		move: 'rgba(56, 189, 248, 0.30)',
		repeat: 'rgba(129, 140, 248, 0.30)',
		delay: 'rgba(148, 163, 184, 0.12)',
		start: 'rgba(148, 163, 184, 0.25)',
		finish: 'rgba(148, 163, 184, 0.25)'
	};
	const sevColor = { high: 'var(--color-tron-red)', medium: 'var(--color-tron-orange)', low: 'var(--color-tron-cyan)' } as const;

	const ticks = $derived.by(() => {
		const span = v1 - v0;
		const step = span > 200 ? 30 : span > 80 ? 10 : span > 30 ? 5 : span > 10 ? 1 : 0.5;
		const out: number[] = [];
		for (let t = Math.ceil(v0 / step) * step; t <= v1 + 1e-9; t += step) out.push(Math.round(t * 100) / 100);
		return out;
	});
	const fmt = (t: number) => {
		const m = Math.floor(t / 60);
		const s = t - m * 60;
		return `${m}:${s.toFixed(1).padStart(4, '0')}`;
	};

	// ---- pointer: drag handles, else move the cursor (and the listen moment)
	let drag: 'start' | 'end' | null = null;
	let lmDrag: { step: number; edge: 't0' | 't1' | 'move'; grabT: number; o0: number; o1: number } | null = null;
	function svgX(e: PointerEvent): number {
		const r = svg!.getBoundingClientRect();
		return ((e.clientX - r.left) / r.width) * W;
	}
	function onDown(e: PointerEvent) {
		if (!svg) return;
		const x = svgX(e);
		if (adjusting) {
			// Edges first (8 px), then a box's body (move both edges).
			const hit =
				edit.find((l) => Math.abs(x - sx(l.t0)) <= 8 || Math.abs(x - sx(l.t1)) <= 8) ??
				edit.find((l) => x > sx(l.t0) && x < sx(l.t1));
			if (hit) {
				const edge = Math.abs(x - sx(hit.t0)) <= 8 ? 't0' : Math.abs(x - sx(hit.t1)) <= 8 ? 't1' : 'move';
				lmDrag = { step: hit.step, edge, grabT: tx(x), o0: hit.t0, o1: hit.t1 };
				svg.setPointerCapture(e.pointerId);
				return;
			}
			const t = clampT(tx(x));
			seek(t);
			listenAt = Math.round(t * 100) / 100;
			return;
		}
		if (Math.abs(x - sx(startS)) <= 10) drag = 'start';
		else if (Math.abs(x - sx(endS)) <= 10) drag = 'end';
		else {
			const t = clampT(tx(x));
			seek(t);
			listenAt = Math.round(t * 100) / 100;
			selectedId = null;
			return;
		}
		svg.setPointerCapture(e.pointerId);
	}
	function onMove(e: PointerEvent) {
		if (lmDrag && svg) {
			const t = clampT(tx(svgX(e)));
			const r = (v: number) => Math.round(v * 20) / 20;
			const d = lmDrag;
			if (d.edge === 't0') setLm(d.step, { t0: r(Math.min(t, d.o1 - 0.1)) });
			else if (d.edge === 't1') setLm(d.step, { t1: r(Math.max(t, d.o0 + 0.1)) });
			else {
				const dt = t - d.grabT;
				setLm(d.step, { t0: r(d.o0 + dt), t1: r(d.o1 + dt) });
			}
			return;
		}
		if (!drag || !svg) return;
		const t = Math.round(clampT(tx(svgX(e))) * 10) / 10;
		if (drag === 'start') startS = Math.min(t, endS - 1);
		else endS = Math.max(t, startS + 1);
	}
	function onUp(e: PointerEvent) {
		if ((drag || lmDrag) && svg) svg.releasePointerCapture(e.pointerId);
		drag = null;
		lmDrag = null;
	}

	// ---- playback
	let stopAt: number | null = null;
	let raf = 0;
	function tick() {
		if (!audio) return;
		cursor = audio.currentTime;
		if (stopAt != null && audio.currentTime >= stopAt) {
			audio.pause();
			stopAt = null;
		}
		if (!audio.paused) raf = requestAnimationFrame(tick);
	}
	function seek(t: number) {
		cursor = t;
		if (audio) audio.currentTime = t;
	}
	async function playRange(a: number, b: number | null) {
		if (!audio) return;
		audio.currentTime = clampT(a);
		cursor = audio.currentTime;
		stopAt = b == null ? null : clampT(b);
		try {
			await audio.play();
		} catch {
			/* the browser may need one user gesture first; the controls still work */
		}
		cancelAnimationFrame(raf);
		raf = requestAnimationFrame(tick);
	}
	onDestroy(() => cancelAnimationFrame(raf));

	// ---- anomaly listener
	let selectedId = $state<string | null>(null);
	let listenAt = $state<number | null>(null);
	let pre = $state(1);
	let post = $state(1);
	const selected = $derived(anomalies.find((a) => a.id === selectedId) ?? null);
	function pick(a: ReviewAnomaly) {
		selectedId = a.id;
		listenAt = a.t;
		if (a.t < v0 || a.t > v1) {
			const span = Math.min(durationS, Math.max(10, v1 - v0));
			v0 = Math.max(0, Math.min(durationS - span, a.t - span / 2));
			v1 = v0 + span;
		}
		seek(a.t);
	}
	function playClip() {
		if (listenAt == null) return;
		const p = Math.max(0, Number(pre) || 0);
		const q = Math.max(0, Number(post) || 0);
		playRange(listenAt - p, listenAt + q);
	}
	const stepOfCursor = $derived(bands.find((s) => cursor >= s.t0 && cursor < s.t1) ?? null);

	let unusableReason = $state('');
	const SEV_ORDER = { high: 0, medium: 1, low: 2 } as const;
	let sortBy = $state<'time' | 'severity'>('time');
	let hideIgnored = $state(false);
	const ignoredCount = $derived(anomalies.filter((a) => a.ignored).length);
	const listed = $derived(
		(sortBy === 'time' ? anomalies : [...anomalies].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.t - b.t)).filter(
			(a) => !(hideIgnored && a.ignored)
		)
	);

	// ---- ignoring anomalies
	let ignoring = $state<ReviewAnomaly | null>(null);
	let igReason = $state('');
	let igScope = $state<'one' | 'rule'>('one');
	let rule = $state<NewIgnoreRule>({ name: '', reason: '', kind: null, stepFrom: null, stepTo: null, fMinHz: null, fMaxHz: null });
	let showRules = $state(false);
	function startIgnore(a: ReviewAnomaly) {
		ignoring = a;
		igReason = '';
		igScope = 'one';
		rule = { name: '', reason: '', kind: null, stepFrom: a.step, stepTo: a.step, fMinHz: null, fMaxHz: null };
	}
	type Preset = { label: string; reason: string; rule: ((a: ReviewAnomaly) => Partial<NewIgnoreRule>) | null };
	const PRESETS: Preset[] = [
		{
			label: 'End-of-test beep',
			reason: 'The SPU beeping to signal the test has finished. Expected, not a fault.',
			rule: (a) => ({ kind: null, stepFrom: Math.max(1, Math.min(a.step ?? 47, 47)), stepTo: 48, fMinHz: null, fMaxHz: null })
		},
		{
			label: 'Compression artifact',
			reason: 'High-frequency, musical-sounding tones from the recording audio compression, not from the SPU.',
			rule: (a) => ({ kind: null, stepFrom: null, stepTo: null, fMinHz: Math.floor(a.fLo / 500) * 500, fMaxHz: null })
		},
		{ label: 'Room / handling noise', reason: 'Noise from the room or from handling the phone while recording, not from the SPU.', rule: null },
		{ label: 'Sounds normal', reason: 'Listened to it: sounds the same as the other SPUs at this moment.', rule: null }
	];
	function applyPreset(p: Preset) {
		igReason = p.reason;
		if (p.rule && ignoring) {
			rule = { ...rule, name: p.label, ...p.rule(ignoring) };
			igScope = 'rule';
		} else {
			rule = { ...rule, name: p.label };
		}
	}
	const num = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
	function ruleHits(r: NewIgnoreRule, a: ReviewAnomaly) {
		if (r.kind && r.kind !== a.kind) return false;
		const sf = num(r.stepFrom);
		const st = num(r.stepTo);
		if (sf != null || st != null) {
			if (a.step == null) return false;
			if (sf != null && a.step < sf) return false;
			if (st != null && a.step > st) return false;
		}
		const fm = num(r.fMinHz);
		const fx = num(r.fMaxHz);
		if (fm != null && a.fLo < fm) return false;
		if (fx != null && a.fHi > fx) return false;
		return true;
	}
	const ruleEmpty = $derived(!rule.kind && num(rule.stepFrom) == null && num(rule.stepTo) == null && num(rule.fMinHz) == null && num(rule.fMaxHz) == null);
	const rulePreview = $derived(igScope === 'rule' && !ruleEmpty ? anomalies.filter((a) => ruleHits(rule, a)).length : 0);
	const canIgnore = $derived(igReason.trim().length >= 3 && (igScope === 'one' || (rule.name.trim() !== '' && !ruleEmpty)));
	function submitIgnore() {
		if (!ignoring || !canIgnore) return;
		if (igScope === 'one') onIgnore?.(ignoring.id, igReason.trim());
		else
			onAddRule?.({
				name: rule.name.trim(),
				reason: igReason.trim(),
				kind: rule.kind || null,
				stepFrom: num(rule.stepFrom),
				stepTo: num(rule.stepTo),
				fMinHz: num(rule.fMinHz),
				fMaxHz: num(rule.fMaxHz)
			});
		ignoring = null;
	}
	const ruleText = (r: NewIgnoreRule) =>
		[
			r.kind ? `${r.kind} only` : null,
			r.stepFrom != null || r.stepTo != null ? (r.stepFrom === r.stepTo ? `step ${r.stepFrom}` : `steps ${r.stepFrom ?? 1}–${r.stepTo ?? 48}`) : null,
			r.fMinHz != null || r.fMaxHz != null ? (r.fMaxHz == null ? `≥ ${r.fMinHz} Hz` : r.fMinHz == null ? `≤ ${r.fMaxHz} Hz` : `${r.fMinHz}–${r.fMaxHz} Hz`) : null
		]
			.filter(Boolean)
			.join(', ');
</script>

<div class="space-y-3">
	<audio bind:this={audio} src={audioSrc} preload="auto" controls class="h-10 w-full" onplay={() => { playing = true; cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); }} onpause={() => { playing = false; cursor = audio?.currentTime ?? cursor; }} onseeked={() => (cursor = audio?.currentTime ?? cursor)}></audio>

	<div class="flex flex-wrap items-center gap-2 text-xs">
		<button type="button" class="rounded border border-[var(--color-tron-border)] px-3 py-1" style="min-height: 44px;" onclick={() => zoom(0.5)}>Zoom in</button>
		<button type="button" class="rounded border border-[var(--color-tron-border)] px-3 py-1" style="min-height: 44px;" onclick={() => zoom(2)}>Zoom out</button>
		<button type="button" class="rounded border border-[var(--color-tron-border)] px-3 py-1" style="min-height: 44px;" onclick={() => pan(-1)}>◀</button>
		<button type="button" class="rounded border border-[var(--color-tron-border)] px-3 py-1" style="min-height: 44px;" onclick={() => pan(1)}>▶</button>
		<button type="button" class="rounded border border-[var(--color-tron-border)] px-3 py-1" style="min-height: 44px;" onclick={viewAll}>Whole recording</button>
		<button type="button" class="rounded border border-[var(--color-tron-border)] px-3 py-1" style="min-height: 44px;" onclick={viewWindow}>Window</button>
		<span class="tron-text-muted ml-auto">
			cursor <b class="font-mono">{fmt(cursor)}</b>
			{#if stepOfCursor}· step <b>{stepOfCursor.index}</b> {stepOfCursor.label}{/if}
		</span>
	</div>

	<div class="w-full overflow-x-auto">
		<svg
			bind:this={svg}
			viewBox="0 0 {W} {H}"
			class="w-full touch-none select-none rounded bg-[var(--color-tron-bg-tertiary)]"
			style="min-width: 720px"
			role="application"
			aria-label="Recording timeline: drag the start and end handles; click to place the cursor"
			onpointerdown={onDown}
			onpointermove={onMove}
			onpointerup={onUp}
			onpointercancel={onUp}
		>
			<!-- spectrogram (whole recording image, positioned for the current view) -->
			{#if spectroUrl}
				<svg x={padL} y="0" width={innerW} height={SPEC_H} viewBox="0 0 {innerW} {SPEC_H}" preserveAspectRatio="none" overflow="hidden">
					<image href={spectroUrl} x={(-v0 / Math.max(1e-6, v1 - v0)) * innerW} y="0" width={(durationS / Math.max(1e-6, v1 - v0)) * innerW} height={SPEC_H} preserveAspectRatio="none" />
				</svg>
				<text x={padL - 4} y="12" text-anchor="end" font-size="10" fill="var(--color-tron-text-secondary)">16k</text>
				<text x={padL - 4} y={SPEC_H - 2} text-anchor="end" font-size="10" fill="var(--color-tron-text-secondary)">50</text>
			{:else}
				<text x={padL + 8} y={SPEC_H / 2} font-size="12" fill="var(--color-tron-text-secondary)">Spectrogram appears after the recording is (re-)analyzed.</text>
			{/if}
			<!-- waveform -->
			<path d={wave.path} fill="var(--color-tron-cyan)" opacity="0.55" />
			<!-- step bands -->
			{#each bands as st (st.index)}
				{#if st.t1 > v0 && st.t0 < v1}
					{@const a = Math.max(sx(st.t0), padL)}
					{@const b = Math.min(sx(st.t1), padL + innerW)}
					<rect x={a} y={SPEC_H + WAVE_H + 2} width={Math.max(0.5, b - a)} height={BAND_H - 4} fill={kindColor[st.kind] ?? 'rgba(148,163,184,0.2)'} stroke="var(--color-tron-bg-tertiary)" stroke-width="0.6"><title>Step {st.index}: {st.label} ({fmt(st.t0)}–{fmt(st.t1)})</title></rect>
					{#if b - a > 14}
						<text x={(a + b) / 2} y={SPEC_H + WAVE_H + BAND_H / 2 + 4} text-anchor="middle" font-size="10" fill="var(--color-tron-text-primary)">{st.index}</text>
					{/if}
				{/if}
			{/each}
			<!-- outside the window -->
			{#if startS > v0}<rect x={padL} y="0" width={Math.max(0, Math.min(sx(startS), padL + innerW) - padL)} height={SPEC_H + WAVE_H + BAND_H} fill="black" opacity="0.45" />{/if}
			{#if endS < v1}<rect x={Math.max(sx(endS), padL)} y="0" width={Math.max(0, padL + innerW - Math.max(sx(endS), padL))} height={SPEC_H + WAVE_H + BAND_H} fill="black" opacity="0.45" />{/if}
			<!-- anomaly markers -->
			{#each anomalies as a (a.id)}
				{#if a.t >= v0 && a.t <= v1}
					<g role="button" tabindex="-1" onpointerdown={(e) => { e.stopPropagation(); pick(a); }}>
						<line x1={sx(a.t)} x2={sx(a.t)} y1="0" y2={SPEC_H + WAVE_H} stroke={sevColor[a.severity]} stroke-width={a.id === selectedId ? 2 : 1} stroke-dasharray="3,3" opacity="0.8" />
						<path d={`M${sx(a.t) - 6},0L${sx(a.t) + 6},0L${sx(a.t)},10Z`} fill={sevColor[a.severity]} />
					</g>
				{/if}
			{/each}
			<!-- listen moment -->
			{#if listenAt != null && listenAt >= v0 && listenAt <= v1}
				<rect x={sx(Math.max(v0, listenAt - (Number(pre) || 0)))} y={SPEC_H} width={Math.max(1, sx(Math.min(v1, listenAt + (Number(post) || 0))) - sx(Math.max(v0, listenAt - (Number(pre) || 0))))} height={WAVE_H} fill="var(--color-tron-orange)" opacity="0.18" />
			{/if}
			<!-- landmarks (adjust step timing) -->
			{#if adjusting}
				{#each placement?.segments ?? [] as g, i (i)}
					{#if g.t1 > v0 && g.t0 < v1}
						<rect x={Math.max(sx(g.t0), padL)} y={SPEC_H + WAVE_H - 5} width={Math.max(1, Math.min(sx(g.t1), padL + innerW) - Math.max(sx(g.t0), padL))} height="4" fill="var(--color-tron-text-secondary)" opacity="0.6"><title>Loud stretch the analysis found ({fmt(g.t0)}–{fmt(g.t1)})</title></rect>
					{/if}
				{/each}
				{#each edit as l (l.step)}
					{#if l.t1 > v0 && l.t0 < v1}
						{@const a = Math.max(sx(l.t0), padL)}
						{@const b = Math.min(sx(l.t1), padL + innerW)}
						{@const color = l.source === 'user' ? 'var(--color-tron-green)' : l.found === false ? 'var(--color-tron-red)' : 'var(--color-tron-orange)'}
						<rect x={a} y="14" width={Math.max(1, b - a)} height={SPEC_H + WAVE_H - 14} fill={color} opacity="0.12" stroke={color} stroke-width="1.5" stroke-dasharray={l.source === 'user' ? undefined : '5,3'} style="cursor: grab" />
						<line x1={sx(l.t0)} x2={sx(l.t0)} y1="14" y2={SPEC_H + WAVE_H} stroke={color} stroke-width="3" style="cursor: ew-resize" />
						<line x1={sx(l.t1)} x2={sx(l.t1)} y1="14" y2={SPEC_H + WAVE_H} stroke={color} stroke-width="3" style="cursor: ew-resize" />
						{#if b - a > 24}
							<text x={(a + b) / 2} y="11" text-anchor="middle" font-size="10" font-weight="bold" fill={color}>{l.step} {stepByIndex.get(l.step)?.short ?? ''}</text>
						{/if}
					{/if}
				{/each}
			{/if}
			<!-- trim handles -->
			{#each adjusting ? [] : [['start', startS], ['end', endS]] as [name, t] (name)}
				{#if (t as number) >= v0 && (t as number) <= v1}
					<line x1={sx(t as number)} x2={sx(t as number)} y1="0" y2={SPEC_H + WAVE_H + BAND_H} stroke="var(--color-tron-green)" stroke-width="2.5" />
					<rect x={sx(t as number) - 7} y={SPEC_H + WAVE_H / 2 - 14} width="14" height="28" rx="3" fill="var(--color-tron-green)" style="cursor: ew-resize" />
				{/if}
			{/each}
			<!-- playback cursor -->
			{#if cursor >= v0 && cursor <= v1}
				<line x1={sx(cursor)} x2={sx(cursor)} y1="0" y2={SPEC_H + WAVE_H + BAND_H} stroke="white" stroke-width="1.5" opacity={playing ? 1 : 0.7} />
			{/if}
			<!-- time axis -->
			{#each ticks as t (t)}
				<text x={sx(t)} y={H - 6} text-anchor="middle" font-size="10" fill="var(--color-tron-text-secondary)">{fmt(t)}</text>
			{/each}
		</svg>
	</div>
	<p class="tron-text-muted text-xs">
		Top: spectrogram (50 Hz–16 kHz, 50 ms). Middle: loudness. Bottom: the 48 steps
		({mappedSteps?.length ? 'fitted to this recording' : 'approximate until the window is verified'}; yellow = oscillation, blue = move, purple = repeat, grey = wait).
		Drag the green handles to trim; click anywhere to place the cursor and the listening moment.
	</p>

	<!-- step timing (landmarks) -->
	<div class="tron-card space-y-3 p-4">
		<div class="flex flex-wrap items-center gap-3">
			<h3 class="tron-heading font-semibold">Step timing</h3>
			{#if !placement}
				<span class="tron-text-muted text-xs">Verify the window (or re-run the analysis) to get the step timing estimates.</span>
			{:else if placement.confirmed}
				<span class="rounded bg-[var(--color-tron-green)]/15 px-2 py-0.5 text-xs text-[var(--color-tron-green)]">confirmed{placement.by ? ` by ${placement.by}` : ''}{placement.at ? ` · ${new Date(placement.at).toLocaleString()}` : ''}</span>
			{:else}
				<span class="rounded bg-[var(--color-tron-orange)]/15 px-2 py-0.5 text-xs text-[var(--color-tron-orange)]">estimated from the sound — not yet confirmed</span>
			{/if}
			{#if placement}
				<span class="tron-text-muted text-xs">
					{placement.estimates.filter((l) => l.found !== false).length} of {placement.estimates.length} landmarks found in the sound ·
					{placement.measuredFrom ? `real step durations measured from ${placement.measuredFrom} other recordings` : 'step durations from the default speed factors (no measured timeline yet)'}
				</span>
			{/if}
			{#if placement && !adjusting}
				<button type="button" disabled={working} class="ml-auto rounded bg-[var(--color-tron-cyan)] px-4 font-semibold text-[var(--color-tron-bg-primary)] disabled:opacity-40" style="min-height: 44px;" onclick={startAdjusting}>Adjust step timing</button>
			{/if}
		</div>
		{#if adjusting && placement}
			<p class="text-xs">
				The boxes on the timeline are the landmarks — the loud steps (oscillations, long moves). <b class="text-[var(--color-tron-orange)]">Orange dashed</b> = the analysis' estimate,
				<b class="text-[var(--color-tron-red)]">red</b> = only predicted (no matching sound found), <b class="text-[var(--color-tron-green)]">green</b> = adjusted by you.
				Drag an edge or the box, or type the times below; the steps between them move with it. Grey bars under the waveform are the loud stretches the analysis detected.
			</p>
			<div class="max-h-80 overflow-y-auto">
				<table class="w-full text-left text-xs">
					<thead class="sticky top-0 bg-[var(--color-tron-bg-secondary)] text-[var(--color-tron-text-secondary)]">
						<tr><th class="py-1">step</th><th>landmark</th><th>estimate</th><th>start (s)</th><th>end (s)</th><th>length</th><th></th></tr>
					</thead>
					<tbody>
						{#each edit as l (l.step)}
							{@const est = estimateOf(l.step)}
							<tr class="border-t border-[var(--color-tron-border)]/40">
								<td class="py-1 font-mono">{l.step}</td>
								<td>{stepByIndex.get(l.step)?.short ?? ''}</td>
								<td class="font-mono {est?.found === false ? 'text-[var(--color-tron-red)]' : 'tron-text-muted'}">{est ? `${fmt(est.t0)}–${fmt(est.t1)}${est.found === false ? ' (predicted)' : ''}` : '—'}</td>
								<td><input type="number" step="0.05" value={l.t0} onchange={(e) => setLm(l.step, { t0: Number((e.currentTarget as HTMLInputElement).value) })} class="tron-input w-24 {l.source === 'user' ? 'text-[var(--color-tron-green)]' : ''}" style="min-height: 36px;" /></td>
								<td><input type="number" step="0.05" value={l.t1} onchange={(e) => setLm(l.step, { t1: Number((e.currentTarget as HTMLInputElement).value) })} class="tron-input w-24 {l.source === 'user' ? 'text-[var(--color-tron-green)]' : ''}" style="min-height: 36px;" /></td>
								<td class="font-mono">{(l.t1 - l.t0).toFixed(2)} s</td>
								<td class="whitespace-nowrap">
									<button type="button" title="Hear it (1 s either side)" class="px-2 text-[var(--color-tron-orange)]" style="min-height: 36px;" onclick={() => playRange(l.t0 - 1, l.t1 + 1)}>▶</button>
									<button type="button" title="Back to the estimate" disabled={l.source !== 'user'} class="px-2 disabled:opacity-30" style="min-height: 36px;" onclick={() => revertLm(l.step)}>↺</button>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<div class="flex flex-wrap gap-2 text-sm">
				<button type="button" disabled={working} class="rounded bg-[var(--color-tron-green)] px-4 font-semibold text-[var(--color-tron-bg-primary)] disabled:opacity-40" style="min-height: 44px;" onclick={() => { onSavePlacement?.(edit.map((l) => ({ step: l.step, t0: l.t0, t1: l.t1 }))); adjusting = false; }}>
					Save &amp; confirm step timing{changedCount ? ` (${changedCount} adjusted)` : ''}
				</button>
				<button type="button" class="rounded border border-[var(--color-tron-border)] px-3" style="min-height: 44px;" onclick={() => (edit = (placement?.estimates ?? []).map((l) => ({ ...l })))}>Reset all to estimates</button>
				<button type="button" class="rounded border border-[var(--color-tron-border)] px-3" style="min-height: 44px;" onclick={() => (adjusting = false)}>Cancel</button>
				{#if placement.confirmed}
					<button type="button" disabled={working} class="ml-auto rounded border border-[var(--color-tron-red)] px-3 text-[var(--color-tron-red)] disabled:opacity-40" style="min-height: 44px;" onclick={() => { onResetPlacement?.(); adjusting = false; }}>Discard saved timing</button>
				{/if}
			</div>
		{/if}
	</div>

	<!-- trim & verify -->
	<div class="tron-card space-y-3 p-4">
		<h3 class="tron-heading font-semibold">Test window</h3>
		<div class="flex flex-wrap items-end gap-3 text-sm">
			<label class="flex flex-col">
				<span class="tron-text-muted text-xs">Start (s)</span>
				<input type="number" step="0.1" min="0" max={durationS} bind:value={startS} class="tron-input w-28" style="min-height: 44px;" />
			</label>
			<button type="button" class="rounded border border-[var(--color-tron-border)] px-3" style="min-height: 44px;" onclick={() => (startS = Math.min(Math.round(cursor * 10) / 10, endS - 1))}>Start = cursor</button>
			<label class="flex flex-col">
				<span class="tron-text-muted text-xs">End (s)</span>
				<input type="number" step="0.1" min="0" max={durationS} bind:value={endS} class="tron-input w-28" style="min-height: 44px;" />
			</label>
			<button type="button" class="rounded border border-[var(--color-tron-border)] px-3" style="min-height: 44px;" onclick={() => (endS = Math.max(Math.round(cursor * 10) / 10, startS + 1))}>End = cursor</button>
			<span class="tron-text-muted text-xs">
				length <b class="font-mono">{fmt(lengthS)}</b> · plan modelled at {fmt(planTotalS)} (real units run shorter)
			</span>
		</div>
		<div class="flex flex-wrap gap-2 text-sm">
			<button type="button" class="rounded border border-[var(--color-tron-cyan)] px-3 text-[var(--color-tron-cyan)]" style="min-height: 44px;" onclick={() => playRange(startS, startS + 8)}>▶ Play start</button>
			<button type="button" class="rounded border border-[var(--color-tron-cyan)] px-3 text-[var(--color-tron-cyan)]" style="min-height: 44px;" onclick={() => playRange(Math.max(startS, endS - 8), endS)}>▶ Play end</button>
			<button type="button" class="rounded border border-[var(--color-tron-cyan)] px-3 text-[var(--color-tron-cyan)]" style="min-height: 44px;" onclick={() => playRange(startS, endS)}>▶ Play window</button>
			<button type="button" class="rounded border border-[var(--color-tron-border)] px-3" style="min-height: 44px;" onclick={() => { startS = suggested.startS; endS = suggested.endS; }}>Reset to suggested</button>
			<button type="button" disabled={working || !(lengthS >= 30)} class="ml-auto rounded bg-[var(--color-tron-green)] px-4 font-semibold text-[var(--color-tron-bg-primary)] disabled:opacity-40" style="min-height: 44px;" onclick={() => onVerify(startS, endS)}>
				{review?.status === 'verified' ? 'Re-verify window & re-analyze' : 'Verify window & analyze'}
			</button>
		</div>
		<div class="flex flex-wrap items-center gap-2 border-t border-[var(--color-tron-border)]/50 pt-3 text-sm">
			<input type="text" bind:value={unusableReason} placeholder="Why it can't be used (talking, door slam, phone moved, run interrupted, wrong unit…)" class="tron-input min-w-[260px] flex-1" style="min-height: 44px;" />
			<button type="button" disabled={working || !unusableReason.trim()} class="rounded border border-[var(--color-tron-red)] px-3 text-[var(--color-tron-red)] disabled:opacity-40" style="min-height: 44px;" onclick={() => onUnusable(unusableReason)}>Unusable – re-record</button>
		</div>
		{#if review}
			<p class="tron-text-muted text-xs">
				{#if review.status === 'verified'}Verified {review.startS}–{review.endS} s by {review.by} {review.at ? `on ${new Date(review.at).toLocaleString()}` : ''}.
				{:else}Marked unusable by {review.by}{review.reason ? `: ${review.reason}` : ''}.{/if}
			</p>
		{/if}
	</div>

	<!-- anomaly listener -->
	<div class="tron-card space-y-3 p-4">
		<div class="flex flex-wrap items-center gap-3">
			<h3 class="tron-heading font-semibold">Listen</h3>
			<span class="tron-text-muted text-xs">Pick an anomaly below or click a moment on the timeline.</span>
		</div>
		<div class="flex flex-wrap items-end gap-3 text-sm">
			<span>moment <b class="font-mono">{listenAt == null ? '—' : fmt(listenAt)}</b>{#if selected} · {selected.id} ({selected.kind}, step {selected.step ?? '—'}){/if}</span>
			<label class="flex flex-col">
				<span class="tron-text-muted text-xs">Pre (s)</span>
				<input type="number" step="0.1" min="0" max="30" bind:value={pre} class="tron-input w-24" style="min-height: 44px;" />
			</label>
			<label class="flex flex-col">
				<span class="tron-text-muted text-xs">Post (s)</span>
				<input type="number" step="0.1" min="0" max="30" bind:value={post} class="tron-input w-24" style="min-height: 44px;" />
			</label>
			<button type="button" disabled={listenAt == null} class="rounded bg-[var(--color-tron-orange)] px-4 font-semibold text-[var(--color-tron-bg-primary)] disabled:opacity-40" style="min-height: 44px;" onclick={playClip}>▶ Play clip</button>
		</div>

		{#if listenAt != null && mappedSteps?.length}
			<SonicCompare moment={listenAt} steps={mappedSteps} {audioSrc} {udi} others={compare} {pre} {post} onBeforePlay={() => audio?.pause()} />
		{:else if listenAt != null}
			<p class="tron-text-muted text-xs">Verify this recording's window to compare the same moment on other SPUs.</p>
		{/if}

		{#if anomalies.length}
			<div class="flex items-center gap-2 text-xs">
				<span class="tron-text-muted">Sort:</span>
				<button type="button" class="underline {sortBy === 'time' ? 'font-bold' : ''}" style="min-height: 32px;" onclick={() => (sortBy = 'time')}>time</button>
				<button type="button" class="underline {sortBy === 'severity' ? 'font-bold' : ''}" style="min-height: 32px;" onclick={() => (sortBy = 'severity')}>severity</button>
				{#if ignoredCount}
					<label class="ml-3 flex items-center gap-1" style="min-height: 32px;"><input type="checkbox" bind:checked={hideIgnored} /> hide ignored ({ignoredCount})</label>
				{/if}
				<button type="button" class="ml-auto underline" style="min-height: 32px;" onclick={() => (showRules = !showRules)}>Ignore rules ({ignoreRules.length}) {showRules ? '▲' : '▼'}</button>
			</div>
			{#if showRules}
				<div class="space-y-1 rounded border border-[var(--color-tron-border)] p-2 text-xs">
					<p class="tron-text-muted">Rules ignore matching anomalies on every SONIC recording. They stay listed (greyed) but leave the counts.</p>
					{#each ignoreRules as r (r.id)}
						<div class="flex flex-wrap items-center gap-2 border-t border-[var(--color-tron-border)]/40 pt-1">
							<b>{r.name}</b>
							<span class="font-mono">{ruleText(r)}</span>
							<span class="tron-text-muted">: {r.reason}{r.by ? ` (${r.by})` : ''}</span>
							<span class="tron-text-muted">· {anomalies.filter((a) => a.ignored?.source === 'rule' && a.ignored.id === r.id).length} here</span>
							{#if onRemoveRule}
								<button type="button" class="ml-auto underline" style="min-height: 32px;" disabled={working} onclick={() => { if (confirm(`Remove the rule "${r.name}"? Anomalies it ignored come back on every recording.`)) onRemoveRule(r.id); }}>remove</button>
							{/if}
						</div>
					{:else}
						<p class="tron-text-muted">No rules yet. Use "Ignore…" on an anomaly and choose "every SONIC recording".</p>
					{/each}
				</div>
			{/if}

			{#if ignoring}
				<div class="space-y-2 rounded border border-[var(--color-tron-orange)]/60 p-3 text-sm">
					<div class="flex flex-wrap items-center gap-2">
						<b>Ignore {ignoring.id}</b>
						<span class="tron-text-muted text-xs">{ignoring.kind}, step {ignoring.step ?? '—'}, {ignoring.fLo}–{ignoring.fHi} Hz, {ignoring.deltaDb > 0 ? '+' : ''}{ignoring.deltaDb} dB</span>
					</div>
					<div class="flex flex-wrap gap-2">
						{#each PRESETS as p (p.label)}
							<button type="button" class="rounded border border-[var(--color-tron-border)] px-3 text-xs" style="min-height: 36px;" onclick={() => applyPreset(p)}>{p.label}</button>
						{/each}
					</div>
					<label class="flex flex-col">
						<span class="tron-text-muted text-xs">Why is it being ignored? (required)</span>
						<textarea bind:value={igReason} rows="2" class="tron-input" placeholder="e.g. the SPU beeping to signal the test finished"></textarea>
					</label>
					<div class="flex flex-wrap gap-4">
						<label class="flex items-center gap-2" style="min-height: 36px;"><input type="radio" bind:group={igScope} value="one" /> Just this anomaly, on this recording</label>
						<label class="flex items-center gap-2" style="min-height: 36px;"><input type="radio" bind:group={igScope} value="rule" /> Every SONIC recording: a rule for anomalies like this</label>
					</div>
					{#if igScope === 'rule'}
						<div class="flex flex-wrap items-end gap-3">
							<label class="flex flex-col"><span class="tron-text-muted text-xs">Rule name</span><input bind:value={rule.name} class="tron-input w-48" style="min-height: 40px;" /></label>
							<label class="flex flex-col">
								<span class="tron-text-muted text-xs">Kind</span>
								<select bind:value={rule.kind} class="tron-input" style="min-height: 40px;">
									<option value={null}>any</option>
									{#each ['repetition', 'click', 'tone', 'reference'] as k (k)}<option value={k}>{k}</option>{/each}
								</select>
							</label>
							<label class="flex flex-col"><span class="tron-text-muted text-xs">Steps from</span><input type="number" min="1" max="48" bind:value={rule.stepFrom} class="tron-input w-20" style="min-height: 40px;" /></label>
							<label class="flex flex-col"><span class="tron-text-muted text-xs">to</span><input type="number" min="1" max="48" bind:value={rule.stepTo} class="tron-input w-20" style="min-height: 40px;" /></label>
							<label class="flex flex-col"><span class="tron-text-muted text-xs">Frequency ≥ (Hz)</span><input type="number" min="0" step="100" bind:value={rule.fMinHz} class="tron-input w-28" style="min-height: 40px;" /></label>
							<label class="flex flex-col"><span class="tron-text-muted text-xs">Frequency ≤ (Hz)</span><input type="number" min="0" step="100" bind:value={rule.fMaxHz} class="tron-input w-28" style="min-height: 40px;" /></label>
						</div>
						<p class="text-xs {ruleEmpty ? 'text-[var(--color-tron-orange)]' : 'tron-text-muted'}">
							{ruleEmpty ? 'Set at least one condition: an empty rule would ignore everything.' : `Matches ${rulePreview} of ${anomalies.length} anomalies on this recording; applies to every SONIC recording.`}
							Leave a box empty for "any".
						</p>
					{/if}
					<div class="flex flex-wrap gap-2">
						<button type="button" disabled={!canIgnore || working} class="rounded bg-[var(--color-tron-orange)] px-4 font-semibold text-[var(--color-tron-bg-primary)] disabled:opacity-40" style="min-height: 44px;" onclick={submitIgnore}>
							{igScope === 'one' ? 'Ignore this anomaly' : 'Create rule'}
						</button>
						<button type="button" class="rounded border border-[var(--color-tron-border)] px-4" style="min-height: 44px;" onclick={() => (ignoring = null)}>Cancel</button>
					</div>
				</div>
			{/if}

			<div class="max-h-96 overflow-y-auto">
				<table class="w-full text-left text-xs">
					<thead class="sticky top-0 bg-[var(--color-tron-bg-secondary)] text-[var(--color-tron-text-secondary)]">
						<tr><th class="py-1">#</th><th>time</th><th>step</th><th>kind</th><th>frequency</th><th class="text-right">Δ dB</th><th>severity</th><th></th><th>status</th></tr>
					</thead>
					<tbody>
						{#each listed as a (a.id)}
							<tr class="cursor-pointer border-t border-[var(--color-tron-border)]/40 {a.id === selectedId ? 'bg-[var(--color-tron-orange)]/10' : ''} {a.ignored ? 'opacity-50' : ''}" onclick={() => pick(a)}>
								<td class="py-1">{a.id}</td>
								<td class="font-mono">{fmt(a.t)}</td>
								<td title={a.stepLabel ?? ''}>{a.step ?? '—'}</td>
								<td title={a.note}>{a.kind}</td>
								<td>{a.fLo}–{a.fHi} Hz</td>
								<td class="text-right">{a.deltaDb > 0 ? '+' : ''}{a.deltaDb}</td>
								<td style="color: {sevColor[a.severity]}">{a.severity}</td>
								<td><button type="button" class="text-[var(--color-tron-orange)] underline" style="min-height: 32px;" onclick={(e) => { e.stopPropagation(); pick(a); playClip(); }}>▶</button></td>
								<td class="max-w-64">
									{#if a.ignored}
										<span class="block truncate" title="{a.ignored.reason} ({a.ignored.by ?? ''})">ignored{a.ignored.source === 'rule' ? ` (rule: ${a.ignored.name})` : ''}: {a.ignored.reason}</span>
										{#if a.ignored.source === 'manual' && onRestore}
											<button type="button" class="underline" style="min-height: 32px;" disabled={working} onclick={(e) => { e.stopPropagation(); if (a.ignored) onRestore(a.ignored.id); }}>restore</button>
										{/if}
									{:else if onIgnore}
										<button type="button" class="underline" style="min-height: 32px;" disabled={working} onclick={(e) => { e.stopPropagation(); pick(a); startIgnore(a); }}>Ignore…</button>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else if mappedSteps?.length}
			<p class="text-sm text-[var(--color-tron-green)]">No anomalies found in the verified window.</p>
		{/if}
	</div>
</div>
