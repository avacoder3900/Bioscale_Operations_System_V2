/**
 * SONIC step placement from loud landmarks (2026-10-05 rework).
 *
 *   estimateLandmarks  the analysis' first guess: the plan's sequence of landmarks
 *                      matched to the recording's sequence of loud stretches (expected
 *                      lengths and gaps from the measured timeline when one exists).
 *                      Each estimate says whether it was found in the sound or only
 *                      predicted. A person can then adjust any of them.
 *   measuredDurations  the real duration of every step, as the median over other
 *                      verified recordings (confirmed placements preferred) —
 *                      replaces the firmware timing model, which is wrong and wrong
 *                      differently for moves (fast) and oscillations (slow).
 *   placementAlignment the placed steps as an Alignment over the fixed (modelled)
 *                      plan time, so the anomaly checks and reference comparison
 *                      work unchanged and stay comparable across recordings.
 */
import { ValidationSession } from '$lib/server/db';
import { placeSteps, planToRecording, type Landmark, type PlacedStep } from '$lib/sonic-placement';
import type { Spectrogram } from './spectrogram';
import { planSteps, type Timeline } from './timeline';
import { fitCorrelation, frameAt, levelDb, ALIGN_LOW_CORR, type Alignment } from './window';

const SEG_CELL_S = 0.1;
const SEG_ON = 0.35; // a cell is "loud" above this, on the window's 0..1 loudness scale
const SEG_MIN_S = 0.3;
const SEG_MERGE_GAP_S = 0.6; // an oscillation can dip quiet for a moment
const MIN_RECORDINGS_FOR_MEASURED = 3;

export interface Segment {
	t0: number;
	t1: number;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Stretches of the window that are clearly louder than its quiet level. */
export function detectSegments(s: Spectrogram, startS: number, endS: number): Segment[] {
	const cells: { t: number; L: number }[] = [];
	for (let t = startS; t < endS; t += SEG_CELL_S) {
		const fa = Math.max(0, frameAt(s, t));
		const fz = Math.min(s.frames - 1, frameAt(s, t + SEG_CELL_S));
		let m = -Infinity;
		for (let f = fa; f <= fz; f++) m = Math.max(m, levelDb(s, f));
		if (Number.isFinite(m)) cells.push({ t, L: m });
	}
	if (!cells.length) return [];
	const sorted = cells.map((c) => c.L).sort((a, b) => a - b);
	const lo = sorted[Math.floor(sorted.length * 0.1)];
	const hi = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
	const on = (L: number) => (hi > lo ? (L - lo) / (hi - lo) : 0) >= SEG_ON;
	const raw: Segment[] = [];
	let a: number | null = null;
	for (const c of cells) {
		if (on(c.L) && a == null) a = c.t;
		else if (!on(c.L) && a != null) {
			raw.push({ t0: a, t1: c.t });
			a = null;
		}
	}
	if (a != null) raw.push({ t0: a, t1: endS });
	const merged: Segment[] = [];
	for (const g of raw) {
		const last = merged[merged.length - 1];
		if (last && g.t0 - last.t1 <= SEG_MERGE_GAP_S) last.t1 = g.t1;
		else merged.push({ ...g });
	}
	return merged.filter((g) => g.t1 - g.t0 >= SEG_MIN_S).map((g) => ({ t0: r2(g.t0), t1: r2(g.t1) }));
}

/**
 * Default real-speed factors vs the firmware model, until measured durations
 * exist (2026-10-05, 11 units): ±2000 µm moves take ~1.6 s for a modelled 3.2 s,
 * oscillations ~1.2× their modelled time.
 */
const KIND_FACTOR: Record<string, number> = { move: 0.5, oscillate: 1.2, delay: 1, start: 1, finish: 1, other: 1 };

/** Expected real duration of every step: measured when known, else firmware × kind factor. */
export function expectedDurations(tl: Timeline, measured: (number | null)[] | null): number[] {
	return tl.steps.map((st, i) => {
		const m = measured?.[i];
		if (m != null && Number.isFinite(m) && m > 0) return m;
		const nominal = st.t1 - st.t0;
		if (st.kind === 'repeat' && st.pattern?.length && st.parts.length) {
			// One repetition = its inner moves (fast) + waits; the pattern stores loudness, so
			// treat any inner segment with loudness > 0 as a move.
			const one = st.pattern.reduce((sum, seg) => sum + seg.d * (seg.loudness > 0 ? KIND_FACTOR.move : 1), 0);
			return one * st.parts.length;
		}
		return nominal * (KIND_FACTOR[st.kind] ?? 1);
	});
}

// Sequence-matching costs (relative errors; see estimateLandmarks).
const SHARE_GAP_S = 1.0; // landmarks this close in the plan may share one loud stretch
const W_DUR = 1.0;
const W_GAP = 1.0;
const W_LEAD = 0.2;
const SKIP_SEGMENT = 0.15; // a loud stretch that is no landmark (an audible small move, a noise)
const MISS_LANDMARK = 2.0;

/**
 * First guess at every landmark, by matching the plan's sequence of landmarks to
 * the recording's sequence of loud stretches in one go (dynamic programming):
 *   - each landmark has an expected length, and consecutive landmarks an expected
 *     gap (the steps between them), from the measured timeline or the defaults;
 *   - landmarks that follow each other with no real gap (an oscillation running
 *     straight into a move) may SHARE one stretch — it is split by expected length;
 *   - a stretch that is no landmark can be skipped at a small cost, and a landmark
 *     can be missing (the run was cut short) at a large one — nothing is squeezed.
 * Cost = how far each stretch's length and each gap are from expected, relative.
 * Estimates are marked found: true; a missing landmark is predicted from its
 * neighbours and marked found: false. Everything here is a starting point the
 * person reviewing can adjust.
 */
export function estimateLandmarks(
	s: Spectrogram,
	tl: Timeline,
	startS: number,
	endS: number,
	durations: (number | null)[] | null
): { landmarks: Landmark[]; segments: Segment[] } {
	const exp = expectedDurations(tl, durations);
	const lm = tl.steps.map((st, i) => ({ st, i })).filter((x) => x.st.landmark);
	const segs = detectSegments(s, startS, endS);
	const K = lm.length;
	const J = segs.length;
	// Sounding tail of landmark k: small moves/oscillations that follow it with no wait
	// in between are heard as part of the same stretch (237: the −1750 µm move runs
	// straight into a 2-cycle oscillation and a 550 µm move, one 2.5 s sound).
	const ext: number[] = lm.map((x, k) => {
		const until = k + 1 < K ? lm[k + 1].i : tl.steps.length;
		let t = 0;
		for (let i = x.i + 1; i < until; i++) {
			const kind = tl.steps[i].kind;
			if (kind !== 'move' && kind !== 'oscillate') break;
			t += exp[i];
		}
		return t;
	});
	// Expected silent-ish gap after landmark k (the rest of the steps before landmark k+1), and lead before landmark 0.
	const gap: number[] = [];
	for (let k = 0; k < K - 1; k++) {
		let g = 0;
		for (let i = lm[k].i + 1; i < lm[k + 1].i; i++) g += exp[i];
		gap.push(Math.max(0, g - ext[k]));
	}
	let lead = 0;
	for (let i = 0; i < (lm[0]?.i ?? 0); i++) lead += exp[i];
	const e = lm.map((x) => exp[x.i]);
	const rel = (actual: number, want: number) => Math.abs(actual - want) / (1 + want);

	if (!K) return { landmarks: [], segments: segs };
	// State: landmark k is on segment j, in a group (sharing j) that began at landmark g0.
	// dp key = k*J*K + j*K + g0 ; value = cost. Missing landmarks are handled by letting a
	// transition skip one or more landmarks (their expected time folds into the gap).
	const INF = 1e18;
	const idx = (k: number, j: number, g0: number) => (k * J + j) * K + g0;
	const dp = new Float64Array(K * Math.max(J, 1) * K).fill(INF);
	const back = new Int32Array(K * Math.max(J, 1) * K).fill(-1);
	const groupLen = (g0: number, k: number) => {
		let t = 0;
		for (let q = g0; q <= k; q++) t += e[q] + ext[q] + (q < k ? gap[q] : 0);
		return t;
	};
	const closeCost = (j: number, g0: number, k: number) => W_DUR * rel(segs[j].t1 - segs[j].t0, groupLen(g0, k));
	if (!J) {
		return { landmarks: [], segments: segs };
	}
	// Start: the first placed landmark k0 (k0 > 0 means landmarks 0..k0-1 are missing).
	for (let k0 = 0; k0 < K; k0++) {
		let leadK = lead;
		for (let q = 0; q < k0; q++) leadK += e[q] + ext[q] + gap[q];
		for (let j = 0; j < J; j++) {
			const c = k0 * MISS_LANDMARK + W_LEAD * rel(Math.max(0, segs[j].t0 - startS), leadK) + j * SKIP_SEGMENT;
			const id = idx(k0, j, k0);
			if (c < dp[id]) {
				dp[id] = c;
				back[id] = -2; // start
			}
		}
	}
	for (let k = 0; k < K; k++) {
		for (let j = 0; j < J; j++) {
			for (let g0 = 0; g0 <= k; g0++) {
				const cur = dp[idx(k, j, g0)];
				if (cur >= INF) continue;
				const from = idx(k, j, g0);
				// (a) next landmark shares this stretch.
				if (k + 1 < K && gap[k] <= SHARE_GAP_S) {
					const id = idx(k + 1, j, g0);
					if (cur < dp[id]) {
						dp[id] = cur;
						back[id] = from;
					}
				}
				// (b) the next placed landmark (k + 1 + miss) starts a new group on a later stretch.
				for (let miss = 0; k + 1 + miss < K && miss <= 3; miss++) {
					const kn = k + 1 + miss;
					let g = gap[k];
					for (let q = k + 1; q < kn; q++) g += e[q] + ext[q] + gap[q];
					const base = cur + closeCost(j, g0, k) + miss * MISS_LANDMARK;
					for (let jn = j + 1; jn < J; jn++) {
						const c = base + W_GAP * rel(segs[jn].t0 - segs[j].t1, g) + (jn - j - 1) * SKIP_SEGMENT;
						const id = idx(kn, jn, kn);
						if (c < dp[id]) {
							dp[id] = c;
							back[id] = from;
						}
					}
				}
			}
		}
	}
	// End: the last placed landmark (any after it are missing — a cut-short run).
	let best = INF;
	let bestId = -1;
	for (let k = 0; k < K; k++) {
		for (let j = 0; j < J; j++) {
			for (let g0 = 0; g0 <= k; g0++) {
				const cur = dp[idx(k, j, g0)];
				if (cur >= INF) continue;
				const c = cur + closeCost(j, g0, k) + (K - 1 - k) * MISS_LANDMARK + (J - 1 - j) * SKIP_SEGMENT;
				if (c < best) {
					best = c;
					bestId = idx(k, j, g0);
				}
			}
		}
	}
	// Backtrack: which stretch each placed landmark is on.
	const segOf = new Array<number>(K).fill(-1);
	for (let id = bestId; id >= 0; ) {
		const k = Math.floor(id / (J * K));
		const j = Math.floor((id % (J * K)) / K);
		segOf[k] = j;
		const prev = back[id];
		if (prev === -2) break;
		id = prev;
	}
	// Times: each stretch split among the landmarks sharing it, in proportion to expected length.
	const t0 = new Array<number>(K).fill(NaN);
	const t1 = new Array<number>(K).fill(NaN);
	for (let k = 0; k < K; ) {
		const j = segOf[k];
		if (j < 0) {
			k++;
			continue;
		}
		let m = k;
		while (m + 1 < K && segOf[m + 1] === j) m++;
		const total = groupLen(k, m);
		const seg = segs[j];
		const scale = total > 0 ? (seg.t1 - seg.t0) / total : 0;
		let t = seg.t0;
		for (let q = k; q <= m; q++) {
			t0[q] = t;
			t += e[q] * scale;
			t1[q] = t;
			t += ext[q] * scale; // its sounding tail
			if (q < m) t += gap[q] * scale;
		}
		k = m + 1;
	}
	// Missing landmarks: predicted from the nearest placed neighbours at expected durations.
	for (let k = 0; k < K; k++) {
		if (Number.isFinite(t0[k])) continue;
		let p = k - 1;
		while (p >= 0 && !Number.isFinite(t0[p])) p--;
		let start: number;
		if (p >= 0) {
			start = t1[p];
			for (let q = p; q < k; q++) start += ext[q] + gap[q] + (q > p ? e[q] : 0);
		} else {
			let n = k + 1;
			while (n < K && !Number.isFinite(t0[n])) n++;
			start = n < K ? t0[n] : startS + lead;
			for (let q = k; q < n; q++) start -= e[q] + ext[q] + gap[q];
		}
		t0[k] = start;
		t1[k] = start + e[k];
	}
	const landmarks: Landmark[] = lm.map((x, k) => ({
		step: x.st.index,
		t0: r2(t0[k]),
		t1: r2(Math.max(t1[k], t0[k] + 0.05)),
		source: 'estimate',
		found: segOf[k] >= 0
	}));
	return { landmarks, segments: segs };
}

/** User adjustments win; any landmark the user didn't touch keeps the analysis' estimate. */
export function mergeLandmarks(estimates: Landmark[], user: Landmark[] | null | undefined): Landmark[] {
	if (!user?.length) return estimates;
	const byStep = new Map(user.map((l) => [l.step, { ...l, source: 'user' as const }]));
	const merged = estimates.map((e) => byStep.get(e.step) ?? e);
	for (const u of byStep.values()) if (!merged.some((m) => m.step === u.step)) merged.push(u);
	return merged.sort((a, b) => a.step - b.step);
}

/** The placed steps as an Alignment over the fixed (modelled) plan time. */
export function placementAlignment(s: Spectrogram, tl: Timeline, placed: PlacedStep[], startS: number, endS: number): Alignment {
	const plan = planSteps(tl);
	const gridS = 0.25;
	const warp: number[] = [];
	for (let n = 0; n <= tl.totalS + 1e-9; n += gridS) warp.push(r2(planToRecording(plan, placed, n)));
	const al: Alignment = {
		method: 'landmarks',
		gridS,
		warp,
		offsetS: r2(placed[0]?.t0 ?? startS),
		scale: Math.round(((placed[placed.length - 1]?.t1 ?? endS) - (placed[0]?.t0 ?? startS)) / Math.max(1, tl.totalS) * 10000) / 10000,
		corr: 0,
		quality: 'low'
	};
	al.corr = fitCorrelation(s, tl, al, startS, endS);
	al.quality = al.corr >= ALIGN_LOW_CORR ? 'good' : 'low';
	return al;
}

/** Place every step from the landmarks (measured durations between them). */
export function placeFromLandmarks(tl: Timeline, landmarks: Landmark[], durations: (number | null)[] | null, recordingS: number): PlacedStep[] {
	return placeSteps(planSteps(tl), durations, landmarks, recordingS);
}

/**
 * Real duration of every step: the median over other verified SONIC recordings
 * whose steps were placed from landmarks — confirmed placements only once there are
 * enough of them, otherwise every placed recording. null until there are enough.
 */
export async function measuredDurations(tl: Timeline, excludeId?: string): Promise<{ durations: (number | null)[]; from: number; confirmedOnly: boolean } | null> {
	const rows = (await ValidationSession.find({
		...(excludeId ? { _id: { $ne: excludeId } } : {}),
		type: 'sonic',
		'results.0.rawData.assay': 'SONIC',
		'results.0.rawData.review.status': 'verified',
		'results.0.processedData.windowAnalysis.alignment.method': 'landmarks'
	})
		.select('results.rawData.stepPlacement.confirmed results.processedData.windowAnalysis.steps')
		.limit(200)
		.lean()) as any[];
	const all = rows
		.map((r) => ({ confirmed: !!r.results?.[0]?.rawData?.stepPlacement?.confirmed, steps: r.results?.[0]?.processedData?.windowAnalysis?.steps as any[] | undefined }))
		.filter((r) => Array.isArray(r.steps) && r.steps.length === tl.steps.length);
	const confirmed = all.filter((r) => r.confirmed);
	const use = confirmed.length >= MIN_RECORDINGS_FOR_MEASURED ? confirmed : all;
	if (use.length < MIN_RECORDINGS_FOR_MEASURED) return null;
	const durations = tl.steps.map((_, i) => {
		const ds = use
			.map((r) => r.steps![i])
			.filter((x) => x && x.inRecording !== false && Number.isFinite(x.t0) && Number.isFinite(x.t1) && x.t1 > x.t0)
			.map((x) => x.t1 - x.t0)
			.sort((a, b) => a - b);
		if (ds.length < MIN_RECORDINGS_FOR_MEASURED) return null;
		const m = ds.length >> 1;
		return r2(ds.length % 2 ? ds[m] : (ds[m - 1] + ds[m]) / 2);
	});
	return { durations, from: use.length, confirmedOnly: use === confirmed && confirmed.length >= MIN_RECORDINGS_FOR_MEASURED };
}
