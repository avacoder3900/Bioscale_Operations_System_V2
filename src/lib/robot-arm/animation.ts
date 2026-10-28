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
 *
 * Fire steps (2026-10-28): a move set step can fire one of the cartridge
 * trapdoor solenoids instead of moving. The arm holds where it is for the
 * pulse plus the wait after it, then the next step runs. The Pi fires it from
 * the recording on a timer of its own (services/robot-arm replay_settle.py),
 * so the trapdoors keep their timing whatever the arm's settle pass is doing.
 */
import { cleanToleranceOverride } from './verified-poses';

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

// ── solenoids (cartridge trapdoors) ──────────────────────────────────────

export type Solenoid = 'A' | 'B';

/**
 * The two trapdoor solenoids on the arm Pi's GPIO (BCM numbers, as in
 * ~/solenoid.py and the Pi's SOLENOID_GPIO_PINS). Drop order: A first.
 */
export const SOLENOIDS: { id: Solenoid; pin: number; label: string }[] = [
	{ id: 'A', pin: 17, label: 'Solenoid A' },
	{ id: 'B', pin: 27, label: 'Solenoid B' }
];
/** Pulse range matches the Control tab's buttons (the Pi caps at 2000); default 100 ms (user, 2026-10-28). */
export const DEFAULT_PULSE_MS = 100;
export const MIN_PULSE_MS = 20;
export const MAX_PULSE_MS = 2000;
/**
 * The wait after a pulse before the next step. Never shorter than this, so two
 * fire steps in a row are always apart (both trapdoors open at once would drop
 * the whole stack) — the same 0.5 s gap as the Control tab's sequence button.
 */
export const MIN_FIRE_WAIT_S = 0.5;
export const DEFAULT_FIRE_WAIT_S = 1;

/** The Pi's solenoid state as the Animate pages show it (GET /gpio/status). */
export interface SolenoidStatus {
	pins: Record<string, { state: number }>;
	simulated: boolean;
	busy: boolean;
	/** The Pi's replay fires `fire` frames; false on a Pi without the 2026-10-28 replay. */
	replayFire: boolean;
}

/** A fire step's solenoid and pulse; the wait after it is the step's holdS. */
export interface FireSpec {
	solenoid: Solenoid;
	pulseMs: number;
}

export function isSolenoid(v: unknown): v is Solenoid {
	return v === 'A' || v === 'B';
}

export function solenoidPin(s: Solenoid): number {
	return SOLENOIDS.find((x) => x.id === s)!.pin;
}

export function solenoidLabel(s: Solenoid): string {
	return SOLENOIDS.find((x) => x.id === s)!.label;
}

/** How long a fire step holds the arm: the pulse, then the wait. */
export function fireStepS(k: { holdS: number; fire?: FireSpec }): number {
	return k.fire ? k.fire.pulseMs / 1000 + k.holdS : 0;
}

/** A fresh fire step, as the editor adds it. */
export function newFireStep(solenoid: Solenoid = 'A'): Keyframe {
	return { poseId: '', holdS: DEFAULT_FIRE_WAIT_S, durationS: 0, easing: 'linear', fire: { solenoid, pulseMs: DEFAULT_PULSE_MS } };
}

/** How many pose steps and fire steps a step list has. */
export function stepCounts(kfs: { fire?: FireSpec }[]): { poses: number; fires: number } {
	const fires = kfs.filter((k) => k.fire).length;
	return { poses: kfs.length - fires, fires };
}

/** "3 poses" or "3 poses · 1 fire". */
export function stepCountLabel(kfs: { fire?: FireSpec }[]): string {
	const c = stepCounts(kfs);
	const poses = `${c.poses} pose${c.poses === 1 ? '' : 's'}`;
	return c.fires ? `${poses} · ${c.fires} fire${c.fires === 1 ? '' : 's'}` : poses;
}

/**
 * Steps → resolved keyframes for the editors' previews (no droop trim): a
 * fire step keeps positions [] (buildPath holds it where the arm is). Null
 * when a pose is missing. `offsets` false leaves timeline offsets out.
 */
export function resolveForPreview(
	kfs: Keyframe[],
	poseById: Map<string, { name: string; positions: number[] }>,
	o: { offsets?: boolean } = {}
): ResolvedKeyframe[] | null {
	const out: ResolvedKeyframe[] = [];
	for (const k of kfs) {
		if (k.fire) {
			out.push({ ...k, name: `Fire ${solenoidLabel(k.fire.solenoid)}`, positions: [] });
			continue;
		}
		const p = poseById.get(k.poseId);
		if (!p) return null;
		out.push({ ...k, name: p.name, positions: o.offsets === false ? p.positions : keyframePositions(p.positions, k.offsets) });
	}
	return out;
}

/**
 * The path an editor draws. A list of only fire steps has no pose to hold, so
 * it is drawn at a stand-in position (only its timing matters on screen).
 */
export function previewPath(kfs: ResolvedKeyframe[], rateHz: number = DEFAULT_RATE_HZ): RenderedPath {
	const anyPose = kfs.some((k) => !k.fire);
	return buildPath(kfs, { rateHz, leadIn: anyPose ? null : { from: new Array(SERVO_COUNT).fill(2048) } });
}

/** First / last pose step (fire steps do not move the arm). */
export function firstPose<T extends { fire?: FireSpec }>(kfs: T[]): T | null {
	return kfs.find((k) => !k.fire) ?? null;
}
export function lastPose<T extends { fire?: FireSpec }>(kfs: T[]): T | null {
	for (let i = kfs.length - 1; i >= 0; i--) if (!kfs[i].fire) return kfs[i];
	return null;
}

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
	/**
	 * ARM-09 verified runs: camera check at this step. true = must be checked,
	 * false = never, absent = checked when the pose has a reference.
	 */
	verify?: boolean;
	/** ARM-09: this step's tolerances on top of the pose reference's. */
	tolerances?: { positionMm?: number | null; angleDeg?: number | null; steps?: number | null };
	/**
	 * Present: this step FIRES a solenoid instead of moving. poseId is '' and
	 * holdS is the wait after the pulse; durationS and easing are unused.
	 */
	fire?: FireSpec;
}

export interface ResolvedKeyframe extends Keyframe {
	name: string;
	positions: number[];
	/**
	 * Where the arm should END UP at this keyframe (pose + offsets) when
	 * `positions` also carries a droop trim; absent when they are the same.
	 */
	target?: number[];
	/**
	 * false = the pose is a set of commanded goals (made with the sliders), so
	 * the Pi plays it exactly and never "settles" it; anything else = the pose
	 * is an encoder reading and the Pi may settle onto it (settleFrames).
	 */
	settle?: boolean;
}

export type MarkerKind = 'pose' | 'lead-in' | 'join' | 'fire';

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
	/** false = a goal pose; the Pi must not settle here (ResolvedKeyframe.settle). */
	settle?: boolean;
	/** kind 'fire': the solenoid fired at `t` (holdS is pulse + wait). */
	fire?: FireSpec & { pin: number };
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
		if (k?.fire) return cleanFireStep(k, i);
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
		if (k?.verify === true || k?.verify === false) out.verify = k.verify;
		const tol = cleanToleranceOverride(k?.tolerances);
		if (tol) out.tolerances = tol;
		return out;
	});
}

function cleanFireStep(k: any, i: number): Keyframe {
	const solenoid = k.fire?.solenoid;
	if (!isSolenoid(solenoid)) throw new Error(`step ${i + 1}: pick solenoid A or B`);
	const pulseMs = Math.round(Number(k.fire?.pulseMs ?? DEFAULT_PULSE_MS));
	if (!Number.isFinite(pulseMs) || pulseMs < MIN_PULSE_MS || pulseMs > MAX_PULSE_MS)
		throw new Error(`step ${i + 1}: the pulse must be ${MIN_PULSE_MS}–${MAX_PULSE_MS} ms`);
	const waitS = Number(k.holdS ?? DEFAULT_FIRE_WAIT_S);
	if (!Number.isFinite(waitS) || waitS < MIN_FIRE_WAIT_S || waitS > MAX_HOLD_S)
		throw new Error(`step ${i + 1}: the wait after firing must be ${MIN_FIRE_WAIT_S}–${MAX_HOLD_S} s`);
	return { poseId: '', holdS: roundTenth(waitS), durationS: 0, easing: 'linear', fire: { solenoid, pulseMs } };
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
	// Fire steps do not move the arm: each pose is compared with the pose before it.
	let prev: ResolvedKeyframe | null = null;
	kfs.forEach((k, i) => {
		if (k.fire) return;
		if (prev) {
			const min = minDurationS(prev.positions, k.positions, MAX_STEPS_PER_S, k.easing);
			if (k.durationS < min) out.push({ index: i, message: `${k.name}: ${k.durationS} s is too fast for this move — at least ${min} s.` });
		}
		prev = k;
	});
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
	settle?: boolean;
	fire?: FireSpec & { pin: number };
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
 *
 * A fire step is a node where the arm stays put (on the previous pose, or
 * where the arm is when the path starts with one) for the pulse plus the
 * wait; its marker's `t` is when the Pi fires. A list of only fire steps is a
 * path that holds the arm where it is.
 */
export function buildPath(kfs: ResolvedKeyframe[], o: BuildOptions = {}): RenderedPath {
	const rate = o.rateHz && o.rateHz > 0 ? o.rateHz : DEFAULT_RATE_HZ;
	if (!kfs.length) throw new Error('a move set needs at least one step');
	for (const k of kfs) if (!k.fire && k.positions.length !== SERVO_COUNT) throw new Error(`${k.name}: pose has ${k.positions.length} positions, not ${SERVO_COUNT}`);

	const nodes: Node[] = [];
	const poseNode = (k: ResolvedKeyframe, index: number, durationS: number, easing: Easing): Node => ({
		positions: k.positions,
		holdS: k.holdS,
		durationS,
		easing,
		label: k.name,
		kind: (k as any).kind === 'join' ? 'join' : 'pose',
		index,
		poseId: k.poseId,
		target: k.target,
		...(k.settle === false ? { settle: false } : {})
	});
	const first = kfs.find((k) => !k.fire) ?? null;
	const from = o.leadIn && o.leadIn.from.length === SERVO_COUNT ? o.leadIn.from : null;
	const leadS = from && first && maxDelta(from, first.positions) ? (o.leadIn?.durationS ?? autoDurationS(from, first.positions)) : 0;
	// Where the arm is while a fire step runs: the last pose, or the start.
	let here = from ?? first?.positions ?? null;
	if (!here) throw new Error("fire steps need the arm's position — add a pose, or play it on the arm");
	if (from && (leadS > 0 || kfs[0].fire)) nodes.push({ positions: from, holdS: 0, durationS: 0, easing: 'ease', label: 'start (arm now)', kind: 'lead-in', index: -1 });
	kfs.forEach((k, i) => {
		if (k.fire) {
			nodes.push({
				positions: here!,
				holdS: fireStepS(k),
				durationS: 0,
				easing: 'linear',
				label: k.name,
				kind: 'fire',
				index: i,
				fire: { ...k.fire, pin: solenoidPin(k.fire.solenoid) }
			});
			return;
		}
		nodes.push(k === first ? poseNode(k, i, leadS, 'ease') : poseNode(k, i, k.durationS, k.easing));
		here = k.positions;
	});

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
		...(nd.target ? { target: nd.target.map(clampStep) } : {}),
		...(nd.settle === false ? { settle: false } : {}),
		...(nd.fire ? { fire: nd.fire } : {})
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
	// The last pose so far: a join runs from it (fire steps do not move the arm).
	let lastPose: ResolvedKeyframe | null = null;
	for (const item of items) {
		if (!item.keyframes.length) continue;
		const firstPose = item.keyframes.find((k) => !k.fire);
		item.keyframes.forEach((k) => {
			const labelled = { ...k, name: `${item.name} · ${k.name}` };
			if (k.fire) {
				out.push(labelled);
				return;
			}
			const prevPose: ResolvedKeyframe | null = lastPose;
			lastPose = labelled;
			if (k === firstPose && prevPose) {
				const prev = out[out.length - 1];
				const d = item.join.durationS ?? autoDurationS(prevPose.positions, k.positions);
				if (d > 0) out.push({ ...labelled, durationS: d, easing: item.join.easing, kind: 'join' });
				else {
					// Same pose as where the last set ended: just extend the hold.
					prev.holdS = roundTenth(prev.holdS + k.holdS);
					lastPose = prevPose;
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
	// Fire steps after the last pose keep the arm on it, so that pose still settles at the end.
	const lastPose = p.markers.reduce((acc, m, i) => (m.poseId ? i : acc), -1);
	p.markers.forEach((m, i) => {
		// Goal poses are played exactly as commanded; settling would push the arm past where the operator saw it.
		if (!m.poseId || m.settle === false) return;
		const isLast = i === lastPose;
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

/** What a fire frame carries: the Pi pulses `pin` for `ms` at this frame's time. */
export interface FireFlag {
	frame: number;
	t: number;
	pin: number;
	ms: number;
	solenoid: Solenoid;
}

/** The frames where fire steps fire (each marker's time, on the frame grid). */
export function fireFrames(p: RenderedPath): FireFlag[] {
	const last = p.goal.length - 1;
	return p.markers
		.filter((m) => m.fire)
		.map((m) => {
			const frame = Math.min(last, Math.round(m.t * p.rateHz));
			return { frame, t: p.t[frame], pin: m.fire!.pin, ms: m.fire!.pulseMs, solenoid: m.fire!.solenoid };
		});
}

/** The dense path as a recording the Pi replays (header / frame / footer JSONL). */
export function composeAnimationJsonl(p: RenderedPath, o: ComposeOptions): { jsonl: string; frames: number; durationS: number; fires: number } {
	const lines: string[] = [];
	const flags = new Map(settleFrames(p).map((f) => [f.frame, f]));
	const fires = fireFrames(p);
	const fireAt = new Map(fires.map((f) => [f.frame, f]));
	lines.push(
		JSON.stringify({
			...(o.extras ?? {}),
			event: 'header',
			version: '1',
			timestamp: (o.now ?? new Date()).toISOString(),
			rate_hz: p.rateHz,
			joint_names: o.jointNames,
			follower_neutral: p.goal[0],
			animated: o.title,
			// replay_settle.py keeps torque on at the end when it sees this, so the
			// arm holds the last pose instead of going limp (older Pi code ignores it).
			hold_at_end: true,
			// How many frames fire a solenoid. BIMS plays a path with fires only on
			// a Pi whose replay can fire them (GET /gpio/status → replay_fire).
			...(fires.length ? { fires: fires.length } : {})
		})
	);
	for (let i = 0; i < p.goal.length; i++) {
		const f = flags.get(i);
		const fire = fireAt.get(i);
		const frame: Record<string, unknown> = f
			? { event: 'frame', t: p.t[i], goal: p.goal[i], settle: true, pose: f.pose, target: f.target }
			: { event: 'frame', t: p.t[i], goal: p.goal[i] };
		if (fire) frame.fire = { pin: fire.pin, ms: fire.ms, solenoid: fire.solenoid };
		lines.push(JSON.stringify(frame));
	}
	lines.push(JSON.stringify({ event: 'footer', duration_s: p.durationS, frames: p.goal.length }));
	return { jsonl: lines.join('\n') + '\n', frames: p.goal.length, durationS: p.durationS, fires: fires.length };
}

export function cleanAnimationName(name: string): string | null {
	const n = name.trim();
	return /^[A-Za-z0-9 _.-]{1,100}$/.test(n) ? n : null;
}

// ── servo temperature ────────────────────────────────────────────────────

/**
 * STS3215 temperatures (°C, from GET /servos). The Pi's own arm-health check
 * calls 48 warm and 55 hot (the servo derates above ~60); the servo's
 * firmware cuts out at 70 by default. BIMS refuses to start a motion at
 * SERVO_TEMP_STOP_C so a hot joint is never the one that quits mid-move.
 */
export const SERVO_TEMP_WARM_C = 48;
export const SERVO_TEMP_HOT_C = 55;
export const SERVO_TEMP_STOP_C = 65;

export type HeatLevel = 'ok' | 'warm' | 'hot' | 'stop';

export function heatLevel(tempC: number | null | undefined): HeatLevel {
	if (tempC == null || !Number.isFinite(tempC)) return 'ok';
	if (tempC >= SERVO_TEMP_STOP_C) return 'stop';
	if (tempC >= SERVO_TEMP_HOT_C) return 'hot';
	if (tempC >= SERVO_TEMP_WARM_C) return 'warm';
	return 'ok';
}

/** Servos (ids) at or above the stop temperature, and the hottest reading. */
export function heatCheck(temps: (number | null)[]): { tooHot: number[]; hot: number[]; maxC: number | null } {
	const tooHot: number[] = [];
	const hot: number[] = [];
	let maxC: number | null = null;
	temps.forEach((t, i) => {
		if (t == null || !Number.isFinite(t)) return;
		maxC = maxC == null ? t : Math.max(maxC, t);
		const lvl = heatLevel(t);
		if (lvl === 'stop') tooHot.push(i + 1);
		else if (lvl === 'hot') hot.push(i + 1);
	});
	return { tooHot, hot, maxC };
}

// ── names ────────────────────────────────────────────────────────────────

/**
 * A name as the operator should read it. Poses and move sets made from
 * recordings carry the recording's file name ("telop3-20261022-191057.jsonl");
 * the extension and the timestamp say nothing on screen. Stored names are not
 * changed — this is display only. Falls back to the raw name if stripping
 * would leave nothing.
 */
export function friendlyName(name: string): string {
	const raw = String(name ?? '');
	const out = raw
		.replace(/\.jsonl\b/gi, '')
		.replace(/[-_ ]?\d{8}[-_T]?\d{4,6}(?:Z)?/g, '')
		.replace(/[-_]{2,}/g, '-')
		.replace(/\s{2,}/g, ' ')
		.replace(/^[\s\-_·]+|[\s\-_·]+$/g, '')
		.trim();
	return out || raw.trim();
}

/**
 * Poses made together (a clean-up sent to Animate) are named "<group> · <label>".
 * Split that so the library can show them under one heading.
 */
export function poseGroup(name: string): { group: string | null; label: string } {
	const i = name.indexOf(' · ');
	if (i <= 0) return { group: null, label: friendlyName(name) };
	return { group: friendlyName(name.slice(0, i)), label: friendlyName(name.slice(i + 3)) };
}

// ── bulk pose actions ────────────────────────────────────────────────────

/** At most this many poses in one bulk archive / restore / delete. */
export const POSE_BULK_MAX = 200;

/** Pose ids from a bulk form (FormData.getAll): trimmed, de-duplicated, in order. */
export function cleanPoseIds(raw: unknown[]): string[] {
	const ids = [...new Set(raw.map((v) => String(v ?? '').trim()).filter(Boolean))];
	if (!ids.length) throw new Error('No poses selected.');
	if (ids.length > POSE_BULK_MAX) throw new Error(`At most ${POSE_BULK_MAX} poses at a time.`);
	return ids;
}

export interface PoseSkip {
	id: string;
	name: string;
	reason: string;
}

/**
 * Which of the selected poses may be deleted for good: only archived ones
 * that no move set uses. Archived move sets count too — they can be
 * restored, and a move set with a missing pose can no longer play or save.
 */
export function planPoseDelete(
	ids: string[],
	poses: { _id: string; name: string; archived: boolean }[],
	moveSets: { name: string; poseIds: string[] }[]
): { deletable: string[]; skipped: PoseSkip[] } {
	const byId = new Map(poses.map((p) => [p._id, p]));
	const usedBy = new Map<string, string[]>();
	for (const ms of moveSets) for (const id of new Set(ms.poseIds)) usedBy.set(id, [...(usedBy.get(id) ?? []), ms.name]);
	const deletable: string[] = [];
	const skipped: PoseSkip[] = [];
	for (const id of ids) {
		const p = byId.get(id);
		if (!p) skipped.push({ id, name: id, reason: 'not found' });
		else if (!p.archived) skipped.push({ id, name: p.name, reason: 'not archived — archive it first' });
		else if (usedBy.has(id)) {
			const sets = usedBy.get(id)!.map((n) => `"${friendlyName(n)}"`);
			skipped.push({ id, name: p.name, reason: `used by move set ${sets.slice(0, 3).join(', ')}${sets.length > 3 ? ` and ${sets.length - 3} more` : ''}` });
		} else deletable.push(id);
	}
	return { deletable, skipped };
}

/** One line for the page: what a bulk action did and what it left alone. */
export function bulkPoseMessage(verb: string, done: number, skipped: PoseSkip[]): string {
	const head = `${verb} ${done} pose${done === 1 ? '' : 's'}.`;
	if (!skipped.length) return head;
	const list = skipped.slice(0, 5).map((s) => `"${friendlyName(s.name)}" (${s.reason})`);
	return `${head} Skipped ${skipped.length}: ${list.join('; ')}${skipped.length > 5 ? `; and ${skipped.length - 5} more` : ''}.`;
}

// ── sliders ──────────────────────────────────────────────────────────────

/** Encoder steps → degrees of joint rotation (4096 steps per turn). */
export const DEG_PER_STEP = 360 / (ENCODER_MAX + 1);

/**
 * The range a servo's slider covers: every value the arm has been seen at for
 * that servo (saved poses, the arm now), padded either side, inside the
 * encoder. A full 0–4095 slider is too coarse to pose with; this keeps the
 * travel the arm actually uses under the operator's thumb. At least `minSpan` wide.
 */
export function sliderRange(values: number[], pad = 400, minSpan = 1200): { min: number; max: number } {
	const v = values.filter((x) => Number.isFinite(x));
	if (!v.length) return { min: 0, max: ENCODER_MAX };
	let min = Math.min(...v) - pad;
	let max = Math.max(...v) + pad;
	if (max - min < minSpan) {
		const mid = (min + max) / 2;
		min = mid - minSpan / 2;
		max = mid + minSpan / 2;
	}
	min = Math.max(0, min);
	max = Math.min(ENCODER_MAX, max);
	// Clamped against an end and now too narrow: widen toward the other end.
	if (max - min < minSpan) {
		if (min === 0) max = Math.min(ENCODER_MAX, minSpan);
		else min = Math.max(0, ENCODER_MAX - minSpan);
	}
	return { min: Math.round(min), max: Math.round(max) };
}

/** Evenly spaced, round axis ticks between min and max (inclusive ends). */
export function axisTicks(min: number, max: number, target = 6): number[] {
	const span = max - min;
	if (span <= 0) return [min];
	const raw = span / target;
	const mag = 10 ** Math.floor(Math.log10(raw));
	const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
	const out: number[] = [];
	for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(v);
	return out;
}

/**
 * Clamp a move toward `to` to at most `maxStep` from `from`. No longer used
 * by the live sliders (2026-10-23: the operator wants a typed value to be
 * exactly where the joint goes, with no step limit); kept for callers that
 * pace a move themselves.
 */
export function stepToward(from: number, to: number, maxStep: number): number {
	const d = to - from;
	if (Math.abs(d) <= maxStep) return to;
	return from + Math.sign(d) * maxStep;
}

