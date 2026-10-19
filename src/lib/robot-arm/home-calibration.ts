/**
 * Robot arm — camera-verified HOME calibration (pure logic, no I/O).
 *
 * The problem this solves: a task can end with the arm somewhere other than
 * its zero/home pose (a stalled servo, a stopped replay, a bump). "Home" on the
 * Pi is whatever the servos were taught, with nothing to prove the arm is
 * physically there. This module pairs the taught joint positions with what the
 * arm CAMERA saw at the moment of calibration, so a return-to-home can be
 * checked against the picture, not only against the encoders.
 *
 * Everything here is deterministic and unit-tested; the server module
 * (src/lib/server/robot-arm-home.ts) does the Pi calls, the image decode and
 * the persistence.
 */

/** The positioning chain. Servo 6 (gripper) does not take part in home. */
export const HOME_SERVO_IDS = [1, 2, 3, 4, 5] as const;

/**
 * A joint within this many encoder steps of its taught value counts as home.
 * STS3215: 4096 steps / rev, so 12 steps ≈ 1.05°. Tight enough to catch a
 * skipped tooth, loose enough for the servo's own settle jitter.
 */
export const HOME_STEP_TOLERANCE = 12;

/**
 * Camera agreement below this is reported as a mismatch. Pearson correlation
 * of two 32×24 greyscale thumbnails: same scene from a fixed camera scores
 * 0.95+; the arm a few cm off drops it well below 0.85 because the arm fills
 * a good part of the frame.
 */
export const HOME_MATCH_THRESHOLD = 0.85;

/** Signature thumbnail size (greyscale, row-major). Small on purpose: it lives in Mongo. */
export const SIGNATURE_WIDTH = 32;
export const SIGNATURE_HEIGHT = 24;

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

/**
 * Greyscale bytes → signature in [0,1]. Length must be width×height; the
 * caller is responsible for having resized to SIGNATURE_WIDTH × SIGNATURE_HEIGHT.
 */
export function signatureFromGrey(grey: ArrayLike<number>, width = SIGNATURE_WIDTH, height = SIGNATURE_HEIGHT): number[] {
	if (grey.length !== width * height) throw new Error(`signature expects ${width * height} greyscale bytes, got ${grey.length}`);
	const out = new Array<number>(grey.length);
	for (let i = 0; i < grey.length; i++) out[i] = grey[i] / 255;
	return out;
}

/**
 * How alike two signatures are: Pearson correlation clamped to [0,1].
 * Mean/variance normalisation makes it blind to overall brightness (lab
 * lights, time of day) and to the camera's auto-exposure, which is exactly
 * the noise a fixed-camera "is the arm where it was" test must ignore.
 * A flat image (no variance) cannot be compared and scores 0.
 */
export function imageSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
	if (a.length !== b.length || a.length === 0) return 0;
	const n = a.length;
	let ma = 0;
	let mb = 0;
	for (let i = 0; i < n; i++) {
		ma += a[i];
		mb += b[i];
	}
	ma /= n;
	mb /= n;
	let num = 0;
	let da = 0;
	let db = 0;
	for (let i = 0; i < n; i++) {
		const x = a[i] - ma;
		const y = b[i] - mb;
		num += x * y;
		da += x * x;
		db += y * y;
	}
	if (da === 0 || db === 0) return 0;
	const r = num / Math.sqrt(da * db);
	return Math.max(0, Math.min(1, r));
}

export type HomeVerdict = 'home' | 'position_off' | 'camera_mismatch' | 'position_off_and_camera_mismatch';

export interface HomeAssessment {
	verdict: HomeVerdict;
	/** Every home joint within tolerance of its taught value. */
	landed: boolean;
	/** Camera picture agrees with the calibration picture (null = no picture to compare). */
	cameraMatched: boolean | null;
	similarity: number | null;
	residualMax: number;
}

/** Combine encoder residuals and camera agreement into one operator-facing verdict. */
export function assessHome(
	r: Residuals,
	similarity: number | null,
	o: { tolerance?: number; threshold?: number } = {}
): HomeAssessment {
	const tolerance = o.tolerance ?? HOME_STEP_TOLERANCE;
	const threshold = o.threshold ?? HOME_MATCH_THRESHOLD;
	// Re-derive "off" from the per-joint numbers so an overridden tolerance applies here too.
	const landed = Object.values(r.perJoint).every((v) => !Number.isNaN(v) && Math.abs(v) <= tolerance);
	const cameraMatched = similarity == null ? null : similarity >= threshold;
	const verdict: HomeVerdict =
		landed && cameraMatched !== false
			? 'home'
			: !landed && cameraMatched === false
				? 'position_off_and_camera_mismatch'
				: !landed
					? 'position_off'
					: 'camera_mismatch';
	return { verdict, landed, cameraMatched, similarity, residualMax: r.max };
}

/** Operator-facing sentence for a verdict. */
export function describeVerdict(a: HomeAssessment): string {
	const sim = a.similarity == null ? '' : ` (camera match ${(a.similarity * 100).toFixed(0)}%)`;
	switch (a.verdict) {
		case 'home':
			return `Arm is at the calibrated home — encoders within ${a.residualMax} steps${sim}.`;
		case 'position_off':
			return `Encoders are ${a.residualMax} steps from home — the move did not land. Check for a stalled joint or torque off.`;
		case 'camera_mismatch':
			return `Encoders say home but the camera disagrees${sim}. The camera or the arm's mount may have moved — recalibrate if the setup changed.`;
		case 'position_off_and_camera_mismatch':
			return `Not at home: encoders ${a.residualMax} steps off and the camera disagrees${sim}.`;
	}
}
