/**
 * Smoothing a recording's path (Clean-up tab). Pure, no I/O.
 *
 * A teleop recording (or an overlay of one) carries every wobble of the
 * pilot's hand. Clean-up's step editor replaces each step with a straight
 * line, which removes the wobble but stops dead at every step and flattens
 * curves. This smooths the dense path itself instead:
 *
 *   1. Stops. Stretches where every corrected servo stays within
 *      STOP_STEPS of itself for at least STOP_MIN_S are stops. With
 *      `keepStops` each stop is pinned to its median position for every
 *      servo, so the arm still arrives exactly where the pilot held it (the
 *      pose is the point of a teleop recording) and the tremor during the
 *      hold is gone.
 *   2. Smoothing. Three passes of a centred moving average whose total
 *      width is `windowS` (close to a Gaussian, no lag), re-pinning the
 *      stops and the first and last frame after every pass, so moves ease
 *      into and out of each stop instead of jumping onto it.
 *   3. Strength blends the result with the source: 100% = smoothed,
 *      0% = the source as it is.
 *
 * The source is either the recording's own frames or the clean-up's steps
 * as composeRecording renders them (straight lines with stops); the second
 * rounds the corners of the steps. The first and last frame never move, so
 * a saved recording starts where its source did (Control's ±50-step replay
 * preflight) — except when the recording starts or ends in a stop, where
 * that frame takes the stop's median (a few steps of tremor away).
 *
 * Positions are encoder steps, servo ids 1..6 at array index 0..5.
 */
import { ENCODER_MAX, SERVO_COUNT } from './animation';

export interface Series {
	t: number[];
	goal: number[][];
}

export type SmoothSource = 'recording' | 'steps';

export const SMOOTH_SOURCES: { id: SmoothSource; label: string; hint: string }[] = [
	{ id: 'recording', label: 'The recording', hint: 'Smooth the recorded path itself, keeping its curves and timing' },
	{ id: 'steps', label: 'Your steps', hint: 'Smooth the steps as edited above (rounds the corners of the straight lines)' }
];

export interface SmoothOptions {
	/** Save to Pi writes the smoothed path when on; the steps as straight lines when off. */
	enabled: boolean;
	source: SmoothSource;
	/** Total width of the smoothing, seconds. */
	windowS: number;
	/** 0..1 blend between the source (0) and the smoothed path (1). */
	strength: number;
	/** Pin every stop to its median position. */
	keepStops: boolean;
	/** Servo ids (1..6) that are smoothed; the others keep the source. */
	servos: number[];
}

export const DEFAULT_SMOOTH_OPTIONS: SmoothOptions = {
	enabled: true,
	source: 'recording',
	windowS: 0.6,
	strength: 1,
	keepStops: true,
	servos: [1, 2, 3, 4, 5, 6]
};
/** Off: what a clean-up made before smoothing existed has. */
export const SMOOTHING_OFF: SmoothOptions = { ...DEFAULT_SMOOTH_OPTIONS, enabled: false };

export const MAX_SMOOTH_WINDOW_S = 3;
/** A stop: every corrected servo within this many steps of its own median... */
export const STOP_STEPS = 6;
/** ...for at least this long. */
export const STOP_MIN_S = 0.3;

export function isSmoothSource(v: unknown): v is SmoothSource {
	return v === 'recording' || v === 'steps';
}

export function seriesRate(s: Series): number {
	const n = s.t.length;
	if (n < 2) return 30;
	const span = s.t[n - 1] - s.t[0];
	return span > 0 ? (n - 1) / span : 30;
}

function boxPass(v: Float64Array, half: number, out: Float64Array) {
	const n = v.length;
	const prefix = new Float64Array(n + 1);
	for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + v[i];
	for (let i = 0; i < n; i++) {
		const a = Math.max(0, i - half);
		const b = Math.min(n, i + half + 1);
		out[i] = (prefix[b] - prefix[a]) / (b - a);
	}
}

function median(v: number[]): number {
	const s = [...v].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Stops: maximal runs of frames where every servo in `servos` stays within
 * ±STOP_STEPS of a running reference, lasting at least STOP_MIN_S. Returned
 * as inclusive frame ranges, in order.
 */
export function findStops(s: Series, servos: number[] = [1, 2, 3, 4, 5, 6], o: { steps?: number; minS?: number } = {}): { from: number; to: number }[] {
	const steps = o.steps ?? STOP_STEPS;
	const minS = o.minS ?? STOP_MIN_S;
	const idx = servos.map((sid) => sid - 1);
	const out: { from: number; to: number }[] = [];
	const n = s.goal.length;
	let start = 0;
	while (start < n) {
		// Grow a run from `start` while every servo stays inside a 2·steps band.
		const lo = idx.map((j) => s.goal[start][j]);
		const hi = [...lo];
		let end = start;
		for (let i = start + 1; i < n; i++) {
			let ok = true;
			for (let k = 0; k < idx.length; k++) {
				const v = s.goal[i][idx[k]];
				if (Math.max(hi[k], v) - Math.min(lo[k], v) > 2 * steps) {
					ok = false;
					break;
				}
			}
			if (!ok) break;
			for (let k = 0; k < idx.length; k++) {
				const v = s.goal[i][idx[k]];
				lo[k] = Math.min(lo[k], v);
				hi[k] = Math.max(hi[k], v);
			}
			end = i;
		}
		if (s.t[end] - s.t[start] >= minS) {
			out.push({ from: start, to: end });
			start = end + 1;
		} else {
			start += 1;
		}
	}
	return out;
}

export interface SmoothServoSummary {
	servoId: number;
	smoothed: boolean;
	/** Largest change from the source, steps (absolute). */
	maxChange: number;
	/** Mean absolute change from the source, steps. */
	meanChange: number;
}

export interface SmoothResult {
	goal: number[][];
	stops: { from: number; to: number }[];
	servos: SmoothServoSummary[];
	/** Fastest servo speed in the result, steps/s (frame to frame). */
	peakSpeed: number;
	/** Same for the source, for comparison. */
	sourcePeakSpeed: number;
}

function peakSpeed(t: number[], goal: number[][]): number {
	let p = 0;
	for (let i = 1; i < goal.length; i++) {
		const dt = t[i] - t[i - 1];
		if (dt <= 0) continue;
		for (let j = 0; j < SERVO_COUNT; j++) p = Math.max(p, Math.abs(goal[i][j] - goal[i - 1][j]) / dt);
	}
	return Math.round(p);
}

/** The source smoothed with `o` (enabled is ignored: this always smooths). */
export function smoothSeries(src: Series, o: SmoothOptions): SmoothResult {
	const n = src.goal.length;
	const goal = src.goal.map((r) => [...r]);
	const empty = (corrected: boolean, sid: number): SmoothServoSummary => ({ servoId: sid, smoothed: corrected, maxChange: 0, meanChange: 0 });
	if (n < 3 || !o.servos.length) {
		return {
			goal,
			stops: [],
			servos: Array.from({ length: SERVO_COUNT }, (_, j) => empty(o.servos.includes(j + 1), j + 1)),
			peakSpeed: peakSpeed(src.t, goal),
			sourcePeakSpeed: peakSpeed(src.t, src.goal)
		};
	}
	const rate = seriesRate(src);
	// Three passes of width b ≈ total width windowS.
	const half = Math.max(0, Math.round((o.windowS * rate) / 3 / 2));
	const stops = o.keepStops ? findStops(src, o.servos) : [];
	const servos: SmoothServoSummary[] = [];
	for (let j = 0; j < SERVO_COUNT; j++) {
		const sid = j + 1;
		if (!o.servos.includes(sid)) {
			servos.push(empty(false, sid));
			continue;
		}
		const raw = src.goal.map((r) => r[j]);
		// Anchors: the first and last frame, and the middle of every stop at its median. Half the
		// smoothing width at each inner edge of a stop is left free, so the move eases into it.
		const pinned = new Float64Array(n).fill(NaN);
		pinned[0] = raw[0];
		pinned[n - 1] = raw[n - 1];
		const edge = 3 * half;
		for (const st of stops) {
			const m = median(raw.slice(st.from, st.to + 1));
			let a = st.from === 0 ? 0 : st.from + edge;
			let b = st.to === n - 1 ? n - 1 : st.to - edge;
			if (a > b) a = b = Math.round((st.from + st.to) / 2);
			for (let i = a; i <= b; i++) pinned[i] = m;
		}
		let y = Float64Array.from(raw, (v, i) => (Number.isNaN(pinned[i]) ? v : pinned[i]));
		if (half > 0) {
			const tmp = new Float64Array(n);
			for (let pass = 0; pass < 3; pass++) {
				boxPass(y, half, tmp);
				for (let i = 0; i < n; i++) y[i] = Number.isNaN(pinned[i]) ? tmp[i] : pinned[i];
			}
		}
		let maxC = 0;
		let sumC = 0;
		for (let i = 0; i < n; i++) {
			const v = Math.max(0, Math.min(ENCODER_MAX, Math.round(raw[i] + o.strength * (y[i] - raw[i]))));
			goal[i][j] = v;
			const c = Math.abs(v - raw[i]);
			maxC = Math.max(maxC, c);
			sumC += c;
		}
		servos.push({ servoId: sid, smoothed: true, maxChange: maxC, meanChange: Math.round((sumC / n) * 10) / 10 });
	}
	return { goal, stops, servos, peakSpeed: peakSpeed(src.t, goal), sourcePeakSpeed: peakSpeed(src.t, src.goal) };
}

/** Throws with an operator-readable message. Missing keys take the default; `fallback` decides what "missing" means. */
export function validateSmoothOptions(raw: unknown, fallback: SmoothOptions = DEFAULT_SMOOTH_OPTIONS): SmoothOptions {
	const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const bool = (v: unknown, d: boolean) => (v === undefined ? d : v === true || v === 'true' || v === 'on');
	const enabled = bool(o.enabled, fallback.enabled);
	const source = o.source === undefined ? fallback.source : o.source;
	if (!isSmoothSource(source)) throw new Error('Smoothing source must be "recording" or "steps".');
	const windowS = o.windowS === undefined ? fallback.windowS : Number(o.windowS);
	if (!Number.isFinite(windowS) || windowS < 0 || windowS > MAX_SMOOTH_WINDOW_S) {
		throw new Error(`Smoothing window must be 0–${MAX_SMOOTH_WINDOW_S} s.`);
	}
	const strength = o.strength === undefined ? fallback.strength : Number(o.strength);
	if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw new Error('Smoothing strength must be 0–100%.');
	const keepStops = bool(o.keepStops, fallback.keepStops);
	let servos: number[];
	if (o.servos === undefined) servos = [...fallback.servos];
	else {
		if (!Array.isArray(o.servos)) throw new Error('Smoothing servos must be a list.');
		servos = [...new Set(o.servos.map(Number))].sort((a, b) => a - b);
		if (servos.some((s) => !Number.isInteger(s) || s < 1 || s > SERVO_COUNT)) throw new Error('Smoothing servos must be 1–6.');
	}
	if (enabled && !servos.length) throw new Error('Pick at least one servo to smooth, or turn smoothing off.');
	return { enabled, source, windowS: Math.round(windowS * 10) / 10, strength: Math.round(strength * 100) / 100, keepStops, servos };
}

export interface ComposeSmoothedOptions {
	header: Record<string, unknown> | null;
	sourceName: string;
	options: SmoothOptions;
	jointNames: string[];
	rateHz: number;
	cleanupId: string;
	now?: Date;
}

/** The smoothed frames as a recording the Pi replays: source header + provenance, frames re-based to t = 0, footer. */
export function composeSmoothedRecording(
	t: number[],
	goal: number[][],
	o: ComposeSmoothedOptions
): { jsonl: string; frames: number; durationS: number } {
	if (!goal.length || t.length !== goal.length) throw new Error('nothing to write');
	const header = o.header ?? {};
	const arr = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === 'number') ? (v as number[]) : null);
	const min = arr(header.follower_min);
	const max = arr(header.follower_max);
	const rows = goal.map((r) => r.map((v, i) => Math.max(min?.[i] ?? 0, Math.min(max?.[i] ?? ENCODER_MAX, Math.round(v)))));
	const t0 = t[0];
	const r4 = (x: number) => Math.round(x * 10000) / 10000;
	const lines = [
		JSON.stringify({
			...header,
			event: 'header',
			version: typeof header.version === 'string' ? header.version : '1',
			timestamp: (o.now ?? new Date()).toISOString(),
			rate_hz: o.rateHz,
			joint_names: o.jointNames,
			follower_neutral: rows[0],
			cleaned_from: o.sourceName,
			cleanup_id: o.cleanupId,
			smoothed: {
				source: o.options.source,
				window_s: o.options.windowS,
				strength: o.options.strength,
				keep_stops: o.options.keepStops,
				servos: o.options.servos
			}
		})
	];
	for (let i = 0; i < rows.length; i++) lines.push(JSON.stringify({ event: 'frame', t: r4(t[i] - t0), goal: rows[i] }));
	const durationS = r4(t[t.length - 1] - t0);
	lines.push(JSON.stringify({ event: 'footer', duration_s: durationS, frames: rows.length }));
	return { jsonl: lines.join('\n') + '\n', frames: rows.length, durationS };
}
