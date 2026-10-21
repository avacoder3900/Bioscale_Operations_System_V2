/**
 * Robot arm — HOME recovery: the encoder half (pure logic, no I/O).
 *
 * The fail state this exists for: a task ends with the arm somewhere other
 * than home (a stalled servo, a stopped replay, a bump). The vision
 * calibration (ARM-05, $lib/robot-arm/apriltags) stores the follower's encoder
 * steps at the moment it was taken with the arm parked at home; a return to
 * home jogs each joint back to those steps, and the AprilTags then
 * confirm — independently of the servos' own report — that every tracked
 * point really is back where it was.
 *
 * ARM-03's greyscale whole-frame signature lived here too; ARM-04 replaced it
 * with per-marker tracking; ARM-05 swapped the stickers for AprilTags.
 */
import type { VisionAssessment } from './apriltags';

/** The positioning chain. Servo 6 (gripper) does not take part in home. */
export const HOME_SERVO_IDS = [1, 2, 3, 4, 5] as const;

/**
 * A joint within this many encoder steps of its taught value counts as home.
 * STS3215: 4096 steps / rev, so 12 steps ≈ 1.05°. Tight enough to catch a
 * skipped tooth, loose enough for the servo's own settle jitter.
 */
export const HOME_STEP_TOLERANCE = 12;

export type JointSteps = Record<string, number>;

export interface JogPlanStep {
	sid: number;
	delta: number;
}

/**
 * Per-joint deltas that take `current` to `target`, skipping joints already
 * within `tolerance`. Throws when a home joint is missing from either side —
 * a partial move to home is worse than no move.
 */
export function planJogDeltas(
	current: JointSteps,
	target: JointSteps,
	tolerance = HOME_STEP_TOLERANCE,
	sids: readonly number[] = HOME_SERVO_IDS
): JogPlanStep[] {
	const plan: JogPlanStep[] = [];
	for (const sid of sids) {
		const cur = current[String(sid)];
		const tgt = target[String(sid)];
		if (!Number.isFinite(cur)) throw new Error(`servo ${sid}: no current position reported`);
		if (!Number.isFinite(tgt)) throw new Error(`servo ${sid}: no taught home position`);
		const delta = Math.round(tgt - cur);
		if (Math.abs(delta) > tolerance) plan.push({ sid, delta });
	}
	return plan;
}

/** The Pi refuses a single jog bigger than this (manual_control.MAX_JOG_STEPS). */
export const MAX_JOG_STEPS = 300;

/**
 * Jogs per Return-to-home ATTEMPT, across all its passes. Each jog is one
 * round trip to the Pi; this keeps one attempt plus the camera check inside
 * Vercel's 30 s. The browser repeats attempts until home (HOME_LOOP_MS).
 */
export const MAX_HOME_JOGS = 20;

// ── the home sequence ────────────────────────────────────────────────────

/** Servo A: base rotation (shoulder_pan). Outside its safe range, home freezes instead of moving. */
export const BASE_SERVO_ID = 1;
/** Servo B: shoulder lift. Homed on its own, right after the mouth opens, before the rest. */
export const LIFT_SERVO_ID = 2;
/** The mouth (gripper). Positive steps open it (teleop_keyboard.py: z = +1 = open). */
export const GRIPPER_SERVO_ID = 6;

export const STEPS_PER_REV = 4096;
export const degToSteps = (deg: number) => Math.round((deg * STEPS_PER_REV) / 360);
export const stepsToDeg = (steps: number) => (steps * 360) / STEPS_PER_REV;

export interface HomingSettings {
	/** Servo 1 may be at most this many steps either side of home; beyond it, freeze. */
	baseRangeSteps: number;
	/** How far the mouth opens (steps, positive = open) before the arm moves. 0 = skip. */
	gripperOpenSteps: number;
}

/** ±90° on servo 1; mouth opens one max-size jog (~26°). */
export const DEFAULT_HOMING: HomingSettings = { baseRangeSteps: degToSteps(90), gripperOpenSteps: MAX_JOG_STEPS };

/** The browser stops repeating attempts after this long. */
export const HOME_LOOP_MS = 90_000;

export interface BaseOutOfRange {
	sid: number;
	/** current − home, steps (sign: which side). */
	offSteps: number;
	limitSteps: number;
}

/**
 * Servo A's safety gate: if the base is further than `limitSteps` either side
 * of home, Return to home must not move anything — the arm is somewhere
 * the camera-less return cannot reason about (a future head camera will).
 * A missing reading on either side also freezes: no guessing.
 */
export function baseOutOfRange(current: JointSteps, target: JointSteps, limitSteps: number): BaseOutOfRange | null {
	const k = String(BASE_SERVO_ID);
	const cur = current[k];
	const tgt = target[k];
	if (!Number.isFinite(cur) || !Number.isFinite(tgt)) return { sid: BASE_SERVO_ID, offSteps: Number.NaN, limitSteps };
	const off = Math.round(cur - tgt);
	return Math.abs(off) > limitSteps ? { sid: BASE_SERVO_ID, offSteps: off, limitSteps } : null;
}

/**
 * Whether the browser should run another attempt. Stops on home, on a freeze
 * or error, at the time limit, and when the arm stopped getting closer (two
 * attempts in a row within a few steps of each other — a stalled joint will
 * not be fixed by more of the same).
 */
export function shouldRetryHome(o: {
	verdict: string;
	elapsedMs: number;
	residualMax: number | null;
	previousResidualMax: number | null;
	limitMs?: number;
}): { retry: boolean; reason: string } {
	if (o.verdict === 'home') return { retry: false, reason: 'home' };
	if (o.verdict === 'frozen') return { retry: false, reason: 'frozen' };
	if (o.verdict === 'camera_moved') return { retry: false, reason: 'the camera moved — recalibrate' };
	if (o.elapsedMs >= (o.limitMs ?? HOME_LOOP_MS)) return { retry: false, reason: 'timed out' };
	// Encoders home but tags off: moving again would not change anything.
	if (o.residualMax != null && o.residualMax <= HOME_STEP_TOLERANCE) return { retry: false, reason: 'encoders are home; the tags disagree' };
	if (
		o.residualMax != null &&
		o.previousResidualMax != null &&
		Number.isFinite(o.residualMax) &&
		o.residualMax >= o.previousResidualMax - 3
	) {
		return { retry: false, reason: 'not getting closer' };
	}
	return { retry: true, reason: '' };
}

/**
 * Split each joint's delta into jogs the Pi accepts (≤ `max` steps each), in
 * joint order: J1 −1185 → −300, −300, −300, −285.
 */
export function chunkJogPlan(plan: JogPlanStep[], max = MAX_JOG_STEPS): JogPlanStep[] {
	const out: JogPlanStep[] = [];
	for (const { sid, delta } of plan) {
		let left = delta;
		while (left !== 0) {
			const c = Math.max(-max, Math.min(max, left));
			out.push({ sid, delta: c });
			left -= c;
		}
	}
	return out;
}

export interface Residuals {
	perJoint: Record<string, number>;
	max: number;
	/** Joints further than the tolerance from home. */
	off: number[];
}

/** target − current per home joint, and the worst one. */
export function residuals(current: JointSteps, target: JointSteps, tolerance = HOME_STEP_TOLERANCE): Residuals {
	const perJoint: Record<string, number> = {};
	let max = 0;
	const off: number[] = [];
	for (const sid of HOME_SERVO_IDS) {
		const cur = current[String(sid)];
		const tgt = target[String(sid)];
		const r = Number.isFinite(cur) && Number.isFinite(tgt) ? Math.round(tgt - cur) : Number.NaN;
		perJoint[String(sid)] = r;
		const a = Number.isNaN(r) ? Number.POSITIVE_INFINITY : Math.abs(r);
		if (a > max) max = a;
		if (a > tolerance) off.push(sid);
	}
	return { perJoint, max, off };
}

export type HomeVerdict =
	| 'home'
	| 'position_off'
	| 'markers_off'
	| 'camera_moved'
	| 'position_off_and_markers_off'
	/** Neither side could be checked — never reported as home. */
	| 'unverified'
	/** Servo A out of its safe range: nothing moved, torque dropped, a person returns the arm. */
	| 'frozen';

export interface HomeAssessment {
	verdict: HomeVerdict;
	/** Every home joint within tolerance (null = the calibration stored no encoder steps). */
	landed: boolean | null;
	/** Every marker at its calibrated spot (null = no vision check ran). */
	markersOk: boolean | null;
	residualMax: number | null;
}

/**
 * Combine encoders and markers into one verdict. Either side may be absent
 * (no encoders captured; camera unavailable) — the verdict is then the other
 * side's alone. A camera that moved trumps everything: neither the picture nor
 * the arm check means anything until it is recalibrated.
 */
export function assessHome(r: Residuals | null, vision: VisionAssessment | null): HomeAssessment {
	const landed = r ? r.off.length === 0 && Number.isFinite(r.max) : null;
	const markersOk = vision && vision.verdict !== 'no_markers' ? vision.verdict === 'ok' : null;
	let verdict: HomeVerdict;
	if (vision?.verdict === 'camera_moved') verdict = 'camera_moved';
	else if (landed === false && markersOk === false) verdict = 'position_off_and_markers_off';
	else if (landed === false) verdict = 'position_off';
	else if (markersOk === false) verdict = 'markers_off';
	else if (landed === null && markersOk === null) verdict = 'unverified';
	else verdict = 'home';
	return { verdict, landed, markersOk, residualMax: r ? r.max : null };
}
