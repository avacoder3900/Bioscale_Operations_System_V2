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
 * Neither side is trusted alone. The servos can say "home" while a broken
 * 3D-printed link or a slipped horn leaves the arm elsewhere (tags catch it);
 * the camera can miss a joint that is short of its target because something
 * rigid is in the way (encoders and load catch it). "home" needs both.
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
 * Overshoot for a joint that stalls short of home (2026-10-23). Seen on the
 * base (servo 1): told to go to 1991 it rests at 1952 every time — a 39-step
 * steady-state error under load — and each new jog of +39 just re-sends the
 * same goal, so 32 jogs per attempt moved it nothing. The remedy is the
 * droop trim's: command PAST the target by what it keeps falling short by.
 * After a pass, a joint that moved less than STUCK_STEPS and is still off
 * gets its residual added to a per-joint carry (capped at MAX_CARRY_STEPS,
 * ~13°, so a joint against a real obstacle is not driven ever harder);
 * the next pass aims at target + carry.
 */
export const STUCK_STEPS = 6;
export const MAX_CARRY_STEPS = 150;

/** Target with each joint's carry added, clamped to the encoder range. */
export function aimWithCarry(target: JointSteps, carry: Record<string, number>): JointSteps {
	const out: JointSteps = {};
	for (const [k, v] of Object.entries(target)) out[k] = Math.max(0, Math.min(4095, v + (carry[k] ?? 0)));
	return out;
}

/**
 * The carry for the next pass: for each home joint that is still off by more
 * than `tolerance` and moved less than `stuckSteps` during the last pass,
 * add its residual (target − current) to the carry, capped. Joints that
 * moved, or that are within tolerance, keep their carry as it is.
 */
export function carryAfterPass(
	prev: JointSteps,
	current: JointSteps,
	target: JointSteps,
	carry: Record<string, number>,
	o: { tolerance?: number; stuckSteps?: number; maxCarry?: number; sids?: readonly number[] } = {}
): Record<string, number> {
	const tol = o.tolerance ?? HOME_STEP_TOLERANCE;
	const stuck = o.stuckSteps ?? STUCK_STEPS;
	const cap = o.maxCarry ?? MAX_CARRY_STEPS;
	const out = { ...carry };
	for (const sid of o.sids ?? HOME_SERVO_IDS) {
		const k = String(sid);
		const cur = current[k];
		const was = prev[k];
		const tgt = target[k];
		if (![cur, was, tgt].every(Number.isFinite)) continue;
		const residual = Math.round(tgt - cur);
		if (Math.abs(residual) <= tol) continue;
		if (Math.abs(cur - was) >= stuck) continue;
		out[k] = Math.max(-cap, Math.min(cap, (out[k] ?? 0) + residual));
	}
	return out;
}

/**
 * Claw closing: it is closed when a closing jog moves it less than this —
 * it has hit the cartridge-free stop. (There is no taught "closed" position.)
 */
export const CLAW_STALL_STEPS = 6;

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

/**
 * "Close enough to close the claw" (2026-10-23, Alejandro with Sam's OK):
 * once this much of the loop has passed and every home joint is within
 * CLAW_CLOSE_TOLERANCE steps, stop jogging and close the claw. Before this
 * the claw only closed once every joint was within HOME_STEP_TOLERANCE
 * (12 steps, ~1°); a joint hovering at 13–30 steps (shoulder sag, jitter)
 * kept the loop jogging for the full 90 s with the mouth open. The claw
 * closing was never a stall risk in itself — it closes to its stop with
 * stall detection (CLAW_STALL_STEPS) — the delay was only this ordering.
 */
export const CLAW_CLOSE_AFTER_MS = 5_000;
/** ~3.5° per joint. The "home" verdict itself still needs HOME_STEP_TOLERANCE. */
export const CLAW_CLOSE_TOLERANCE = 40;

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
 * Whether the browser should send another attempt. One click keeps the arm
 * returning until EVERYTHING is in place — joints home and the claw closed —
 * with no jog limit; the operator can press Stop at any time. It only stops
 * by itself on: done, a freeze, a moved camera (the picture is meaningless
 * until recalibrated), encoders home + claw closed but the tags disagree
 * (more moving would change nothing), or the 90 s cap.
 */
export function shouldRetryHome(o: {
	verdict: string;
	elapsedMs: number;
	residualMax: number | null;
	/** true = claw closed this run; false = not yet; null = no claw reading (not required). */
	clawClosed: boolean | null;
	limitMs?: number;
	/** Override CLAW_CLOSE_AFTER_MS / CLAW_CLOSE_TOLERANCE (tests). */
	clawAfterMs?: number;
	clawToleranceSteps?: number;
}): { retry: boolean; reason: string } {
	if (o.verdict === 'frozen') return { retry: false, reason: 'frozen' };
	if (o.verdict === 'camera_moved') return { retry: false, reason: 'the camera moved — recalibrate' };
	const clawDone = o.clawClosed !== false;
	if (o.verdict === 'home' && clawDone) return { retry: false, reason: 'home, claw closed' };
	if (o.elapsedMs >= (o.limitMs ?? HOME_LOOP_MS)) return { retry: false, reason: 'timed out' };
	const landed = o.residualMax != null && o.residualMax <= HOME_STEP_TOLERANCE;
	if (landed && clawDone && o.verdict === 'unverified') return { retry: false, reason: 'encoders are home; the camera could not confirm it' };
	if (landed && clawDone && o.verdict !== 'home') return { retry: false, reason: 'encoders are home; the tags disagree' };
	// Close enough, long enough: stop jogging; the page closes the claw next (closeClaw) if it is still open.
	const near = o.residualMax != null && o.residualMax <= (o.clawToleranceSteps ?? CLAW_CLOSE_TOLERANCE);
	if (near && o.elapsedMs >= (o.clawAfterMs ?? CLAW_CLOSE_AFTER_MS)) {
		const where = `encoders within ${o.residualMax} step(s) of home after ${Math.round(o.elapsedMs / 1000)} s`;
		return { retry: false, reason: clawDone ? where : `${where} — closing the claw` };
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

// ── servo state ──────────────────────────────────────────────────────────

/**
 * |load| at or above this counts as a servo working hard (out of ~1000).
 * Same threshold as the Pi's /arm/health HEALTH_LOAD_HIGH.
 */
export const SERVO_LOAD_HIGH = 600;
/**
 * A joint is only called strained when its load is also this much above what
 * it held at home — a joint that carries the arm's weight at home anyway
 * should not read as blocked on every check.
 */
export const SERVO_LOAD_MARGIN = 150;
/** Same as the Pi's HEALTH_TEMP_HOT_C; the STS3215 derates above ~60 °C. */
export const SERVO_TEMP_HOT_C = 55;

/** One servo as the Pi reported it. Telemetry is null when only steps were readable. */
export interface ServoReading {
	sid: number;
	steps: number;
	load: number | null;
	temperatureC: number | null;
	voltage: number | null;
	torque: boolean | null;
}

export interface StrainedJoint {
	sid: number;
	load: number | null;
	temperatureC: number | null;
	reason: 'high_load' | 'hot';
}

/**
 * Home joints that are pushing hard or running hot. `baseline` is what the
 * same servos read at calibration; a joint's load must exceed both the
 * absolute threshold and its home load by the margin.
 */
export function strainedJoints(now: ServoReading[], baseline: ServoReading[] | null = null): StrainedJoint[] {
	const out: StrainedJoint[] = [];
	for (const sid of HOME_SERVO_IDS) {
		const s = now.find((x) => x.sid === sid);
		if (!s) continue;
		const homeLoad = baseline?.find((x) => x.sid === sid)?.load;
		const load = s.load;
		if (load != null && Math.abs(load) >= SERVO_LOAD_HIGH && (homeLoad == null || Math.abs(load) >= Math.abs(homeLoad) + SERVO_LOAD_MARGIN)) {
			out.push({ sid, load, temperatureC: s.temperatureC, reason: 'high_load' });
		} else if (s.temperatureC != null && s.temperatureC >= SERVO_TEMP_HOT_C) {
			out.push({ sid, load, temperatureC: s.temperatureC, reason: 'hot' });
		}
	}
	return out;
}

/**
 * Home joints whose encoders changed by more than `tolerance` between two
 * reads (or are missing from either) — the arm moved while the camera was
 * capturing, so the frame and the encoders do not describe the same pose.
 */
export function unsteadyJoints(before: JointSteps, after: JointSteps, tolerance = HOME_STEP_TOLERANCE): number[] {
	const out: number[] = [];
	for (const sid of HOME_SERVO_IDS) {
		const a = before[String(sid)];
		const b = after[String(sid)];
		if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(b - a) > tolerance) out.push(sid);
	}
	return out;
}

// ── verdict ──────────────────────────────────────────────────────────────

export type HomeVerdict =
	| 'home'
	| 'position_off'
	| 'markers_off'
	| 'camera_moved'
	| 'position_off_and_markers_off'
	/**
	 * Nothing is wrong on the side(s) that could be checked, but at least one
	 * side is missing (no encoder home, encoders unreadable, camera down, or no
	 * arm tag tracked). Never reported as home: home needs both.
	 */
	| 'unverified'
	/** Servo A out of its safe range: nothing moved, torque dropped, a person returns the arm. */
	| 'frozen';

export interface HomeAssessment {
	verdict: HomeVerdict;
	/** Every home joint within tolerance (null = no encoder target or no reading). */
	landed: boolean | null;
	/**
	 * Every tag at its calibrated spot, with at least one arm tag tracked
	 * (null = no vision check ran, or only fixed tags were tracked — those say
	 * nothing about the arm).
	 */
	markersOk: boolean | null;
	residualMax: number | null;
	/** Home joints pushing hard or running hot (informational; explains a miss). */
	strained: StrainedJoint[];
}

/**
 * Combine encoders and tags into one verdict. Any disagreement is reported;
 * "home" needs BOTH sides to have been checked and to agree. A missing side
 * gives "unverified", never "home". A camera that moved trumps everything:
 * neither the picture nor the arm check means anything until it is
 * recalibrated. ("frozen" is decided before any of this, by baseOutOfRange.)
 */
export function assessHome(r: Residuals | null, vision: VisionAssessment | null, strained: StrainedJoint[] = []): HomeAssessment {
	const landed = r ? r.off.length === 0 && Number.isFinite(r.max) : null;
	const armTracked = !!vision?.markers?.some((m) => m.role === 'arm');
	const markersOk = !vision || vision.verdict === 'no_markers' ? null : vision.verdict === 'off' ? false : vision.verdict === 'ok' && armTracked ? true : null;
	let verdict: HomeVerdict;
	if (vision?.verdict === 'camera_moved') verdict = 'camera_moved';
	else if (landed === false && markersOk === false) verdict = 'position_off_and_markers_off';
	else if (landed === false) verdict = 'position_off';
	else if (markersOk === false) verdict = 'markers_off';
	else if (landed === true && markersOk === true) verdict = 'home';
	else verdict = 'unverified';
	return { verdict, landed, markersOk, residualMax: r ? r.max : null, strained };
}
