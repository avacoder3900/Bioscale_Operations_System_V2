/**
 * SONIC workflow step 6 — analysis of the operator-verified window, from the
 * fine spectrogram (no audio needed, so it is fast and re-runnable):
 *
 *   alignTimeline   fit the 48-step plan inside the window with dynamic time
 *                   warping: each part of the plan may run faster or slower than
 *                   the firmware's timing model (2026-10-05, SPU 210: moves and
 *                   repeats ran ~20 % fast, oscillations ~20 % slow), steps stay in
 *                   order. Matches the plan's expected loudness (oscillations loud,
 *                   long moves medium, 300 µm repeat moves quiet, waits silent) to
 *                   the recording's loudness.
 *   findAnomalies   (a) repetition check — every repeat/oscillation slice against
 *                       its siblings, band by band and moment by moment (works with
 *                       zero references);
 *                   (b) clicks and tones — short jumps / narrow tones that stand
 *                       out from the surrounding second;
 *                   (c) against references — each moment and band against the
 *                       verified reference recordings' mean ± σ (≥ 3 references).
 * Advisory only; never touches the release gate.
 */
import type { Spectrogram } from './spectrogram';
import { SPECTRO_EDGES } from './spectrogram';
import { expectedLoudness, type Timeline } from './timeline';

export const WINDOW_VERSION = 2; // 2 = steps placed from landmarks (estimated or adjusted)

// Alignment (dynamic time warping)
const ALIGN_CELL_S = 0.25; // plan and recording are compared in 0.25 s cells
const WARP_PENALTY = 0.12; // cost of letting one side run faster than the other for a cell
export const ALIGN_LOW_CORR = 0.5;

// Anomaly thresholds
const SIGMA_FLOOR_DB = 1.5;
const Z_FLAG = 4;
const MIN_DELTA_DB = 6;
const REF_Z_FLAG = 3;
const LOCAL_SPAN_S = 1; // clicks/tones: baseline = median of the surrounding ±1 s
const LOCAL_DELTA_DB = 12;
const MIN_PARTS = 3; // a step needs this many siblings for the repetition check
// The repetition check compares ~30k (moment, band) cells per step against siblings
// estimated from as few as 12 parts, so it only reports large, solid differences.
const REP_Z_FLAG = 5;
const REP_MIN_DELTA_DB = 10;
const REP_MIN_FRAMES = 3; // ≥ 150 ms
const REP_MIN_BANDS = 2;
const QUIET_MIN_BANDS = 8; // a "quieter than expected" difference must span this many bands
const EDGE_DB = 6; // a frame-to-frame loudness jump this big marks a quiet↔loud edge
const PART_SHIFT_FRAMES = 6; // ±0.3 s: how far a repetition may slide to line up with its siblings
const MAX_ANOMALIES = 60;
const FLOOR_PCT = 0.1; // a band's noise floor = its 10th percentile inside the window
const FLOOR_MARGIN_DB = 3; // comparisons never go below floor + this (a dip into silence is not a sound)
const SMOOTH_FRAMES = 3; // 150 ms power average before comparing
const BOUNDARY_GUARD_S = 0.35; // clicks/tones this close to a motion start/stop are the motion itself

export interface Alignment {
	method: 'dtw' | 'landmarks';
	gridS: number;
	/** Recording time (s) of plan time k·gridS, k = 0..; monotonic. */
	warp: number[];
	offsetS: number; // recording time of the plan's t = 0
	scale: number; // overall recording seconds per plan second (> 1 = slower than modelled)
	corr: number; // fit quality: expected vs recorded loudness along the warp, −1..1
	quality: 'good' | 'low';
}

/** Recording time of plan time `n` (seconds), following the fitted warp. */
export function mapPlanTime(al: Alignment, n: number): number {
	const k = n / al.gridS;
	const i = Math.floor(k);
	if (i < 0) return al.warp[0] + n;
	if (i >= al.warp.length - 1) return al.warp[al.warp.length - 1] + (k - (al.warp.length - 1)) * al.gridS;
	return al.warp[i] + (al.warp[i + 1] - al.warp[i]) * (k - i);
}

export type AnomalyKind = 'repetition' | 'click' | 'tone' | 'reference';
export type Severity = 'low' | 'medium' | 'high';

export interface Anomaly {
	id: string;
	kind: AnomalyKind;
	t0: number; // recording seconds
	t1: number;
	t: number; // the moment to listen to (strongest frame)
	step: number | null;
	stepLabel: string | null;
	fLo: number;
	fHi: number;
	deltaDb: number; // louder (+) / quieter (−) than expected, at the strongest point
	z: number;
	severity: Severity;
	note: string;
	/** Set when a person ignored it (this recording) or an ignore rule matches it. */
	ignored?: AnomalyIgnore | null;
}

export interface AnomalyIgnore {
	source: 'manual' | 'rule';
	/** The manual entry's id, or the rule's id. */
	id: string;
	name: string | null;
	reason: string;
	by: string | null;
	at: string | null;
}

export interface WindowAnalysis {
	version: number;
	window: { startS: number; endS: number };
	alignment: Alignment;
	steps: { index: number; kind: string; label: string; t0: number; t1: number }[];
	anomalies: Anomaly[];
	summary: {
		total: number; // anomalies still in play (not ignored)
		ignored?: number;
		bySeverity: Record<Severity, number>;
		byKind: Record<AnomalyKind, number>;
		stepsWithAnomalies: number[];
		referenceCount: number;
		truncated: boolean;
	};
}

// ---------------------------------------------------------------- helpers

export function frameAt(s: Spectrogram, t: number): number {
	return Math.round((t - s.t0) / s.frameS);
}
function timeOf(s: Spectrogram, f: number): number {
	return s.t0 + f * s.frameS;
}
export function levelDb(s: Spectrogram, f: number): number {
	let p = 0;
	for (let b = 0; b < s.bands; b++) p += 10 ** (s.db[f * s.bands + b] / 10);
	return 10 * Math.log10(p + 1e-20);
}
function median(a: number[]): number {
	if (!a.length) return NaN;
	const s = [...a].sort((x, y) => x - y);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mad(a: number[], m: number): number {
	return median(a.map((v) => Math.abs(v - m)));
}
export function pearson(a: number[], b: number[]): number {
	const n = a.length;
	if (n < 3) return 0;
	let ma = 0;
	let mb = 0;
	for (let i = 0; i < n; i++) {
		ma += a[i];
		mb += b[i];
	}
	ma /= n;
	mb /= n;
	let sab = 0;
	let saa = 0;
	let sbb = 0;
	for (let i = 0; i < n; i++) {
		const da = a[i] - ma;
		const db = b[i] - mb;
		sab += da * db;
		saa += da * da;
		sbb += db * db;
	}
	return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}
const r2 = (v: number) => Math.round(v * 100) / 100;
const r1 = (v: number) => Math.round(v * 10) / 10;

function severityOf(deltaDb: number, z: number): Severity {
	const d = Math.abs(deltaDb);
	if (d >= 20 && z >= 8) return 'high';
	if (d >= 12 || z >= 6) return 'medium';
	return 'low';
}

/**
 * Which differences count as a possible fault: anything LOUDER than expected (a
 * squeal, grind or rattle can be narrow), but QUIETER only when broadband — a
 * stalled or skipped move. A single narrow tone that most siblings have and one
 * lacks is normal position-to-position variation of the stage.
 */
function faultLike(g: Cell[]): boolean {
	const louder = g.filter((c) => c.delta > 0).length >= g.length / 2;
	return louder || new Set(g.map((c) => c.b)).size >= QUIET_MIN_BANDS;
}

/**
 * The spectrogram the comparisons use: 150 ms power-averaged, and clipped at each
 * band's own noise floor (+3 dB) inside [f0, f1). Low bands hold only a few FFT
 * bins, so in quiet frames they dip 20–30 dB at random; without the clip those
 * dips read as "this repetition is much quieter than its siblings".
 */
export function conditionForComparison(s: Spectrogram, f0: number, f1: number): Spectrogram {
	const a = Math.max(0, f0);
	const z = Math.min(s.frames, Math.max(a + 1, f1));
	const floor = new Float32Array(s.bands);
	for (let b = 0; b < s.bands; b++) {
		const v: number[] = [];
		for (let f = a; f < z; f++) v.push(s.db[f * s.bands + b]);
		v.sort((x, y) => x - y);
		floor[b] = (v[Math.floor(v.length * FLOOR_PCT)] ?? -200) + FLOOR_MARGIN_DB;
	}
	const out = new Float32Array(s.db.length);
	const h = SMOOTH_FRAMES >> 1;
	for (let f = 0; f < s.frames; f++) {
		for (let b = 0; b < s.bands; b++) {
			let p = 0;
			let n = 0;
			for (let k = Math.max(0, f - h); k <= Math.min(s.frames - 1, f + h); k++) {
				p += 10 ** (s.db[k * s.bands + b] / 10);
				n++;
			}
			out[f * s.bands + b] = Math.max(10 * Math.log10(p / n + 1e-20), floor[b]);
		}
	}
	return { ...s, db: out };
}

// ---------------------------------------------------------------- alignment

/**
 * Fit the plan inside the operator's window with subsequence dynamic time warping:
 * the whole plan is matched, in order, to some stretch of the window (free start
 * and end inside it); a plan cell may take less or more recording time than
 * modelled, at a small penalty, so the warp follows real speeds without jumping
 * around. The recording's loudness is scaled 0..1 between its quiet (10th
 * percentile) and loud (95th) levels inside the window.
 */
export function alignTimeline(s: Spectrogram, tl: Timeline, startS: number, endS: number): Alignment {
	const cell = ALIGN_CELL_S;
	const P = Math.max(2, Math.ceil(tl.totalS / cell));
	const plan = new Float32Array(P);
	for (let i = 0; i < P; i++) plan[i] = expectedLoudness(tl, (i + 0.5) * cell);

	const R = Math.max(2, Math.floor((endS - startS) / cell));
	const rawLev = new Float64Array(R);
	for (let j = 0; j < R; j++) {
		const fa = Math.max(0, frameAt(s, startS + j * cell));
		const fz = Math.min(s.frames - 1, frameAt(s, startS + (j + 1) * cell));
		let m = -Infinity;
		for (let f = fa; f <= fz; f++) m = Math.max(m, levelDb(s, f));
		rawLev[j] = Number.isFinite(m) ? m : -200;
	}
	const sorted = Array.from(rawLev).sort((x, y) => x - y);
	const lo = sorted[Math.floor(R * 0.1)];
	const hi = sorted[Math.min(R - 1, Math.floor(R * 0.95))];
	const rec = new Float32Array(R);
	for (let j = 0; j < R; j++) rec[j] = hi > lo ? Math.min(1, Math.max(0, (rawLev[j] - lo) / (hi - lo))) : 0;

	// D[i·R + j]: best cost of matching plan cells 0..i with plan cell i on recording cell j.
	const D = new Float32Array(P * R);
	const from = new Uint8Array(P * R); // 0 diagonal, 1 from (i−1, j): plan ran fast, 2 from (i, j−1): plan ran slow
	for (let j = 0; j < R; j++) D[j] = Math.abs(plan[0] - rec[j]); // free start anywhere in the window
	for (let i = 1; i < P; i++) {
		const row = i * R;
		const prev = (i - 1) * R;
		D[row] = D[prev] + WARP_PENALTY + Math.abs(plan[i] - rec[0]);
		from[row] = 1;
		for (let j = 1; j < R; j++) {
			const c = Math.abs(plan[i] - rec[j]);
			const dg = D[prev + j - 1];
			const up = D[prev + j] + WARP_PENALTY;
			const lf = D[row + j - 1] + WARP_PENALTY;
			if (dg <= up && dg <= lf) {
				D[row + j] = dg + c;
				from[row + j] = 0;
			} else if (up <= lf) {
				D[row + j] = up + c;
				from[row + j] = 1;
			} else {
				D[row + j] = lf + c;
				from[row + j] = 2;
			}
		}
	}
	// Free end: the best final cell anywhere in the window.
	let jEnd = 0;
	for (let j = 1; j < R; j++) if (D[(P - 1) * R + j] < D[(P - 1) * R + jEnd]) jEnd = j;
	// Backtrack: the recording cells matched to each plan cell.
	const sum = new Float64Array(P);
	const cnt = new Uint32Array(P);
	let i = P - 1;
	let j = jEnd;
	for (;;) {
		sum[i] += j;
		cnt[i]++;
		if (i === 0) break;
		const d = from[i * R + j];
		if (d === 0) {
			i--;
			j--;
		} else if (d === 1) i--;
		else j--;
		if (j < 0) j = 0;
	}
	const warp: number[] = [];
	const exp: number[] = [];
	const got: number[] = [];
	for (let k = 0; k < P; k++) {
		const jj = cnt[k] ? sum[k] / cnt[k] : 0;
		warp.push(startS + jj * cell); // start of the matched recording cell
		exp.push(plan[k]);
		got.push(rec[Math.min(R - 1, Math.round(jj))]);
	}
	for (let k = 1; k < warp.length; k++) if (warp[k] < warp[k - 1]) warp[k] = warp[k - 1]; // monotonic after averaging
	const corr = pearson(exp, got);
	const scale = (warp[warp.length - 1] - warp[0]) / Math.max(cell, (P - 1) * cell);
	return {
		method: 'dtw',
		gridS: cell,
		warp: warp.map(r2),
		offsetS: r2(warp[0]),
		scale: Math.round(scale * 10000) / 10000,
		corr: r2(corr),
		quality: corr >= ALIGN_LOW_CORR ? 'good' : 'low'
	};
}

/**
 * Fit quality of an alignment: correlation between the plan's expected loudness
 * and the recording's loudness (scaled 0..1 inside the window) along it.
 */
export function fitCorrelation(s: Spectrogram, tl: Timeline, al: Alignment, startS: number, endS: number): number {
	const cell = ALIGN_CELL_S;
	const lev: number[] = [];
	for (let t = startS; t < endS; t += cell) {
		const f = frameAt(s, t);
		if (f >= 0 && f < s.frames) lev.push(levelDb(s, f));
	}
	const sorted = [...lev].sort((x, y) => x - y);
	const lo = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
	const hi = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 1;
	const exp: number[] = [];
	const got: number[] = [];
	for (let n = 0; n < tl.totalS; n += cell) {
		const t = mapPlanTime(al, n);
		if (t < startS || t >= endS) continue;
		const f = frameAt(s, t);
		if (f < 0 || f >= s.frames) continue;
		exp.push(expectedLoudness(tl, n));
		got.push(hi > lo ? Math.min(1, Math.max(0, (levelDb(s, f) - lo) / (hi - lo))) : 0);
	}
	return Math.round(pearson(exp, got) * 100) / 100;
}

// ---------------------------------------------------------------- anomaly detection

interface Cell {
	t: number; // recording seconds
	f: number; // frame
	b: number; // band
	delta: number;
	z: number;
}

/** Group flagged (time, band) cells into regions: neighbours in time (≤ 1 frame gap) and band (adjacent). */
function regions(cells: Cell[], frameS: number): Cell[][] {
	const key = (c: Cell) => `${c.f}:${c.b}`;
	const byKey = new Map(cells.map((c) => [key(c), c]));
	const seen = new Set<string>();
	const out: Cell[][] = [];
	for (const c of cells) {
		const k0 = key(c);
		if (seen.has(k0)) continue;
		const group: Cell[] = [];
		const stack = [c];
		seen.add(k0);
		while (stack.length) {
			const cur = stack.pop()!;
			group.push(cur);
			for (let df = -2; df <= 2; df++) {
				for (let db = -1; db <= 1; db++) {
					const k = `${cur.f + df}:${cur.b + db}`;
					const nb = byKey.get(k);
					if (nb && !seen.has(k)) {
						seen.add(k);
						stack.push(nb);
					}
				}
			}
		}
		out.push(group);
	}
	void frameS;
	return out;
}

function toAnomaly(kind: AnomalyKind, group: Cell[], s: Spectrogram, note: string): Omit<Anomaly, 'id' | 'step' | 'stepLabel'> {
	let peak = group[0];
	let fMin = Infinity;
	let fMax = -Infinity;
	let bMin = Infinity;
	let bMax = -Infinity;
	for (const c of group) {
		if (Math.abs(c.z) > Math.abs(peak.z)) peak = c;
		fMin = Math.min(fMin, c.f);
		fMax = Math.max(fMax, c.f);
		bMin = Math.min(bMin, c.b);
		bMax = Math.max(bMax, c.b);
	}
	return {
		kind,
		t0: r2(timeOf(s, fMin) - s.frameS / 2),
		t1: r2(timeOf(s, fMax) + s.frameS / 2),
		t: r2(peak.t),
		fLo: Math.round(SPECTRO_EDGES[bMin]),
		fHi: Math.round(SPECTRO_EDGES[bMax + 1]),
		deltaDb: r1(peak.delta),
		z: r1(Math.abs(peak.z)),
		severity: severityOf(peak.delta, Math.abs(peak.z)),
		note
	};
}

/** (a) Every repetition/slice of a step against its siblings, at matching relative positions. */
function repetitionAnomalies(s: Spectrogram, tl: Timeline, al: Alignment) {
	const out: Omit<Anomaly, 'id' | 'step' | 'stepLabel'>[] = [];
	for (const st of tl.steps) {
		if (st.parts.length < MIN_PARTS) continue;
		// Oscillation slices only. A REPEAT's 300 µm moves are mostly inaudible (SPU 237,
		// step 7: 2 of 12 made a detectable sound), so its repetitions can't be timed from
		// the recording and "this repetition vs its siblings" compares a faint click with
		// silence. Repeat steps are left to the click/tone and reference checks.
		if (st.kind === 'repeat') continue;
		const partFrames = st.parts.map((p) => [frameAt(s, mapPlanTime(al, p.t0)), frameAt(s, mapPlanTime(al, p.t1))] as const);
		const K = Math.min(...partFrames.map(([a, z]) => z - a));
		if (!(K >= 2)) continue;
		const inRange = partFrames.filter(([a, z]) => a - PART_SHIFT_FRAMES >= 0 && z + PART_SHIFT_FRAMES <= s.frames);
		if (inRange.length < MIN_PARTS) continue;
		// The warp places parts to ±1 cell (0.25 s) and real repetitions jitter, so a few
		// frames' offset at a quiet→loud edge would read as a 15 dB "difference". Slide
		// each part (±0.3 s) onto the siblings' median loudness curve before comparing.
		const lev = (f: number) => levelDb(s, f);
		let starts = inRange.map(([a]) => a);
		for (let pass = 0; pass < 2; pass++) {
			const template: number[] = [];
			for (let j = 0; j < K; j++) template.push(median(starts.map((a) => lev(a + j))));
			starts = starts.map((a) => {
				let best = a;
				let bestErr = Infinity;
				for (let d = -PART_SHIFT_FRAMES; d <= PART_SHIFT_FRAMES; d++) {
					let err = 0;
					for (let j = 0; j < K; j++) err += (lev(a + d + j) - template[j]) ** 2;
					if (err < bestErr) {
						bestErr = err;
						best = a + d;
					}
				}
				return best;
			});
		}
		const usable = starts.map((a) => [a, a + K] as const);
		const cellsByPart: Cell[][] = usable.map(() => []);
		// Frames at a sharp quiet↔loud edge of the siblings' loudness are skipped: parts
		// last a fractional number of frames, so one repetition's edge lands a frame
		// earlier or later than another's, which is not a difference in sound.
		const tpl: number[] = [];
		for (let j = 0; j < K; j++) tpl.push(median(usable.map(([a]) => lev(a + j))));
		const atEdge = (j: number) => (j > 0 && Math.abs(tpl[j] - tpl[j - 1]) >= EDGE_DB) || (j < K - 1 && Math.abs(tpl[j + 1] - tpl[j]) >= EDGE_DB);
		for (let j = 0; j < K; j++) {
			if (atEdge(j)) continue;
			for (let b = 0; b < s.bands; b++) {
				const vals = usable.map(([a]) => s.db[(a + j) * s.bands + b]);
				const m = median(vals);
				const sd = Math.max(1.4826 * mad(vals, m), SIGMA_FLOOR_DB);
				usable.forEach(([a], i) => {
					const delta = vals[i] - m;
					const z = delta / sd;
					if (Math.abs(z) >= REP_Z_FLAG && Math.abs(delta) >= REP_MIN_DELTA_DB) {
						cellsByPart[i].push({ t: timeOf(s, a + j), f: a + j, b, delta, z });
					}
				});
			}
		}
		cellsByPart.forEach((cells, i) => {
			for (const g of regions(cells, s.frameS)) {
				// Short or one-band differences are noise (clicks have their own check).
				if (new Set(g.map((c) => c.f)).size < REP_MIN_FRAMES || new Set(g.map((c) => c.b)).size < REP_MIN_BANDS) continue;
				if (!faultLike(g)) continue;
				out.push(toAnomaly('repetition', g, s, `repetition ${i + 1} of ${usable.length} differs from its siblings`));
			}
		});
	}
	return out;
}

/** (b) Clicks (short, broadband) and tones (narrow, sustained) against the surrounding ±1 s. */
function localAnomalies(s: Spectrogram, f0: number, f1: number, boundaries: number[]) {
	const span = Math.max(2, Math.round(LOCAL_SPAN_S / s.frameS));
	const cells: Cell[] = [];
	const stride = 2; // baseline from every other frame keeps this fast
	for (let b = 0; b < s.bands; b++) {
		for (let f = f0; f < f1; f++) {
			const around: number[] = [];
			for (let k = Math.max(f0, f - span); k <= Math.min(f1 - 1, f + span); k += stride) if (Math.abs(k - f) > 1) around.push(s.db[k * s.bands + b]);
			if (around.length < 4) continue;
			const m = median(around);
			const sd = Math.max(1.4826 * mad(around, m), SIGMA_FLOOR_DB);
			const delta = s.db[f * s.bands + b] - m;
			const z = delta / sd;
			if (delta >= LOCAL_DELTA_DB && z >= Z_FLAG) cells.push({ t: timeOf(s, f), f, b, delta, z });
		}
	}
	const out: Omit<Anomaly, 'id' | 'step' | 'stepLabel'>[] = [];
	const nearBoundary = (t: number) => boundaries.some((x) => Math.abs(x - t) <= BOUNDARY_GUARD_S);
	for (const g of regions(cells, s.frameS)) {
		if (g.some((c) => nearBoundary(c.t))) continue; // the onset/stop of a motion, not a fault
		const frames = new Set(g.map((c) => c.f)).size;
		const bands = new Set(g.map((c) => c.b)).size;
		if (g.length < 2) continue;
		if (bands >= 8 && frames * s.frameS <= 0.3) out.push(toAnomaly('click', g, s, `short broadband jump (${bands} bands)`));
		else if (bands <= 4 && frames * s.frameS >= 0.3) out.push(toAnomaly('tone', g, s, `narrow tone for ${(frames * s.frameS).toFixed(1)} s`));
	}
	return out;
}

export interface ReferenceTrack {
	id: string;
	spec: Spectrogram;
	alignment: Alignment;
}

/**
 * (c) Each moment (0.25 s of the plan) and band against the references at the same
 * plan time. Levels are taken relative to each recording's own median level, so
 * phone distance / gain drops out (same idea as the compare page's "shape").
 */
function referenceAnomalies(s: Spectrogram, tl: Timeline, al: Alignment, refs: ReferenceTrack[]) {
	const out: Omit<Anomaly, 'id' | 'step' | 'stepLabel'>[] = [];
	if (refs.length < 3) return out;
	const medianLevel = (sp: Spectrogram, a: Alignment) => {
		const L: number[] = [];
		for (let n = 0; n < tl.totalS; n += 1) {
			const f = frameAt(sp, mapPlanTime(a, n));
			if (f >= 0 && f < sp.frames) L.push(levelDb(sp, f));
		}
		return median(L);
	};
	const runFrames = (sp: Spectrogram, a: Alignment) => [frameAt(sp, mapPlanTime(a, 0)), frameAt(sp, mapPlanTime(a, tl.totalS)) + 1] as const;
	refs = refs.map((r) => ({ ...r, spec: conditionForComparison(r.spec, ...runFrames(r.spec, r.alignment)) }));
	const mine = medianLevel(s, al);
	const refMed = refs.map((r) => medianLevel(r.spec, r.alignment));
	const cells: Cell[] = [];
	const STEP = 0.25;
	for (let n = 0; n < tl.totalS; n += STEP) {
		const f = frameAt(s, mapPlanTime(al, n));
		if (f < 0 || f >= s.frames) continue;
		const rf = refs.map((r) => frameAt(r.spec, mapPlanTime(r.alignment, n)));
		for (let b = 0; b < s.bands; b++) {
			const vals: number[] = [];
			rf.forEach((g, i) => {
				if (g >= 0 && g < refs[i].spec.frames) vals.push(refs[i].spec.db[g * refs[i].spec.bands + b] - refMed[i]);
			});
			if (vals.length < 3) continue;
			const mu = vals.reduce((x, y) => x + y, 0) / vals.length;
			const sd = Math.max(Math.sqrt(vals.reduce((x, y) => x + (y - mu) ** 2, 0) / (vals.length - 1)), SIGMA_FLOOR_DB);
			const delta = s.db[f * s.bands + b] - mine - mu;
			const z = delta / sd;
			if (Math.abs(z) >= REF_Z_FLAG && Math.abs(delta) >= MIN_DELTA_DB) cells.push({ t: timeOf(s, f), f, b, delta, z });
		}
	}
	for (const g of regions(cells, s.frameS)) {
		if (g.length < 2 || !faultLike(g)) continue;
		out.push(toAnomaly('reference', g, s, `outside the ${refs.length} references' range`));
	}
	return out;
}

/** Run alignment + every check on the verified window and build the report. */
export function analyzeWindow(
	s: Spectrogram,
	tl: Timeline,
	startS: number,
	endS: number,
	refs: ReferenceTrack[] = [],
	alignment?: Alignment
): WindowAnalysis {
	const al = alignment ?? alignTimeline(s, tl, startS, endS);
	const steps = tl.steps.map((st) => ({
		index: st.index,
		kind: st.kind,
		label: st.label,
		t0: r2(mapPlanTime(al, st.t0)),
		t1: r2(mapPlanTime(al, st.t1))
	}));
	const f0 = Math.max(0, frameAt(s, startS));
	const f1 = Math.min(s.frames, frameAt(s, endS) + 1);
	const clean = conditionForComparison(s, f0, f1);
	// Where motions start and stop (recording time): every step edge, every repetition
	// edge, and the move→wait edge inside each repetition.
	const boundaries: number[] = [];
	for (const st of tl.steps) {
		boundaries.push(mapPlanTime(al, st.t0), mapPlanTime(al, st.t1));
		for (const p of st.parts) {
			boundaries.push(mapPlanTime(al, p.t0));
			let t = p.t0;
			for (const seg of st.pattern ?? []) {
				t += seg.d;
				boundaries.push(mapPlanTime(al, t));
			}
		}
	}
	const raw = [...repetitionAnomalies(clean, tl, al), ...localAnomalies(s, f0, f1, boundaries), ...referenceAnomalies(clean, tl, al, refs)]
		.filter((a) => a.t >= startS && a.t <= endS);
	// Strongest first; drop a weaker anomaly whose moment falls inside a stronger one's span (same sound found twice).
	raw.sort((a, b) => Math.abs(b.deltaDb) * b.z - Math.abs(a.deltaDb) * a.z);
	const kept: typeof raw = [];
	for (const a of raw) {
		if (kept.some((k) => a.t >= k.t0 - 0.1 && a.t <= k.t1 + 0.1 && a.fLo < k.fHi && a.fHi > k.fLo)) continue;
		kept.push(a);
	}
	const truncated = kept.length > MAX_ANOMALIES;
	const anomalies: Anomaly[] = kept
		.slice(0, MAX_ANOMALIES)
		.sort((a, b) => a.t - b.t)
		.map((a, i) => {
			const st = steps.find((x) => a.t >= x.t0 && a.t < x.t1) ?? null;
			return { ...a, id: `A${i + 1}`, step: st?.index ?? null, stepLabel: st?.label ?? null };
		});
	return {
		version: WINDOW_VERSION,
		window: { startS: r2(startS), endS: r2(endS) },
		alignment: al,
		steps,
		anomalies,
		summary: summarizeAnomalies(anomalies, refs.length, truncated)
	};
}

/** Counts over the anomalies still in play — ignored ones are only counted as `ignored`. */
export function summarizeAnomalies(anomalies: Anomaly[], referenceCount: number, truncated: boolean): WindowAnalysis['summary'] {
	const bySeverity: Record<Severity, number> = { low: 0, medium: 0, high: 0 };
	const byKind: Record<AnomalyKind, number> = { repetition: 0, click: 0, tone: 0, reference: 0 };
	const active = anomalies.filter((a) => !a.ignored);
	for (const a of active) {
		bySeverity[a.severity]++;
		byKind[a.kind]++;
	}
	return {
		total: active.length,
		ignored: anomalies.length - active.length,
		bySeverity,
		byKind,
		stepsWithAnomalies: [...new Set(active.map((a) => a.step).filter((x): x is number => x != null))].sort((a, b) => a - b),
		referenceCount,
		truncated
	};
}

/**
 * Default trim: `preS` before the first detected motion, and — counting the plan
 * from that motion (it starts `firstMoveS` into the plan, after Start Test) — the
 * plan's end plus `postS`.
 */
export function suggestWindow(
	events: [number, number, number, number, number | null][],
	durationS: number,
	planS: number,
	firstMoveS: number,
	preS = 1,
	postS = 1
): { startS: number; endS: number } {
	const first = events.length ? events[0][0] : 0;
	const startS = Math.max(0, first - preS);
	const endS = Math.min(durationS, first - firstMoveS + planS + postS);
	return { startS: r2(startS), endS: r2(Math.max(endS, Math.min(durationS, startS + 1))) };
}
