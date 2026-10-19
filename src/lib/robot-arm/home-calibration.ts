/**
 * Robot arm — HOME recovery: the encoder half (pure logic, no I/O).
 *
 * The fail state this exists for: a task ends with the arm somewhere other
 * than home (a stalled servo, a stopped replay, a bump). The vision
 * calibration (ARM-04, $lib/robot-arm/markers) stores the follower's encoder
 * steps at the moment it was taken with the arm parked at home; a return to
 * home jogs each joint back to those steps, and the sticker markers then
 * confirm — independently of the servos' own report — that every tracked
 * point really is back where it was.
 *
 * ARM-03's greyscale whole-frame signature lived here too; ARM-04 replaced it
 * with per-marker tracking, which says WHICH point is off and by how much.
 */
import type { VisionAssessment } from './markers';

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
export function planJogDeltas(current: JointSteps, target: JointSteps, tolerance = HOME_STEP_TOLERANCE): JogPlanStep[] {
	const plan: JogPlanStep[] = [];
	for (const sid of HOME_SERVO_IDS) {
		const cur = current[String(sid)];
		const tgt = target[String(sid)];
		if (!Number.isFinite(cur)) throw new Error(`servo ${sid}: no current position reported`);
		if (!Number.isFinite(tgt)) throw new Error(`servo ${sid}: no taught home position`);
		const delta = Math.round(tgt - cur);
		if (Math.abs(delta) > tolerance) plan.push({ sid, delta });
	}
	return plan;
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
	| 'unverified';

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
