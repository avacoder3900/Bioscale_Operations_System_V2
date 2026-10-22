/**
 * ARM-09 — verified poses: the pure half.
 *
 * A move set is a list of ABSOLUTE servo goals along a timeline (never a
 * change from the pose before). Each pose can carry a camera reference — an
 * AprilTag detection and the encoder reading taken with the arm sitting on
 * the pose exactly as a play lands it. A verified run then does, per step,
 * the same two things the home routine does: (1) the servos go to the
 * step's goals, (2) the camera and the encoders are checked against the
 * step's reference, with that step's own tolerances. A step that fails ends
 * the run (torque stays on, the arm holds); no retry, by design for now.
 *
 * Everything here is decision logic with no I/O, unit-tested in
 * verified-poses.test.ts. The I/O half is $lib/server/robot-arm-verified.
 */
import { residuals, HOME_SERVO_IDS, type JointSteps, type Residuals } from './home-calibration';
import type { VisionAssessment } from './apriltags';

// ── tolerances ───────────────────────────────────────────────────────────

/** Per-step tolerances: camera (mm, degrees of spin) and encoders (steps on servos 1–5). */
export interface StepTolerances {
	positionMm: number;
	/** 0 = spin not judged. */
	angleDeg: number;
	steps: number;
}

export const DEFAULT_STEP_TOLERANCES: StepTolerances = { positionMm: 5, angleDeg: 5, steps: 15 };
export const MAX_POSITION_MM = 100;
export const MAX_ANGLE_DEG = 90;
export const MAX_TOLERANCE_STEPS = 300;

/** A step's override on top of its pose's calibration tolerances; absent fields keep the calibration's. */
export interface ToleranceOverride {
	positionMm?: number | null;
	angleDeg?: number | null;
	steps?: number | null;
}

function num(v: unknown): number | null {
	if (v === null || v === undefined || v === '') return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

/**
 * Validate a full tolerance set (a pose calibration's). Out-of-range values
 * throw: the operator typed them and should see why they were refused.
 */
export function cleanStepTolerances(raw: unknown, fallback: StepTolerances = DEFAULT_STEP_TOLERANCES): StepTolerances {
	const o = (raw ?? {}) as Record<string, unknown>;
	const pos = num(o.positionMm) ?? fallback.positionMm;
	const ang = num(o.angleDeg) ?? fallback.angleDeg;
	const steps = num(o.steps) ?? fallback.steps;
	if (pos <= 0 || pos > MAX_POSITION_MM) throw new Error(`Position tolerance must be between 0 and ${MAX_POSITION_MM} mm.`);
	if (ang < 0 || ang > MAX_ANGLE_DEG) throw new Error(`Angle tolerance must be 0–${MAX_ANGLE_DEG}° (0 = not checked).`);
	if (!Number.isInteger(steps) || steps <= 0 || steps > MAX_TOLERANCE_STEPS) throw new Error(`Encoder tolerance must be a whole number of steps, 1–${MAX_TOLERANCE_STEPS}.`);
	return { positionMm: Math.round(pos * 10) / 10, angleDeg: Math.round(ang * 10) / 10, steps };
}

/**
 * A keyframe's override, or null when it sets nothing. Each field is
 * validated like the full set; a field that is blank/absent is dropped.
 */
export function cleanToleranceOverride(raw: unknown): ToleranceOverride | null {
	if (!raw || typeof raw !== 'object') return null;
	const o = raw as Record<string, unknown>;
	const out: ToleranceOverride = {};
	const pos = num(o.positionMm);
	const ang = num(o.angleDeg);
	const steps = num(o.steps);
	if (pos != null) {
		if (pos <= 0 || pos > MAX_POSITION_MM) throw new Error(`Position tolerance must be between 0 and ${MAX_POSITION_MM} mm.`);
		out.positionMm = Math.round(pos * 10) / 10;
	}
	if (ang != null) {
		if (ang < 0 || ang > MAX_ANGLE_DEG) throw new Error(`Angle tolerance must be 0–${MAX_ANGLE_DEG}° (0 = not checked).`);
		out.angleDeg = Math.round(ang * 10) / 10;
	}
	if (steps != null) {
		if (!Number.isInteger(steps) || steps <= 0 || steps > MAX_TOLERANCE_STEPS) throw new Error(`Encoder tolerance must be a whole number of steps, 1–${MAX_TOLERANCE_STEPS}.`);
		out.steps = steps;
	}
	return Object.keys(out).length ? out : null;
}

/** The tolerances a step is judged by: its pose calibration's, with the step's override on top. */
export function effectiveTolerances(base: StepTolerances, override?: ToleranceOverride | null): StepTolerances {
	return {
		positionMm: override?.positionMm ?? base.positionMm,
		angleDeg: override?.angleDeg ?? base.angleDeg,
		steps: override?.steps ?? base.steps
	};
}

// ── which steps are verified ─────────────────────────────────────────────

/**
 * A keyframe's `verify`: true = must be checked (refused at start if the
 * pose has no reference for the camera), false = never checked, absent =
 * checked when the pose has a reference.
 */
export function verifyWanted(verify: boolean | null | undefined, hasReference: boolean): boolean {
	if (verify === true || verify === false) return verify;
	return hasReference;
}

/**
 * The run is played in chunks: consecutive steps up to and including the
 * next verified step. Within a chunk the path is one smooth rendered move
 * (flow easings keep flowing); a verified step is always a stop, because
 * the camera needs the arm still. The last chunk ends at the last step
 * whether or not it is verified.
 */
export interface Chunk {
	/** First keyframe index (inclusive). */
	from: number;
	/** Last keyframe index (inclusive). */
	to: number;
	/** The keyframe checked when this chunk ends; null = the chunk just ends (last steps unverified). */
	verifyStep: number | null;
}

export function planChunks(verified: boolean[]): Chunk[] {
	const out: Chunk[] = [];
	let from = 0;
	verified.forEach((v, i) => {
		const last = i === verified.length - 1;
		if (v || last) {
			out.push({ from, to: i, verifyStep: v ? i : null });
			from = i + 1;
		}
	});
	return out;
}

// ── is the arm on the pose? ──────────────────────────────────────────────

/** "The arm is at these goals": loaded joints sit a few tens of steps short of a goal (same as the pose editor). */
export const AT_POSE_STEPS = 80;

/** Largest |present − goal| over servos 1–5 (the gripper is not judged). */
export function worstOffset(present: number[], goals: number[]): number {
	let worst = 0;
	for (const sid of HOME_SERVO_IDS) {
		const p = present[sid - 1];
		const g = goals[sid - 1];
		const d = Number.isFinite(p) && Number.isFinite(g) ? Math.abs(p - g) : Number.POSITIVE_INFINITY;
		if (d > worst) worst = d;
	}
	return worst;
}

export function nearPose(present: number[], goals: number[], within = AT_POSE_STEPS): boolean {
	return worstOffset(present, goals) <= within;
}

/** Servo-id keyed steps (what the home code compares) from a 6-entry positions list. */
export function jointStepsFrom(positions: number[]): JointSteps {
	const out: JointSteps = {};
	for (const sid of HOME_SERVO_IDS) out[String(sid)] = positions[sid - 1];
	return out;
}

// ── the per-step verdict ─────────────────────────────────────────────────

export type StepVerdict =
	| 'ok'
	| 'position_off'
	| 'tags_off'
	| 'position_off_and_tags_off'
	| 'camera_moved'
	/** A side could not be judged (servos unreadable, camera down, no arm tag tracked). Never a pass. */
	| 'unverified';

export interface StepAssessment {
	verdict: StepVerdict;
	passed: boolean;
	/** Encoders within the step tolerance (null = not read). */
	landed: boolean | null;
	/** Every tag where the reference has it, with an arm tag tracked (null = no usable vision). */
	tagsOk: boolean | null;
	residualMax: number | null;
}

/**
 * Combine encoders and tags, exactly as the home verdict does: a pass needs
 * BOTH sides read and agreeing. A missing side is `unverified` and fails the
 * run — a step the camera could not see is not a verified step.
 */
export function assessStep(r: Residuals | null, vision: VisionAssessment | null): StepAssessment {
	const landed = r ? r.off.length === 0 && Number.isFinite(r.max) : null;
	const armTracked = !!vision?.markers?.some((m) => m.role === 'arm' && m.status !== 'missing');
	const tagsOk = !vision || vision.verdict === 'no_markers' ? null : vision.verdict === 'off' ? false : vision.verdict === 'ok' && armTracked ? true : null;
	let verdict: StepVerdict;
	if (vision?.verdict === 'camera_moved') verdict = 'camera_moved';
	else if (landed === false && tagsOk === false) verdict = 'position_off_and_tags_off';
	else if (landed === false) verdict = 'position_off';
	else if (tagsOk === false) verdict = 'tags_off';
	else if (landed === true && tagsOk === true) verdict = 'ok';
	else verdict = 'unverified';
	return { verdict, passed: verdict === 'ok', landed, tagsOk, residualMax: r ? r.max : null };
}

/** Encoder residuals against a step's reference, judged with the step's own tolerance. */
export function stepResiduals(present: JointSteps, reference: JointSteps, tol: StepTolerances): Residuals {
	return residuals(present, reference, tol.steps);
}

/** One sentence per verdict, naming the step and the numbers that decided it. */
export function describeStep(stepName: string, a: StepAssessment, r: Residuals | null, visionText: string | null, tol: StepTolerances): string {
	const enc = r ? `encoders within ${r.max} step(s) of the reference (limit ${tol.steps})` : 'encoders not read';
	switch (a.verdict) {
		case 'ok':
			return `"${stepName}" verified: ${enc}; ${visionText ?? 'tags agree'}`;
		case 'position_off':
			return `"${stepName}" did not land: joint(s) ${r?.off.join(', ')} are ${r?.max} step(s) from the reference (limit ${tol.steps}). ${visionText ?? ''}`.trim();
		case 'tags_off':
			return `"${stepName}": encoders say it landed (${enc}) but the camera disagrees — ${visionText ?? 'the tags are off'}`;
		case 'position_off_and_tags_off':
			return `"${stepName}" is off on both counts: joint(s) ${r?.off.join(', ')} ${r?.max} step(s) from the reference, and ${visionText ?? 'the tags are off'}`;
		case 'camera_moved':
			return `"${stepName}": the camera itself seems to have moved — ${visionText ?? ''} Recalibrate the poses before trusting a run.`.trim();
		case 'unverified': {
			const missing: string[] = [];
			if (a.landed === null) missing.push('the servos could not be read');
			if (a.tagsOk === null) missing.push(visionText ? `no arm tag was tracked (${visionText})` : 'the camera check did not run');
			return `"${stepName}" could not be verified: ${missing.join(' and ')}. A step needs both the servos and the camera.`;
		}
	}
}

// ── run bookkeeping (shared by the server and the page) ──────────────────

export type RunStatus = 'running' | 'passed' | 'failed' | 'stopped' | 'error';
export type RunPhase = 'play' | 'playing' | 'verify' | 'done';

export interface RunCursor {
	chunk: number;
	phase: RunPhase;
}

/** Where the cursor goes once a chunk is finished (and, if verified, passed). */
export function advanceCursor(cursor: RunCursor, chunkCount: number): RunCursor {
	const next = cursor.chunk + 1;
	return next >= chunkCount ? { chunk: cursor.chunk, phase: 'done' } : { chunk: next, phase: 'play' };
}

/**
 * Ideas for what a run could do after a failed check — listed, NOT built.
 * The operator asked for "error and stop" first; these are the candidates
 * for later, in rough order of how little they assume.
 */
export const AFTER_FAILURE_IDEAS: readonly string[] = [
	'Re-detect once after a short extra settle (the arm may still have been swaying).',
	'Re-send the same goals and check again (a servo that stalled briefly often lands on the second try).',
	'Back off to the previous verified pose and replay the chunk once.',
	'Run the home routine, then resume from the failed step.',
	'Pause with the live camera view and let the operator nudge the sliders, then continue.',
	'Learn a per-pose trim from the encoder residual (like the droop trim) and retry once.'
];
