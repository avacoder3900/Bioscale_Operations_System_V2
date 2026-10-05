<!--
	SONIC workflow steps 5–6 on one recording: trim & verify the test window, then
	review the step-mapped anomalies by ear.
	  - waveform (50 ms level) + fine spectrogram image, zoom/pan, playback cursor
	  - start/end handles (drag, type, or "set to cursor"), play start / end / window
	  - Verify window · Unusable – re-record (reason)
	  - 48 steps as bands (approximate until verified, then the fitted mapping)
	  - anomaly listener: pick an anomaly or click a moment, Pre/Post seconds, play the clip
-->
<script lang="ts" module>
	export interface ReviewStep {
		index: number;
		label: string;
		kind: string;
		t0: number;
		t1: number;
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
	}
</script>

<script lang="ts">
	import { onDestroy } from 'svelte';

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
	}
	let { durationS, envDb, frameS, audioSrc, spectroUrl, review, suggested, planTotalS, planSteps, mappedSteps, anomalies, working, onVerify, onUnusable }: Props = $props();

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
	function svgX(e: PointerEvent): number {
		const r = svg!.getBoundingClientRect();
		return ((e.clientX - r.left) / r.width) * W;
	}
	function onDown(e: PointerEvent) {
		if (!svg) return;
		const x = svgX(e);
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
		if (!drag || !svg) return;
		const t = Math.round(clampT(tx(svgX(e))) * 10) / 10;
		if (drag === 'start') startS = Math.min(t, endS - 1);
		else endS = Math.max(t, startS + 1);
	}
	function onUp(e: PointerEvent) {
		if (drag && svg) svg.releasePointerCapture(e.pointerId);
		drag = null;
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
	const listed = $derived(sortBy === 'time' ? anomalies : [...anomalies].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.t - b.t));
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
			<!-- trim handles -->
			{#each [['start', startS], ['end', endS]] as [name, t] (name)}
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

		{#if anomalies.length}
			<div class="flex items-center gap-2 text-xs">
				<span class="tron-text-muted">Sort:</span>
				<button type="button" class="underline {sortBy === 'time' ? 'font-bold' : ''}" style="min-height: 32px;" onclick={() => (sortBy = 'time')}>time</button>
				<button type="button" class="underline {sortBy === 'severity' ? 'font-bold' : ''}" style="min-height: 32px;" onclick={() => (sortBy = 'severity')}>severity</button>
			</div>
			<div class="max-h-96 overflow-y-auto">
				<table class="w-full text-left text-xs">
					<thead class="sticky top-0 bg-[var(--color-tron-bg-secondary)] text-[var(--color-tron-text-secondary)]">
						<tr><th class="py-1">#</th><th>time</th><th>step</th><th>kind</th><th>frequency</th><th class="text-right">Δ dB</th><th>severity</th><th></th></tr>
					</thead>
					<tbody>
						{#each listed as a (a.id)}
							<tr class="cursor-pointer border-t border-[var(--color-tron-border)]/40 {a.id === selectedId ? 'bg-[var(--color-tron-orange)]/10' : ''}" onclick={() => pick(a)}>
								<td class="py-1">{a.id}</td>
								<td class="font-mono">{fmt(a.t)}</td>
								<td title={a.stepLabel ?? ''}>{a.step ?? '—'}</td>
								<td title={a.note}>{a.kind}</td>
								<td>{a.fLo}–{a.fHi} Hz</td>
								<td class="text-right">{a.deltaDb > 0 ? '+' : ''}{a.deltaDb}</td>
								<td style="color: {sevColor[a.severity]}">{a.severity}</td>
								<td><button type="button" class="text-[var(--color-tron-orange)] underline" style="min-height: 32px;" onclick={(e) => { e.stopPropagation(); pick(a); playClip(); }}>▶</button></td>
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
