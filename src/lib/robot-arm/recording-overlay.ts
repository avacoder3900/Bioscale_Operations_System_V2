/**
 * Overlay: a pilot's teleop recording laid over an animated one.
 *
 * Why: a move set played from the Animate tab is smooth and fast, but its
 * poses were read off the follower, so goal = pose and the loaded joints
 * settle short of it under gravity — the claw lands low. A pilot driving the
 * leader arm never has that problem: they watch the follower and push the
 * leader until the claw is where they want it, so the teleop recording's
 * goals already carry the right amount of "extra" for every joint. What the
 * pilot cannot give is a clean path: hand tremor, uneven speed, pauses in
 * odd places.
 *
 * The overlay keeps the animated recording's time axis and curves, and takes
 * from the pilot's recording only how far their command was from the
 * animation's at each point of the motion:
 *
 *   1. Line the two up in time (`alignWith`), one of two ways:
 *      - stretch (`stretchRecordings`, the default): the same motion at a
 *        different overall speed. The animation's moving part is stretched
 *        or shrunk uniformly onto the pilot's moving part (still time at the
 *        start and end of each can be ignored), so the whole pilot path is
 *        used, start to end.
 *      - follow (`alignRecordings`): subsequence dynamic time warping on all
 *        six joints, the animated recording as the query, for a pilot who
 *        paused or sped up in places, or recorded extra motion around it.
 *        It can squeeze the animation onto a short stretch of the pilot's
 *        recording when the two paths differ a lot.
 *   2. For every animated frame, offset = pilot's goal (at the matched
 *      moment) − animated goal.
 *   3. Smooth that offset over a time window, cap it, scale it by a strength,
 *      and add it to the animated frames (`applyOverlay`). The result is the
 *      animated recording with the pilot's positions.
 *
 * Nothing here touches I/O; the server (robot-arm-overlay.ts) reads the two
 * recordings from the Pi and writes the result back as a new one.
 * Positions are encoder steps, servo ids 1..6 at array index 0..5.
 */
import { ENCODER_MAX, SERVO_COUNT } from './animation';
import type { RecordingFrame } from './recording-steps';

export interface Series {
	/** Frame times, seconds, increasing. */
	t: number[];
	/** One row per frame, six encoder positions (servo id i + 1 at index i). */
	goal: number[][];
}

export type AlignMode = 'stretch' | 'follow';

export const ALIGN_MODES: { id: AlignMode; label: string; hint: string }[] = [
	{
		id: 'stretch',
		label: 'Stretch to fit',
		hint: 'Same moves at a different overall speed: the shorter recording is stretched evenly to the length of the longer one'
	},
	{
		id: 'follow',
		label: 'Follow the motion',
		hint: 'The pilot paused or sped up in places: each moment of the animation is matched to the most similar moment of the pilot'
	}
];

export function isAlignMode(v: unknown): v is AlignMode {
	return v === 'stretch' || v === 'follow';
}

export interface OverlayOptions {
	/** How the two recordings are lined up in time. */
	align: AlignMode;
	/** Stretch only: line up the moving parts, ignoring still time at the start and end of each recording. */
	trimIdle: boolean;
	/** How much of the pilot's offset to apply, 0..1. */
	strength: number;
	/** Seconds the offset is averaged over (centred). 0 = none. */
	windowS: number;
	/** Servo ids (1..6) that take the pilot's offset; the others keep the animation's goal. */
	servos: number[];
	/** Largest offset applied to one servo, in steps; a bigger one is capped and counted. */
	maxOffset: number;
}

export const DEFAULT_OVERLAY_OPTIONS: OverlayOptions = {
	align: 'stretch',
	trimIdle: true,
	strength: 1,
	windowS: 1,
	servos: [1, 2, 3, 4, 5, 6],
	maxOffset: 150
};
export const MAX_WINDOW_S = 5;
export const MAX_MAX_OFFSET = 1000;
/** The alignment works on at most this many samples per recording (longer ones are thinned for it). */
export const MAX_ALIGN_SAMPLES = 1200;
/** Mean joint distance after alignment above which the two recordings probably are not the same motion. */
export const POOR_FIT_STEPS = 150;
/** Still time: a frame within this many steps (every joint) of the first / last frame is not yet / no longer moving. */
export const IDLE_STEPS = 10;

export interface Alignment {
	mode: AlignMode;
	/** Stretch only: pilot active duration ÷ animation active duration (>1 = the pilot was slower). */
	stretch: number | null;
	/** Animated frames whose motion was lined up (the rest map to the pilot's first / last moving frame). */
	smoothSpan: { from: number; to: number };
	/** Thinning factor the warping was computed at (1 = every frame). */
	every: number;
	/** For every animated frame, the pilot frame it lines up with (fractional, non-decreasing). */
	match: number[];
	/** The pilot's goal at match[i], interpolated. */
	aligned: number[][];
	/** aligned − animated, per frame and servo. */
	offset: number[][];
	/** Mean joint-space distance (steps) between the animated frames and their aligned pilot frames. */
	fit: number;
	/** Pilot frames the animation lined up with. */
	span: { from: number; to: number };
}

/**
 * Six positions per frame from parsed frames, carrying the last known value
 * over a servo missing from a frame; a frame with a servo never seen is
 * dropped.
 */
export function seriesFromFrames(frames: RecordingFrame[]): Series {
	const t: number[] = [];
	const goal: number[][] = [];
	let last: number[] | null = null;
	for (const f of frames) {
		const row: number[] = [];
		for (let j = 0; j < SERVO_COUNT; j++) {
			const v = f.positions[String(j + 1)];
			row.push(typeof v === 'number' ? v : (last?.[j] ?? NaN));
		}
		if (row.some((v) => !Number.isFinite(v))) continue;
		t.push(f.t);
		goal.push(row);
		last = row;
	}
	return { t, goal };
}

function dist(a: number[], b: number[]): number {
	let s = 0;
	for (let j = 0; j < SERVO_COUNT; j++) {
		const d = (a[j] ?? 0) - (b[j] ?? 0);
		s += d * d;
	}
	return Math.sqrt(s);
}

function lerpRow(a: number[], b: number[], u: number): number[] {
	const out: number[] = [];
	for (let j = 0; j < SERVO_COUNT; j++) out.push(a[j] + (b[j] - a[j]) * u);
	return out;
}

/** Row `pos` (fractional index) of a series, linearly interpolated and clamped to the ends. */
function rowAt(goal: number[][], pos: number): number[] {
	const n = goal.length;
	if (pos <= 0) return [...goal[0]];
	if (pos >= n - 1) return [...goal[n - 1]];
	const k = Math.floor(pos);
	return lerpRow(goal[k], goal[k + 1], pos - k);
}

/**
 * Subsequence DTW: the animated recording (query) against the pilot's
 * (reference). The query must be matched whole, in order; it may start and
 * end anywhere in the reference. Both are thinned to ≤ MAX_ALIGN_SAMPLES
 * samples for the warping and the result is interpolated back to every
 * animated frame.
 */
export function alignRecordings(smooth: Series, precise: Series): Alignment {
	if (smooth.goal.length < 2) throw new Error('the animated recording has fewer than 2 frames');
	if (precise.goal.length < 2) throw new Error("the pilot's recording has fewer than 2 frames");
	const every = Math.max(1, Math.ceil(Math.max(smooth.goal.length, precise.goal.length) / MAX_ALIGN_SAMPLES));
	const q = thin(smooth.goal, every);
	const r = thin(precise.goal, every);
	const n = q.length;
	const m = r.length;
	const W = m + 1;
	const D = new Float64Array((n + 1) * W);
	// Open beginning: row 0 is free everywhere; nothing may start before the reference does.
	for (let i = 1; i <= n; i++) D[i * W] = Infinity;
	for (let i = 1; i <= n; i++) {
		const qi = q[i - 1];
		for (let j = 1; j <= m; j++) {
			const c = dist(qi, r[j - 1]);
			const up = D[(i - 1) * W + j];
			const left = D[i * W + j - 1];
			const diag = D[(i - 1) * W + j - 1];
			D[i * W + j] = c + Math.min(up, left, diag);
		}
	}
	// Open end: finish wherever the whole query fits best.
	let jEnd = 1;
	for (let j = 2; j <= m; j++) if (D[n * W + j] < D[n * W + jEnd]) jEnd = j;
	// Walk back; collect the reference samples each query sample touched.
	const sum = new Float64Array(n);
	const cnt = new Float64Array(n);
	let i = n;
	let j = jEnd;
	let jStart = jEnd;
	while (i >= 1) {
		sum[i - 1] += j - 1;
		cnt[i - 1] += 1;
		jStart = j;
		if (i === 1) break;
		const up = D[(i - 1) * W + j];
		const left = j > 1 ? D[i * W + j - 1] : Infinity;
		const diag = j > 1 ? D[(i - 1) * W + j - 1] : Infinity;
		if (diag <= up && diag <= left) {
			i -= 1;
			j -= 1;
		} else if (up <= left) {
			i -= 1;
		} else {
			j -= 1;
		}
	}
	const matchThin: number[] = [];
	for (let k = 0; k < n; k++) matchThin.push(cnt[k] ? sum[k] / cnt[k] : (matchThin[k - 1] ?? 0));

	const match: number[] = [];
	for (let f = 0; f < smooth.goal.length; f++) {
		const pos = f / every;
		const k = Math.min(n - 1, Math.floor(pos));
		const next = Math.min(n - 1, k + 1);
		const mt = matchThin[k] + (matchThin[next] - matchThin[k]) * (pos - k);
		match.push(Math.min(precise.goal.length - 1, Math.max(0, mt * every)));
	}
	return finish('follow', smooth, precise, match, {
		every,
		stretch: null,
		smoothSpan: { from: 0, to: smooth.goal.length - 1 },
		span: {
			from: Math.round((jStart - 1) * every),
			to: Math.min(precise.goal.length - 1, Math.round((jEnd - 1) * every))
		}
	});
}

/** The pilot's rows at the matched frames, the offsets and the fit. */
function finish(
	mode: AlignMode,
	smooth: Series,
	precise: Series,
	match: number[],
	rest: { every: number; stretch: number | null; smoothSpan: { from: number; to: number }; span: { from: number; to: number } }
): Alignment {
	const aligned: number[][] = [];
	const offset: number[][] = [];
	let fitSum = 0;
	for (let f = 0; f < smooth.goal.length; f++) {
		const row = rowAt(precise.goal, match[f]);
		aligned.push(row);
		offset.push(row.map((v, s) => v - smooth.goal[f][s]));
		fitSum += dist(row, smooth.goal[f]);
	}
	return { mode, ...rest, match, aligned, offset, fit: fitSum / smooth.goal.length };
}

/**
 * The frames where a recording is moving: from the first frame that has
 * left the first frame's pose by more than `idleSteps` on some joint, to
 * the last frame not yet within `idleSteps` of the last frame's pose (each
 * widened by one frame, so the move's first and last frames are included).
 * A recording that never moves gives its whole length.
 */
export function activeSpan(s: Series, idleSteps = IDLE_STEPS): { from: number; to: number } {
	const n = s.goal.length;
	const first = s.goal[0];
	const last = s.goal[n - 1];
	const far = (a: number[], b: number[]) => {
		for (let j = 0; j < SERVO_COUNT; j++) if (Math.abs(a[j] - b[j]) > idleSteps) return true;
		return false;
	};
	let from = 0;
	while (from < n - 1 && !far(s.goal[from], first)) from++;
	let to = n - 1;
	while (to > 0 && !far(s.goal[to], last)) to--;
	if (from >= n - 1 || to <= 0 || to < from) return { from: 0, to: n - 1 };
	return { from: Math.max(0, from - 1), to: Math.min(n - 1, to + 1) };
}

/**
 * Stretch alignment: the animation's moving part laid evenly over the
 * pilot's moving part, by time. Animated time u ∈ [0, 1] across its span
 * maps to the pilot time at the same fraction of the pilot's span; still
 * frames before / after the animation's span map to the pilot's first /
 * last moving frame. With `trimIdle` off, both whole recordings are the
 * spans. Every pilot frame in the span is used, in order, at a constant
 * rate — the shorter recording is stretched, the longer one shrunk.
 */
export function stretchRecordings(smooth: Series, precise: Series, o: { trimIdle?: boolean } = {}): Alignment {
	if (smooth.goal.length < 2) throw new Error('the animated recording has fewer than 2 frames');
	if (precise.goal.length < 2) throw new Error("the pilot's recording has fewer than 2 frames");
	const trim = o.trimIdle ?? true;
	const sSpan = trim ? activeSpan(smooth) : { from: 0, to: smooth.goal.length - 1 };
	const pSpan = trim ? activeSpan(precise) : { from: 0, to: precise.goal.length - 1 };
	const sT0 = smooth.t[sSpan.from];
	const sT1 = smooth.t[sSpan.to];
	const pT0 = precise.t[pSpan.from];
	const pT1 = precise.t[pSpan.to];
	const sDur = sT1 - sT0;
	const pDur = pT1 - pT0;
	// Pilot frame index at a pilot time, fractional (times are increasing).
	let k = pSpan.from;
	const frameAt = (tp: number) => {
		while (k < pSpan.to && precise.t[k + 1] <= tp) k++;
		while (k > pSpan.from && precise.t[k] > tp) k--;
		const a = precise.t[k];
		const b = precise.t[Math.min(k + 1, precise.t.length - 1)];
		return b > a ? k + Math.max(0, Math.min(1, (tp - a) / (b - a))) : k;
	};
	const match: number[] = [];
	for (let f = 0; f < smooth.goal.length; f++) {
		const u = sDur > 0 ? Math.max(0, Math.min(1, (smooth.t[f] - sT0) / sDur)) : 0;
		match.push(Math.min(pSpan.to, frameAt(pT0 + u * pDur)));
	}
	return finish('stretch', smooth, precise, match, {
		every: 1,
		stretch: sDur > 0 ? pDur / sDur : null,
		smoothSpan: sSpan,
		span: pSpan
	});
}

/** Line the two recordings up the way the options say. */
export function alignWith(smooth: Series, precise: Series, o: Pick<OverlayOptions, 'align' | 'trimIdle'>): Alignment {
	return o.align === 'follow' ? alignRecordings(smooth, precise) : stretchRecordings(smooth, precise, { trimIdle: o.trimIdle });
}

function thin(goal: number[][], every: number): number[][] {
	if (every === 1) return goal;
	const out: number[][] = [];
	for (let i = 0; i < goal.length; i += every) out.push(goal[i]);
	return out;
}

export interface ServoSummary {
	servoId: number;
	corrected: boolean;
	/** The pilot's offset before smoothing: median and range over the recording. */
	median: number;
	min: number;
	max: number;
	/** What was added to the animation after smoothing, capping and strength. */
	appliedMean: number;
	appliedMin: number;
	appliedMax: number;
	/** Frames whose smoothed offset was bigger than maxOffset. */
	capped: number;
}

export interface OverlayResult {
	/** The animated recording with the pilot's positions, one row per animated frame. */
	goal: number[][];
	/** Steps added per frame and servo. */
	applied: number[][];
	servos: ServoSummary[];
}

/** Frame rate implied by a series' times. */
export function seriesRateHz(s: Series): number {
	const n = s.t.length;
	if (n < 2) return 30;
	const span = s.t[n - 1] - s.t[0];
	return span > 0 ? (n - 1) / span : 30;
}

/** Centred moving average over `w` frames, edges truncated. */
export function movingAverage(v: number[], w: number): number[] {
	const n = v.length;
	if (w <= 1 || n === 0) return [...v];
	const half = Math.floor(w / 2);
	const prefix = new Float64Array(n + 1);
	for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + v[i];
	const out: number[] = [];
	for (let i = 0; i < n; i++) {
		const a = Math.max(0, i - half);
		const b = Math.min(n, i + half + 1);
		out.push((prefix[b] - prefix[a]) / (b - a));
	}
	return out;
}

function median(v: number[]): number {
	if (!v.length) return 0;
	const s = [...v].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * The animated recording with the pilot's offset added: per corrected servo,
 * the raw offset averaged over `windowS`, capped at ±maxOffset, scaled by
 * `strength`, rounded, and the goal clamped to the encoder range.
 */
export function applyOverlay(smooth: Series, align: Pick<Alignment, 'offset'>, opts: OverlayOptions): OverlayResult {
	const n = smooth.goal.length;
	if (align.offset.length !== n) throw new Error('alignment does not match the animated recording');
	const w = Math.max(1, Math.round(opts.windowS * seriesRateHz(smooth)));
	const applied: number[][] = Array.from({ length: n }, () => Array(SERVO_COUNT).fill(0));
	const goal: number[][] = smooth.goal.map((row) => [...row]);
	const servos: ServoSummary[] = [];
	for (let j = 0; j < SERVO_COUNT; j++) {
		const raw = align.offset.map((row) => row[j]);
		const corrected = opts.servos.includes(j + 1);
		let lo = Infinity;
		let hi = -Infinity;
		for (const v of raw) {
			lo = Math.min(lo, v);
			hi = Math.max(hi, v);
		}
		const summary: ServoSummary = {
			servoId: j + 1,
			corrected,
			median: Math.round(median(raw)),
			min: n ? Math.round(lo) : 0,
			max: n ? Math.round(hi) : 0,
			appliedMean: 0,
			appliedMin: 0,
			appliedMax: 0,
			capped: 0
		};
		if (corrected && n) {
			const sm = movingAverage(raw, w);
			let sum = 0;
			let aLo = Infinity;
			let aHi = -Infinity;
			for (let i = 0; i < n; i++) {
				let o = sm[i];
				if (Math.abs(o) > opts.maxOffset) {
					summary.capped += 1;
					o = Math.sign(o) * opts.maxOffset;
				}
				const a = Math.round(o * opts.strength);
				applied[i][j] = a;
				goal[i][j] = Math.max(0, Math.min(ENCODER_MAX, Math.round(smooth.goal[i][j] + a)));
				sum += a;
				aLo = Math.min(aLo, a);
				aHi = Math.max(aHi, a);
			}
			summary.appliedMean = Math.round(sum / n);
			summary.appliedMin = aLo;
			summary.appliedMax = aHi;
		}
		servos.push(summary);
	}
	return { goal, applied, servos };
}

/** Throws with an operator-readable message. Unknown keys are ignored; missing ones take the default. */
export function validateOverlayOptions(raw: unknown): OverlayOptions {
	const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const strength = o.strength === undefined ? DEFAULT_OVERLAY_OPTIONS.strength : Number(o.strength);
	if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw new Error('Strength must be 0–100%.');
	const windowS = o.windowS === undefined ? DEFAULT_OVERLAY_OPTIONS.windowS : Number(o.windowS);
	if (!Number.isFinite(windowS) || windowS < 0 || windowS > MAX_WINDOW_S) {
		throw new Error(`Smoothing window must be 0–${MAX_WINDOW_S} s.`);
	}
	const maxOffset = o.maxOffset === undefined ? DEFAULT_OVERLAY_OPTIONS.maxOffset : Number(o.maxOffset);
	if (!Number.isInteger(maxOffset) || maxOffset < 1 || maxOffset > MAX_MAX_OFFSET) {
		throw new Error(`Largest offset must be 1–${MAX_MAX_OFFSET} steps.`);
	}
	let servos: number[];
	if (o.servos === undefined) servos = [...DEFAULT_OVERLAY_OPTIONS.servos];
	else {
		if (!Array.isArray(o.servos)) throw new Error('Servos must be a list.');
		servos = [...new Set(o.servos.map(Number))].sort((a, b) => a - b);
		if (servos.some((s) => !Number.isInteger(s) || s < 1 || s > SERVO_COUNT)) throw new Error('Servos must be 1–6.');
		if (!servos.length) throw new Error('Pick at least one servo to correct.');
	}
	const align = o.align === undefined ? DEFAULT_OVERLAY_OPTIONS.align : o.align;
	if (!isAlignMode(align)) throw new Error('Line up by must be "stretch" or "follow".');
	const trimIdle = o.trimIdle === undefined ? DEFAULT_OVERLAY_OPTIONS.trimIdle : o.trimIdle === true || o.trimIdle === 'true';
	return { align, trimIdle, strength: Math.round(strength * 100) / 100, windowS: Math.round(windowS * 10) / 10, servos, maxOffset };
}

export interface ComposeOverlayOptions {
	/** The animated recording's header line (copied; its limits clamp the result). */
	smoothHeader: Record<string, unknown> | null;
	smoothName: string;
	preciseName: string;
	options: OverlayOptions;
	jointNames: string[];
	rateHz: number;
	now?: Date;
}

/**
 * The overlaid frames as a recording the Pi replays: the animated recording's
 * header with the overlay's provenance, one frame per animated frame at its
 * own time (re-based to 0), footer. Goals are clamped to the header's
 * follower limits.
 */
export function composeOverlayRecording(
	t: number[],
	goal: number[][],
	o: ComposeOverlayOptions
): { jsonl: string; frames: number; durationS: number } {
	if (!goal.length || t.length !== goal.length) throw new Error('nothing to write');
	const header = o.smoothHeader ?? {};
	const min = numArray(header.follower_min);
	const max = numArray(header.follower_max);
	const clamp = (i: number, v: number) => Math.max(min?.[i] ?? 0, Math.min(max?.[i] ?? ENCODER_MAX, Math.round(v)));
	const rows = goal.map((row) => row.map((v, i) => clamp(i, v)));
	const t0 = t[0];
	const lines: string[] = [];
	lines.push(
		JSON.stringify({
			...header,
			event: 'header',
			version: typeof header.version === 'string' ? header.version : '1',
			timestamp: (o.now ?? new Date()).toISOString(),
			rate_hz: o.rateHz,
			joint_names: o.jointNames,
			follower_neutral: rows[0],
			overlay: {
				animated: o.smoothName,
				pilot: o.preciseName,
				align: o.options.align,
				trim_idle: o.options.trimIdle,
				strength: o.options.strength,
				window_s: o.options.windowS,
				servos: o.options.servos,
				max_offset: o.options.maxOffset
			}
		})
	);
	for (let i = 0; i < rows.length; i++) {
		lines.push(JSON.stringify({ event: 'frame', t: round4(t[i] - t0), goal: rows[i] }));
	}
	const durationS = round4(t[t.length - 1] - t0);
	lines.push(JSON.stringify({ event: 'footer', duration_s: durationS, frames: rows.length }));
	return { jsonl: lines.join('\n') + '\n', frames: rows.length, durationS };
}

function numArray(v: unknown): number[] | null {
	return Array.isArray(v) && v.every((x) => typeof x === 'number') ? (v as number[]) : null;
}

function round4(n: number): number {
	return Math.round(n * 10000) / 10000;
}
