/**
 * Robot arm — pose animation (pure logic, no I/O). ARM-06.
 *
 * The operator poses the arm by hand and saves poses; a MOVE SET is an
 * ordered list of those poses, each with how long to hold it and how to
 * arrive at it (duration + easing, as After Effects keyframes). This module
 * turns a move set into a dense path — one joint goal per servo per frame at
 * the Pi's replay rate — which the Pi plays back as an ordinary recording
 * (services/robot-arm: `{"event":"frame","t":…,"goal":[6]}` lines).
 *
 * Smoothness lives here, not on the Pi: replay writes each frame's goal at its
 * time and nothing else, so a path that is smooth in these numbers is smooth
 * on the arm.
 *
 * Easings (per keyframe, describing the arrival at that pose):
 *   ease   — minimum-jerk (quintic): zero velocity AND acceleration at both
 *            poses; the arm settles into each pose. The default.
 *   in/out — cubic ease-in (slow start) / ease-out (slow finish).
 *   linear — constant speed; stops dead at each pose.
 *   flow   — do not stop at this pose: a cubic Hermite spline with
 *            Catmull-Rom tangents carries velocity through it. Only takes
 *            effect when the pose is not held and the next segment also
 *            flows; otherwise the pose is a stop.
 *
 * Positions are encoder steps, servo ids 1..6 at array index 0..5.
 */

export const SERVO_COUNT = 6;
export const ENCODER_MAX = 4095;
export const DEFAULT_RATE_HZ = 30;

export type Easing = 'ease' | 'linear' | 'in' | 'out' | 'flow';

export const EASINGS: { id: Easing; label: string; hint: string }[] = [
	{ id: 'ease', label: 'Easy ease', hint: 'Settles into the pose (minimum jerk)' },
	{ id: 'in', label: 'Ease in', hint: 'Starts slowly, arrives at speed' },
	{ id: 'out', label: 'Ease out', hint: 'Leaves at speed, arrives slowly' },
	{ id: 'linear', label: 'Linear', hint: 'Constant speed, stops dead' },
	{ id: 'flow', label: 'Flow through', hint: 'Does not stop at this pose' }
];

/**
 * A transition is refused when any servo would have to exceed this at any
 * frame (pathStats). STS3215 no-load is ~4000. minDurationS turns it into a
 * duration via the easing's peak-speed factor, so the two checks agree.
 */
export const MAX_STEPS_PER_S = 2000;
/** Speed used when BIMS picks a duration itself (lead-in, joins between move sets). */
export const AUTO_STEPS_PER_S = 600;
export const MIN_TRANSITION_S = 0.2;
export const MAX_TRANSITION_S = 60;
export const MAX_HOLD_S = 120;
export const MAX_KEYFRAMES = 200;
/** One rendered path (a sequence) may not be longer than this. */
export const MAX_PATH_S = 600;

/** A timeline edit may move one joint at most this far from its pose. */
export const MAX_OFFSET_STEPS = 1000;
/**
 * Droop trim (pose.trim) is capped here. Under gravity an STS3215 settles a
 * few to a few tens of steps short of its goal; much more than this is not
 * droop but a stalled or blocked joint, and a large trim would also push the
 * first frame of a saved recording past Control's ±50-step replay preflight.
 */
export const MAX_TRIM_STEPS = 50;

// ── jog ──────────────────────────────────────────────────────────────────

/** The Pi takes one jog of at most this many steps; longer moves are chunked. */
export const JOG_CHUNK_STEPS = 300;
/** One jog request (one button press or typed value) moves one servo at most this far. */
export const MAX_JOG_STEPS = 1000;

/**
 * Split a jog into the ≤`chunk`-step pieces the Pi accepts, same sign, in
 * order; the last piece carries the remainder. Zero → no pieces.
 */
export function jogChunks(delta: number, chunk = JOG_CHUNK_STEPS): number[] {
	const d = Math.trunc(delta);
	if (!Number.isFinite(d) || d === 0) return [];
	const out: number[] = [];
	let remaining = d;
	while (remaining !== 0) {
		const piece = Math.max(-chunk, Math.min(chunk, remaining));
		out.push(piece);
		remaining -= piece;
	}
	return out;
}

export interface Keyframe {
	poseId: string;
	/** Seconds to stay at the pose once reached. */
	holdS: number;
	/** Seconds the move INTO this pose takes (ignored for the first keyframe). */
	durationS: number;
	easing: Easing;
	/**
	 * Per-servo steps added to the pose for this keyframe only — what dragging
	 * a joint on the timeline edits. Absent when every joint is at its pose.
	 */
	offsets?: number[];
}

export interface ResolvedKeyframe extends Keyframe {
	name: string;
	positions: number[];
	/**
	 * Where the arm should END UP at this keyframe (pose + offsets) when
	 * `positions` also carries a droop trim; absent when they are the same.
	 */
	target?: number[];
}

export type MarkerKind = 'pose' | 'lead-in' | 'join';

export interface PathMarker {
	/** When the arm arrives at this pose. */
	t: number;
	label: string;
	kind: MarkerKind;
	/** Index in the keyframe list the path was built from (−1 for the lead-in origin). */
	index: number;
	holdS: number;
	/** Where every servo is at this marker (what the timeline's joint dots show). */
	positions: number[];
	/** The pose this marker arrives at (none for the lead-in origin). */
	poseId?: string;
	/** Where the arm should end up here without any droop trim (pose + offsets); see ResolvedKeyframe.target. */
	target?: number[];
}

export interface RenderedPath {
	rateHz: number;
	t: number[];
	goal: number[][];
	markers: PathMarker[];
	durationS: number;
}

// ── easing ───────────────────────────────────────────────────────────────

export function ease(kind: Easing, u: number): number {
	const x = Math.max(0, Math.min(1, u));
	switch (kind) {
		case 'linear':
			return x;
		case 'in':
			return x * x * x;
		case 'out':
			return 1 - (1 - x) ** 3;
		case 'ease':
		case 'flow':
		default:
			// Minimum-jerk: 10u³ − 15u⁴ + 6u⁵.
			return x * x * x * (10 + x * (-15 + 6 * x));
	}
}

// ── durations ────────────────────────────────────────────────────────────

export function maxDelta(a: number[], b: number[]): number {
	let d = 0;
	for (let i = 0; i < Math.min(a.length, b.length); i++) d = Math.max(d, Math.abs(b[i] - a[i]));
	return d;
}

export const roundTenth = (s: number) => Math.round(s * 10) / 10;
const ceilTenth = (s: number) => Math.ceil(s * 10 - 1e-9) / 10;

/**
 * How much faster than its average speed an easing goes at its steepest
 * (max of d/du of ease()): the arm's peak speed over a move is the average
 * times this. Minimum jerk peaks at 1.875× mid-move; a cubic ease-in/out
 * peaks at 3× at the fast end; linear never exceeds its average. Flow-through
 * segments depend on their neighbours' tangents; the min-jerk figure is used.
 */
export function peakSpeedFactor(kind: Easing): number {
	switch (kind) {
		case 'linear':
			return 1;
		case 'in':
		case 'out':
			return 3;
		default:
			return 1.875;
	}
}

/**
 * Shortest transition the arm can physically make between two poses with the
 * given arrival easing (0 when they are the same): the duration at which the
 * easing's PEAK speed on the fastest servo is exactly `stepsPerS`, so a path
 * rendered at this duration passes pathStats' per-frame check.
 */
export function minDurationS(a: number[], b: number[], stepsPerS = MAX_STEPS_PER_S, easing: Easing = 'ease'): number {
	const d = maxDelta(a, b);
	return d ? Math.max(MIN_TRANSITION_S, ceilTenth((d * peakSpeedFactor(easing)) / stepsPerS)) : 0;
}

/** A comfortable duration BIMS picks when the operator has not: lead-ins and joins. */
export function autoDurationS(a: number[], b: number[]): number {
	const d = maxDelta(a, b);
	return d ? Math.max(MIN_TRANSITION_S, ceilTenth(d / AUTO_STEPS_PER_S)) : 0;
}

// ── validation ───────────────────────────────────────────────────────────

export function cleanPositions(input: unknown): number[] {
	if (!Array.isArray(input) || input.length !== SERVO_COUNT) throw new Error(`a pose needs ${SERVO_COUNT} servo positions`);
	return input.map((v, i) => {
		const n = Number(v);
		if (!Number.isFinite(n)) throw new Error(`servo ${i + 1}: position is not a number`);
		return Math.max(0, Math.min(ENCODER_MAX, Math.round(n)));
	});
}

export function isEasing(v: unknown): v is Easing {
	return typeof v === 'string' && EASINGS.some((e) => e.id === v);
}

/** Normalise a keyframe list from a form or the DB; throws on anything unusable. */
export function cleanKeyframes(input: unknown): Keyframe[] {
	if (!Array.isArray(input)) throw new Error('keyframes must be a list');
	if (input.length > MAX_KEYFRAMES) throw new Error(`at most ${MAX_KEYFRAMES} keyframes`);
	return input.map((k: any, i) => {
		const poseId = String(k?.poseId ?? '').trim();
		if (!poseId) throw new Error(`keyframe ${i + 1}: no pose`);
		const holdS = Number(k?.holdS ?? 0);
		const durationS = Number(k?.durationS ?? 1);
		if (!Number.isFinite(holdS) || holdS < 0 || holdS > MAX_HOLD_S) throw new Error(`keyframe ${i + 1}: hold must be 0–${MAX_HOLD_S} s`);
		if (!Number.isFinite(durationS) || durationS < MIN_TRANSITION_S || durationS > MAX_TRANSITION_S)
			throw new Error(`keyframe ${i + 1}: duration must be ${MIN_TRANSITION_S}–${MAX_TRANSITION_S} s`);
		const easing = isEasing(k?.easing) ? k.easing : 'ease';
		const out: Keyframe = { poseId, holdS: roundTenth(holdS), durationS: roundTenth(durationS), easing };
		const offsets = cleanOffsets(k?.offsets, MAX_OFFSET_STEPS);
		if (offsets) out.offsets = offsets;
		return out;
	});
}

/**
 * Six whole-step offsets each within ±limit, or null when there are none
 * (missing, not a list, or all zero) — so an untouched keyframe stores nothing.
 */
export function cleanOffsets(input: unknown, limit: number): number[] | null {
	if (!Array.isArray(input) || input.length !== SERVO_COUNT) return null;
	const out = input.map((v) => {
		const n = Math.round(Number(v));
		return Number.isFinite(n) ? Math.max(-limit, Math.min(limit, n)) : 0;
	});
	return out.some((v) => v !== 0) ? out : null;
}

/**
 * Where a keyframe sends the arm: the pose, plus the keyframe's timeline
 * offsets, plus (for what is written to the Pi) the pose's droop trim.
 * Clamped to the encoder range.
 */
export function keyframePositions(pose: number[], offsets?: number[] | null, trim?: number[] | null): number[] {
	return pose.map((p, s) => clampStep(p + (offsets?.[s] ?? 0) + (trim?.[s] ?? 0)));
}

// ── droop ────────────────────────────────────────────────────────────────

/**
 * Servos whose droop is measured and trimmed: base, shoulder, elbow, wrist
 * flex, wrist roll. Not the gripper — its "shortfall" when closed on a part is
 * the grip itself, and trimming it would only squeeze harder.
 */
export const TRIM_SERVOS = [1, 2, 3, 4, 5];
/** A measurement is done when every trimmed servo settles this close to the pose. */
export const TRIM_DONE_STEPS = 2;

/**
 * One step of the droop measurement. The arm was commanded to `pose + trim`
 * and settled at `present`; whatever it is still short of the pose is added
 * to the trim, so next time the goal leads the pose by what gravity takes
 * off it. Returns the new trim and the residual (pose − present) it used.
 */
export function nextTrim(pose: number[], present: number[], trim: number[]): { trim: number[]; residual: number[]; done: boolean } {
	const residual = pose.map((p, s) => (TRIM_SERVOS.includes(s + 1) ? p - present[s] : 0));
	const done = residual.every((r) => Math.abs(r) <= TRIM_DONE_STEPS);
	const next = trim.map((t, s) => {
		if (!TRIM_SERVOS.includes(s + 1)) return 0;
		return done ? t : Math.max(-MAX_TRIM_STEPS, Math.min(MAX_TRIM_STEPS, t + residual[s]));
	});
	return { trim: next, residual, done };
}

/** A pose measured on the arm: its positions and the trim that made it land. */
export interface TrimSample {
	positions: number[];
	trim: number[];
}

/**
 * Servos whose angle decides how much gravity pulls on the arm: shoulder lift,
 * elbow, wrist flex (ids 2–4). Base yaw and wrist roll turn the arm about a
 * vertical / its own axis and barely change the load, so poses are compared
 * on these three only.
 */
const GRAVITY_SERVOS = [2, 3, 4];
/** A measured pose further than this (steps, on the gravity servos) says nothing about another. */
export const TRIM_ESTIMATE_RADIUS = 400;

/**
 * Droop trim for a pose that has not been measured, from the poses that have.
 * Droop is a smooth function of the arm's shape (how far each link sticks
 * out), so nearby measured poses predict it: inverse-distance weighting over
 * every sample within TRIM_ESTIMATE_RADIUS on the gravity servos. A sample at
 * the same shape returns its own trim. Null when nothing is close enough —
 * then the pose plays untrimmed until it is visited.
 */
export function estimateTrim(positions: number[], samples: TrimSample[]): number[] | null {
	let wSum = 0;
	const acc = new Array(SERVO_COUNT).fill(0);
	for (const s of samples) {
		if (s.trim.length !== SERVO_COUNT || s.positions.length !== SERVO_COUNT) continue;
		let d2 = 0;
		for (const sid of GRAVITY_SERVOS) d2 += (positions[sid - 1] - s.positions[sid - 1]) ** 2;
		const d = Math.sqrt(d2);
		if (d > TRIM_ESTIMATE_RADIUS) continue;
		if (d < 1) return s.trim.map((t, i) => (TRIM_SERVOS.includes(i + 1) ? t : 0));
		// Falls to zero at the radius, so a sample does not switch on and off abruptly.
		const w = (1 / d ** 2) * (1 - d / TRIM_ESTIMATE_RADIUS);
		wSum += w;
		for (let i = 0; i < SERVO_COUNT; i++) acc[i] += w * s.trim[i];
	}
	if (!wSum) return null;
	const out = acc.map((v, i) => (TRIM_SERVOS.includes(i + 1) ? Math.max(-MAX_TRIM_STEPS, Math.min(MAX_TRIM_STEPS, Math.round(v / wSum))) : 0));
	return out.some((v) => v !== 0) ? out : null;
}

export interface KeyframeProblem {
	index: number;
	message: string;
}

/** Transitions that are faster than the arm can go. */
export function tooFast(kfs: ResolvedKeyframe[]): KeyframeProblem[] {
	const out: KeyframeProblem[] = [];
	for (let i = 1; i < kfs.length; i++) {
		const min = minDurationS(kfs[i - 1].positions, kfs[i].positions, MAX_STEPS_PER_S, kfs[i].easing);
		if (kfs[i].durationS < min) out.push({ index: i, message: `${kfs[i].name}: ${kfs[i].durationS} s is too fast for this move — at least ${min} s.` });
	}
	return out;
}

// ── rendering ────────────────────────────────────────────────────────────

interface Node {
	positions: number[];
	holdS: number;
	/** Seconds from leaving the previous node to arriving here (0 for the first). */
	durationS: number;
	easing: Easing;
	label: string;
	kind: MarkerKind;
	index: number;
	poseId?: string;
	target?: number[];
}

export interface BuildOptions {
	rateHz?: number;
	/** Start the path where the arm IS, and tween to the first keyframe. */
	leadIn?: { from: number[]; durationS?: number | null } | null;
}

/**
 * Build the dense path for a keyframe list. Zero-velocity at every pose that
 * is held, that uses a stopping easing, or that is the first/last; Catmull-Rom
 * tangents (in time) elsewhere, so a run of `flow` poses is one continuous
 * sweep. Frames are at 1/rateHz; the last frame is exactly the last pose.
 */
export function buildPath(kfs: ResolvedKeyframe[], o: BuildOptions = {}): RenderedPath {
	const rate = o.rateHz && o.rateHz > 0 ? o.rateHz : DEFAULT_RATE_HZ;
	if (!kfs.length) throw new Error('a move set needs at least one pose');
	for (const k of kfs) if (k.positions.length !== SERVO_COUNT) throw new Error(`${k.name}: pose has ${k.positions.length} positions, not ${SERVO_COUNT}`);

	const nodes: Node[] = [];
	if (o.leadIn && o.leadIn.from.length === SERVO_COUNT) {
		const from = o.leadIn.from;
		const first = kfs[0];
		const d = maxDelta(from, first.positions) ? (o.leadIn.durationS ?? autoDurationS(from, first.positions)) : 0;
		if (d > 0) {
			nodes.push({ positions: from, holdS: 0, durationS: 0, easing: 'ease', label: 'start (arm now)', kind: 'lead-in', index: -1 });
			nodes.push({ positions: first.positions, holdS: first.holdS, durationS: d, easing: 'ease', label: first.name, kind: 'pose', index: 0, poseId: first.poseId, target: first.target });
		} else {
			nodes.push({ positions: first.positions, holdS: first.holdS, durationS: 0, easing: 'ease', label: first.name, kind: 'pose', index: 0, poseId: first.poseId, target: first.target });
		}
	} else {
		nodes.push({ positions: kfs[0].positions, holdS: kfs[0].holdS, durationS: 0, easing: 'ease', label: kfs[0].name, kind: 'pose', index: 0, poseId: kfs[0].poseId, target: kfs[0].target });
	}
	for (let i = 1; i < kfs.length; i++) {
		const k = kfs[i];
		nodes.push({ positions: k.positions, holdS: k.holdS, durationS: k.durationS, easing: k.easing, label: k.name, kind: (k as any).kind === 'join' ? 'join' : 'pose', index: i, poseId: k.poseId, target: k.target });
	}

	// Timing.
	const arrive: number[] = [];
	const depart: number[] = [];
	let t = 0;
	nodes.forEach((n, i) => {
		if (i > 0) t += n.durationS;
		arrive[i] = t;
		t += n.holdS;
		depart[i] = t;
	});
	const total = depart[nodes.length - 1];
	if (total > MAX_PATH_S) throw new Error(`the path is ${Math.round(total)} s long; the limit is ${MAX_PATH_S} s`);

	// Tangents (steps/s) per node: zero at stops, Catmull-Rom in time at flow-throughs.
	const stops = nodes.map((n, i) => i === 0 || i === nodes.length - 1 || n.holdS > 0 || n.easing !== 'flow' || nodes[i + 1].easing !== 'flow');
	const tangent: number[][] = nodes.map((n, i) => {
		if (stops[i]) return new Array(SERVO_COUNT).fill(0);
		const span = arrive[i + 1] - arrive[i - 1];
		return n.positions.map((_, s) => (span > 0 ? (nodes[i + 1].positions[s] - nodes[i - 1].positions[s]) / span : 0));
	});

	const at = (time: number): number[] => {
		// Which node/segment holds `time`?
		let k = 0;
		while (k < nodes.length - 1 && time >= depart[k] && !(time < arrive[k + 1])) k++;
		if (time <= depart[k] || k === nodes.length - 1) return nodes[k].positions; // holding at node k (or past the end)
		const a = nodes[k];
		const b = nodes[k + 1];
		const dur = b.durationS;
		const u = dur > 0 ? Math.max(0, Math.min(1, (time - depart[k]) / dur)) : 1;
		const flowing = !stops[k] || !stops[k + 1];
		if (!flowing) {
			const e = ease(b.easing, u);
			return a.positions.map((p, s) => p + (b.positions[s] - p) * e);
		}
		// Cubic Hermite with time-scaled tangents.
		const u2 = u * u;
		const u3 = u2 * u;
		const h00 = 2 * u3 - 3 * u2 + 1;
		const h10 = u3 - 2 * u2 + u;
		const h01 = -2 * u3 + 3 * u2;
		const h11 = u3 - u2;
		return a.positions.map((p, s) => h00 * p + h10 * dur * tangent[k][s] + h01 * b.positions[s] + h11 * dur * tangent[k + 1][s]);
	};

	const tOut: number[] = [];
	const goal: number[][] = [];
	const n = Math.floor(total * rate + 1e-9);
	for (let i = 0; i <= n; i++) {
		const time = i / rate;
		tOut.push(round4(time));
		goal.push(at(time).map(clampStep));
	}
	if (tOut[tOut.length - 1] < total - 1e-9) {
		tOut.push(round4(total));
		goal.push(nodes[nodes.length - 1].positions.map(clampStep));
	} else {
		goal[goal.length - 1] = nodes[nodes.length - 1].positions.map(clampStep);
	}

	const markers: PathMarker[] = nodes.map((nd, i) => ({
		t: round4(arrive[i]),
		label: nd.label,
		kind: nd.kind,
		index: nd.index,
		holdS: nd.holdS,
		positions: nd.positions.map(clampStep),
		...(nd.poseId ? { poseId: nd.poseId } : {}),
		...(nd.target ? { target: nd.target.map(clampStep) } : {})
	}));
	return { rateHz: rate, t: tOut, goal, markers, durationS: round4(total) };
}

function clampStep(v: number): number {
	return Math.max(0, Math.min(ENCODER_MAX, Math.round(v)));
}

function round4(n: number): number {
	return Math.round(n * 10000) / 10000;
}

export interface PathStats {
	frames: number;
	durationS: number;
	/** Per servo (index = id − 1), the fastest frame-to-frame rate in steps/s. */
	maxStepsPerS: number[];
	/** Servo ids that exceed MAX_STEPS_PER_S anywhere. */
	tooFast: number[];
}

export function pathStats(p: RenderedPath): PathStats {
	const max = new Array(SERVO_COUNT).fill(0);
	for (let i = 1; i < p.goal.length; i++) {
		const dt = p.t[i] - p.t[i - 1];
		if (dt <= 0) continue;
		for (let s = 0; s < SERVO_COUNT; s++) max[s] = Math.max(max[s], Math.abs(p.goal[i][s] - p.goal[i - 1][s]) / dt);
	}
	const tooFastIds = max.map((v, s) => (v > MAX_STEPS_PER_S ? s + 1 : 0)).filter(Boolean);
	return { frames: p.goal.length, durationS: p.durationS, maxStepsPerS: max.map((v) => Math.round(v)), tooFast: tooFastIds };
}

// ── sequences ────────────────────────────────────────────────────────────

export interface SequenceItem {
	name: string;
	keyframes: ResolvedKeyframe[];
	/** How the arm gets from the previous move set's last pose to this one's first. */
	join: { durationS: number | null; easing: Easing };
}

/**
 * Flatten a sequence of move sets into one keyframe list: each set's first
 * keyframe becomes the arrival from the previous set's last pose (the join),
 * with an automatic duration unless the operator set one.
 */
export function flattenSequence(items: SequenceItem[]): ResolvedKeyframe[] {
	const out: (ResolvedKeyframe & { kind?: MarkerKind })[] = [];
	for (const item of items) {
		if (!item.keyframes.length) continue;
		item.keyframes.forEach((k, i) => {
			const labelled = { ...k, name: `${item.name} · ${k.name}` };
			if (i === 0 && out.length) {
				const prev = out[out.length - 1];
				const d = item.join.durationS ?? autoDurationS(prev.positions, k.positions);
				if (d > 0) out.push({ ...labelled, durationS: d, easing: item.join.easing, kind: 'join' });
				else {
					// Same pose as where the last set ended: just extend the hold.
					prev.holdS = roundTenth(prev.holdS + k.holdS);
				}
			} else {
				out.push(labelled);
			}
		});
	}
	return out;
}

// ── the Pi's recording format ────────────────────────────────────────────

export interface ComposeOptions {
	jointNames: string[];
	title: string;
	now?: Date;
	extras?: Record<string, unknown>;
}

/** What a settle-flagged frame carries, so the Pi can settle there and echo the pose back. */
export interface SettleFlag {
	frame: number;
	pose: string;
	target: number[];
}

/**
 * Frames where the Pi's closed-loop replay (services/robot-arm/src/arm/
 * replay_settle.py) should settle the arm ON the pose: the arrival at every
 * held pose (the hold is the time it has to do it in) and the last frame.
 * Only poses can be settled — the lead-in origin has none — and a stop that
 * is not held gives the Pi no window, so it is left alone.
 */
export function settleFrames(p: RenderedPath): SettleFlag[] {
	const last = p.goal.length - 1;
	const out = new Map<number, SettleFlag>();
	p.markers.forEach((m, i) => {
		if (!m.poseId) return;
		const isLast = i === p.markers.length - 1;
		if (m.holdS <= 0 && !isLast) return;
		const frame = isLast && m.holdS <= 0 ? last : Math.min(last, Math.round(m.t * p.rateHz));
		out.set(frame, { frame, pose: m.poseId, target: m.target ?? m.positions });
	});
	return [...out.values()].sort((a, b) => a.frame - b.frame);
}

/**
 * The droop trim a pose needs, from what the Pi's settle pass ended up
 * writing to land on `target`: written − target on servos 1–5, capped.
 * Null when the Pi reported nothing usable.
 */
export function trimFromSettle(written: unknown, target: unknown): number[] | null {
	if (!Array.isArray(written) || !Array.isArray(target) || written.length !== SERVO_COUNT || target.length !== SERVO_COUNT) return null;
	return written.map((w, i) => {
		const d = Number(w) - Number(target[i]);
		if (!Number.isFinite(d) || !TRIM_SERVOS.includes(i + 1)) return 0;
		return Math.max(-MAX_TRIM_STEPS, Math.min(MAX_TRIM_STEPS, Math.round(d)));
	});
}

/** The dense path as a recording the Pi replays (header / frame / footer JSONL). */
export function composeAnimationJsonl(p: RenderedPath, o: ComposeOptions): { jsonl: string; frames: number; durationS: number } {
	const lines: string[] = [];
	const flags = new Map(settleFrames(p).map((f) => [f.frame, f]));
	lines.push(
		JSON.stringify({
			...(o.extras ?? {}),
			event: 'header',
			version: '1',
			timestamp: (o.now ?? new Date()).toISOString(),
			rate_hz: p.rateHz,
			joint_names: o.jointNames,
			follower_neutral: p.goal[0],
			animated: o.title
		})
	);
	for (let i = 0; i < p.goal.length; i++) {
		const f = flags.get(i);
		lines.push(JSON.stringify(f ? { event: 'frame', t: p.t[i], goal: p.goal[i], settle: true, pose: f.pose, target: f.target } : { event: 'frame', t: p.t[i], goal: p.goal[i] }));
	}
	lines.push(JSON.stringify({ event: 'footer', duration_s: p.durationS, frames: p.goal.length }));
	return { jsonl: lines.join('\n') + '\n', frames: p.goal.length, durationS: p.durationS };
}

export function cleanAnimationName(name: string): string | null {
	const n = name.trim();
	return /^[A-Za-z0-9 _.-]{1,100}$/.test(n) ? n : null;
}
