/**
 * Robot arm — verified poses (ARM-09): the I/O half.
 *
 * Two things, both built on the home routine's pieces (ARM-05):
 *
 *  1. A pose's CAMERA REFERENCE. With the arm sitting on the pose exactly as
 *     a play lands it (Go to pose first), one AprilTag detection plus the
 *     encoder reading on each side of it are stored per pose per camera
 *     (robot_arm_pose_calibrations). "Check now" re-detects without moving
 *     and shows the residuals, so the tolerances can be set above the real
 *     jitter AFTER the photo is taken. A pose's goals being edited later
 *     makes its reference stale (the goals are stored with it).
 *
 *  2. A VERIFIED RUN. A move set / sequence / pose is played in chunks that
 *     end at every verified step; after each chunk the Pi is idle, the
 *     encoders and the camera are checked against that step's reference
 *     with that step's tolerances. Pass → next chunk. Fail → the run stops
 *     there with torque on (the arm holds), the step and the reason are
 *     recorded, and nothing retries (operator spec, 2026-10-22; candidate
 *     follow-ups are listed in AFTER_FAILURE_IDEAS and ARM-09 §6).
 *
 * The browser drives a run one request at a time (start → next → next …;
 * `playback` polls between), so each request stays well inside Vercel's
 * 30 s: a chunk start is a few Pi calls, a check is two servo reads and one
 * detection. The decisions are in $lib/robot-arm/verified-poses (tested).
 *
 * Pi calls: GET /sessions/active, GET /servos, POST /torque,
 *   POST /cameras/{name}/apriltags/detect, and (via writeAndPlay)
 *   POST /recordings/restore + POST /replay/start. No new Pi route.
 */
import { connectDB, AuditLog, generateId } from '$lib/server/db';
import { RobotArmPose, RobotArmPoseCalibration, RobotArmVerifiedRun } from '$lib/server/db/models';
import { robotArm } from './robot-arm-client';
import { detectTags, listTags, readServos, thumbnail, CALIBRATION_FRAMES, CHECK_FRAMES } from './robot-arm-vision';
import {
	AnimateError,
	poseSummary,
	readArm,
	requireCool,
	requireIdle,
	resolveKeyframes,
	resolveMoveSet,
	resolveSequence,
	torqueBackOn,
	writeAndPlay,
	type ArmNow,
	type PlayKind,
	type PoseSummary
} from './robot-arm-animation';
import { assessTags, describeVision, DEFAULT_TOLERANCES, type CalibratedTag, type VisionAssessment } from '$lib/robot-arm/apriltags';
import { unsteadyJoints, HOME_SERVO_IDS, type JointSteps, type Residuals, type ServoReading } from '$lib/robot-arm/home-calibration';
import { friendlyName, DEFAULT_RATE_HZ, type ResolvedKeyframe } from '$lib/robot-arm/animation';
import {
	advanceCursor,
	assessStep,
	cleanStepTolerances,
	describeStep,
	effectiveTolerances,
	jointStepsFrom,
	nearPose,
	planChunks,
	stepResiduals,
	verifyWanted,
	worstOffset,
	AT_POSE_STEPS,
	DEFAULT_STEP_TOLERANCES,
	type Chunk,
	type RunCursor,
	type RunStatus,
	type StepAssessment,
	type StepTolerances,
	type ToleranceOverride
} from '$lib/robot-arm/verified-poses';

type User = { _id: string; username: string };

/** Let the arm stop swaying before the check reads it. */
const SETTLE_MS = 800;
/** A chunk whose replay the Pi still reports this long after it should have ended is given up on. */
const PLAY_GRACE_S = 20;
/** Results older than the latest come back without their snapshot (the page polls every second). */
const LAST_RESULTS_WITH_SNAPSHOT = 1;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const opRef = (u: User) => ({ _id: u._id, username: u.username });

async function audit(user: User, action: string, tableName: string, recordId: string, newData: Record<string, unknown>) {
	await AuditLog.create({ _id: generateId(), tableName, recordId, action, newData: { ...newData, userId: user._id }, changedBy: user.username, changedAt: new Date() });
}

function numOrNull(v: unknown): number | null {
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function mapToSteps(raw: unknown): JointSteps | null {
	const obj = raw instanceof Map ? Object.fromEntries(raw) : raw;
	if (!obj || typeof obj !== 'object' || !Object.keys(obj).length) return null;
	const out: JointSteps = {};
	for (const [k, v] of Object.entries(obj as Record<string, unknown>)) out[String(k)] = Number(v);
	return out;
}

// ── pose references ──────────────────────────────────────────────────────

export interface PoseCheckRecord {
	at: string;
	by: { username?: string } | null;
	kind: string;
	verdict: string;
	visionVerdict: string | null;
	residualMax: number | null;
	residuals: Record<string, number> | null;
	cameraShiftMm: number | null;
	markers: { markerId: string; tagId: number; name: string; status: string; offMm: number | null; offDeg: number | null; offTiltDeg: number | null; ambiguous: boolean }[];
	runId: string | null;
}

export interface PoseCalibrationSummary {
	_id: string;
	poseId: string;
	poseName: string;
	cameraName: string;
	status: 'active' | 'superseded';
	capturedAt: string;
	capturedBy: { username?: string } | null;
	note: string | null;
	goals: number[];
	/** The pose's goals have changed since this reference was taken. */
	stale: boolean;
	frameWidth: number;
	frameHeight: number;
	intrinsicsSource: string | null;
	thumbnailDataUrl: string | null;
	tags: CalibratedTag[];
	armTags: number;
	fixedTags: number;
	tolerances: StepTolerances;
	jointSteps: JointSteps;
	servos: ServoReading[];
	captureDriftSteps: number | null;
	lastCheck: PoseCheckRecord | null;
}

function tagsOf(doc: any): CalibratedTag[] {
	return (doc.tags ?? []).map(
		(t: any): CalibratedTag => ({
			markerId: t.markerId,
			tagId: t.tagId,
			name: t.name,
			group: t.group ?? null,
			role: t.role === 'fixed' ? 'fixed' : 'arm',
			sizeMm: t.sizeMm,
			center: [t.center[0], t.center[1]],
			corners: (t.corners ?? []).map((c: number[]) => [c[0], c[1]] as [number, number]),
			pose:
				t.pose?.t?.length === 3 && t.pose?.R?.length === 9
					? {
							t: [t.pose.t[0], t.pose.t[1], t.pose.t[2]],
							R: [...t.pose.R],
							reprojPx: t.pose.reprojPx ?? null,
							alt: t.pose.alt?.t?.length === 3 && t.pose.alt?.R?.length === 9 ? { t: [t.pose.alt.t[0], t.pose.alt.t[1], t.pose.alt.t[2]], R: [...t.pose.alt.R], reprojPx: t.pose.alt.reprojPx ?? null } : null
						}
					: null,
			depthMm: t.depthMm ?? null
		})
	);
}

function tolerancesOf(doc: any): StepTolerances {
	return {
		positionMm: numOrNull(doc?.tolerances?.positionMm) ?? DEFAULT_STEP_TOLERANCES.positionMm,
		angleDeg: numOrNull(doc?.tolerances?.angleDeg) ?? DEFAULT_STEP_TOLERANCES.angleDeg,
		steps: numOrNull(doc?.tolerances?.steps) ?? DEFAULT_STEP_TOLERANCES.steps
	};
}

function checkOf(c: any): PoseCheckRecord | null {
	if (!c?.at) return null;
	return {
		at: new Date(c.at).toISOString(),
		by: c.by ?? null,
		kind: String(c.kind ?? ''),
		verdict: String(c.verdict ?? ''),
		visionVerdict: c.visionVerdict ?? null,
		residualMax: numOrNull(c.residualMax),
		residuals: mapToSteps(c.residuals),
		cameraShiftMm: numOrNull(c.cameraShiftMm),
		markers: (c.markers ?? []).map((m: any) => ({ markerId: m.markerId, tagId: m.tagId, name: m.name, status: m.status, offMm: numOrNull(m.offMm), offDeg: numOrNull(m.offDeg), offTiltDeg: numOrNull(m.offTiltDeg), ambiguous: m.ambiguous === true })),
		runId: c.runId ?? null
	};
}

function poseCalibrationSummary(doc: any, o: { withThumb: boolean; currentGoals?: number[] | null }): PoseCalibrationSummary {
	const goals = (doc.goals ?? []).map(Number);
	const tags = tagsOf(doc);
	const cur = o.currentGoals ?? null;
	return {
		_id: String(doc._id),
		poseId: String(doc.poseId),
		poseName: doc.poseName,
		cameraName: doc.cameraName,
		status: doc.status,
		capturedAt: new Date(doc.capturedAt).toISOString(),
		capturedBy: doc.capturedBy ?? null,
		note: doc.note ?? null,
		goals,
		stale: !!cur && HOME_SERVO_IDS.some((sid) => cur[sid - 1] !== goals[sid - 1]),
		frameWidth: doc.frameWidth,
		frameHeight: doc.frameHeight,
		intrinsicsSource: doc.intrinsics?.source ?? null,
		thumbnailDataUrl: o.withThumb ? (doc.thumbnailDataUrl ?? null) : null,
		tags,
		armTags: tags.filter((t) => t.role === 'arm').length,
		fixedTags: tags.filter((t) => t.role === 'fixed').length,
		tolerances: tolerancesOf(doc),
		jointSteps: mapToSteps(doc.jointSteps) ?? {},
		servos: (doc.servos ?? []).map((s: any): ServoReading => ({ sid: Number(s.sid), steps: Number(s.steps), load: numOrNull(s.load), temperatureC: numOrNull(s.temperatureC), voltage: numOrNull(s.voltage), torque: typeof s.torque === 'boolean' ? s.torque : null })),
		captureDriftSteps: numOrNull(doc.captureDriftSteps),
		lastCheck: checkOf(doc.lastCheck)
	};
}

/**
 * Active references, one per pose per camera, without thumbnails (the pages
 * load these for every pose; `getPoseCalibration` fetches one with its
 * picture). `stale` is judged against the poses' current goals.
 */
export async function listPoseCalibrations(o: { poseIds?: string[]; cameraName?: string | null } = {}): Promise<PoseCalibrationSummary[]> {
	await connectDB();
	const q: Record<string, unknown> = { status: 'active' };
	if (o.poseIds) q.poseId = { $in: o.poseIds };
	if (o.cameraName) q.cameraName = o.cameraName;
	const docs = (await RobotArmPoseCalibration.find(q).select('-thumbnailDataUrl').sort({ capturedAt: -1 }).lean()) as any[];
	const poses = (await RobotArmPose.find({ _id: { $in: [...new Set(docs.map((d) => String(d.poseId)))] } }).select('_id positions').lean()) as any[];
	const goalsById = new Map(poses.map((p) => [String(p._id), (p.positions ?? []).map(Number)]));
	return docs.map((d) => poseCalibrationSummary(d, { withThumb: false, currentGoals: goalsById.get(String(d.poseId)) ?? null }));
}

export async function getPoseCalibration(id: string): Promise<PoseCalibrationSummary | null> {
	await connectDB();
	const doc = (await RobotArmPoseCalibration.findById(id).lean()) as any;
	if (!doc) return null;
	const pose = (await RobotArmPose.findById(doc.poseId).select('positions').lean()) as any;
	return poseCalibrationSummary(doc, { withThumb: true, currentGoals: pose ? (pose.positions ?? []).map(Number) : null });
}

async function activeReference(poseId: string, cameraName: string): Promise<any | null> {
	return (await RobotArmPoseCalibration.findOne({ poseId, cameraName, status: 'active' }).sort({ capturedAt: -1 }).lean()) as any;
}

/** The arm (torque on, cool enough) and its position; the common gate before anything reads the bus. */
async function armNowIdle(): Promise<ArmNow> {
	await requireIdle();
	const now = await readArm();
	if (now.torqueOn === false) throw new AnimateError('Torque is off — press Torque on first.', 409);
	return now;
}

/**
 * Take (or retake) a pose's camera reference. The arm must already be ON
 * the pose, landed by a play (Go to pose) — the reference must describe
 * what a run lands, not what the sliders were nudged to.
 *
 *   1. Servos read (steps, load, temperature).
 *   2. One AprilTag detection with the frame, averaged over CALIBRATION_FRAMES
 *      like the home calibration (single frames lose the small arm tags).
 *   3. Servos read again; a joint that moved more than the pose tolerance
 *      between the reads means the frame and the encoders disagree — refused.
 *
 * At least one arm tag must be in view; fixed tags are recommended (they let
 * a camera bump be undone instead of failing every step). The previous
 * active reference for this pose + camera is superseded, never edited.
 */
export async function calibratePose(
	user: User,
	o: { poseId: string; cameraName: string; note?: string | null }
): Promise<{ summary: PoseCalibrationSummary; warnings: string[] }> {
	await connectDB();
	if (!o.cameraName) throw new AnimateError('No camera selected.');
	const poseDoc = (await RobotArmPose.findById(o.poseId).select('-lastPlay').lean()) as any;
	if (!poseDoc) throw new AnimateError('Pose not found.', 404);
	const pose = poseSummary(poseDoc);
	const registry = (await listTags()).filter((t) => !t.archived);
	if (!registry.length) throw new AnimateError('Register the AprilTags on the Vision tab first — none are in the registry.');

	const now = await armNowIdle();
	const off = worstOffset(now.positions, pose.positions);
	if (!nearPose(now.positions, pose.positions)) {
		throw new AnimateError(`The arm is not on "${friendlyName(pose.name)}" (a joint is ${Math.round(off)} steps from it; limit ${AT_POSE_STEPS}). Go to pose first, then capture.`, 409);
	}

	const servoErr = (e: unknown) => new AnimateError(`${e instanceof Error ? e.message : String(e)} — a reference needs the servos as well as the camera`, 502);
	const before = await readServos().catch((e) => {
		throw servoErr(e);
	});
	const det = await detectTags(o.cameraName, { includeFrame: true, registry, frames: CALIBRATION_FRAMES });
	if (!det.available) throw new AnimateError(det.reason ?? 'the Pi could not detect tags', 502);
	if (!det.frame) throw new AnimateError('the Pi did not return the frame it detected on', 502);
	const servos = await readServos().catch((e) => {
		throw servoErr(e);
	});
	const unsteady = unsteadyJoints(before.steps, servos.steps, DEFAULT_STEP_TOLERANCES.steps);
	if (unsteady.length) {
		throw new AnimateError(`the arm moved while the camera was capturing (joint ${unsteady.map((sid) => `${sid}: ${before.steps[String(sid)]} → ${servos.steps[String(sid)]}`).join(', ')} steps) — let it settle and capture again`, 409);
	}
	const captureDriftSteps = Math.max(0, ...HOME_SERVO_IDS.map((sid) => Math.abs(servos.steps[String(sid)] - before.steps[String(sid)])));

	const warnings: string[] = [];
	const byTagId = new Map(registry.map((t) => [t.tagId, t]));
	const tags: CalibratedTag[] = det.tags
		.filter((d) => byTagId.has(d.id))
		.map((d) => {
			const reg = byTagId.get(d.id)!;
			return { markerId: reg._id, tagId: d.id, name: reg.name, group: reg.group, role: reg.role, sizeMm: reg.sizeMm, center: d.center, corners: d.corners, pose: d.pose, depthMm: d.depthMm };
		});
	if (!tags.length) throw new AnimateError(`none of the ${registry.length} registered tag(s) is visible at this pose — check the camera view and lighting`, 409);
	if (!tags.some((t) => t.role === 'arm')) {
		const seen = tags.map((t) => `${t.name} #${t.tagId}`).join(', ');
		throw new AnimateError(`no arm tag is in view at this pose (seen over ${det.framesUsed} frame(s): ${seen}, all fixed) — the camera would say nothing about the arm here. Press Detect tags to see what the camera finds, bring an arm tag into view, or turn verification off for this step.`, 409);
	}
	const unregistered = det.tags.filter((d) => !byTagId.has(d.id)).map((d) => d.id);
	if (unregistered.length) warnings.push(`Seen but not registered, so not in the reference: tag ${unregistered.join(', ')}.`);
	if (!tags.some((t) => t.role === 'fixed')) warnings.push('No fixed tag in view at this pose — a bumped camera cannot be told apart from the arm being off. A tag on the deck in this view would help.');
	const noPose = tags.filter((t) => !t.pose);
	if (noPose.length) warnings.push(`No 3-D pose for ${noPose.map((t) => t.name).join(', ')} — checked on the picture only.`);
	if (det.intrinsics?.source === 'nominal') warnings.push('The Pi used nominal camera intrinsics — millimetres are approximate.');
	if (off > AT_POSE_STEPS / 2) warnings.push(`The arm sits ${Math.round(off)} steps from the pose's goals under load (normal for a loaded joint); the reference records where it actually rests.`);

	const jointSteps: JointSteps = {};
	for (const sid of HOME_SERVO_IDS) jointSteps[String(sid)] = servos.steps[String(sid)];

	let referenceImageKey: string | null = null;
	try {
		const { uploadViaWorker } = await import('./services/r2');
		referenceImageKey = `robot-arm/pose-reference/${o.cameraName}/${o.poseId}/${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`;
		await uploadViaWorker(det.frame, referenceImageKey, 'image/jpeg');
	} catch (e) {
		console.warn('[arm-verified] reference frame not uploaded to R2:', e instanceof Error ? e.message : e);
		referenceImageKey = null;
	}

	const previous = (await RobotArmPoseCalibration.find({ poseId: o.poseId, cameraName: o.cameraName, status: 'active' }).select('_id tolerances').lean()) as any[];
	// Tolerances are about the pose, not the picture: carry them across a retake.
	const tolerances = previous[0] ? tolerancesOf(previous[0]) : { ...DEFAULT_STEP_TOLERANCES };
	const _id = generateId();
	const at = new Date();
	await RobotArmPoseCalibration.create({
		_id,
		poseId: o.poseId,
		poseName: pose.name,
		cameraName: o.cameraName,
		status: 'active',
		capturedAt: at,
		capturedBy: opRef(user),
		note: o.note?.trim() ? o.note.trim().slice(0, 500) : null,
		goals: pose.positions,
		poseBasis: pose.basis,
		frameWidth: det.width,
		frameHeight: det.height,
		intrinsics: det.intrinsics,
		detector: det.detector,
		thumbnailDataUrl: await thumbnail(det.frame),
		referenceImageKey,
		tags,
		tolerances,
		jointSteps,
		servos: servos.readings,
		servoSource: servos.source,
		captureDriftSteps
	});
	if (previous.length) await RobotArmPoseCalibration.updateMany({ _id: { $in: previous.map((p) => p._id) } }, { $set: { status: 'superseded', supersededAt: at, supersededBy: _id } });
	await audit(user, 'robot_arm.verified.pose_reference', 'robot_arm_pose_calibrations', _id, {
		poseId: o.poseId,
		poseName: pose.name,
		cameraName: o.cameraName,
		goals: pose.positions,
		tags: tags.map((t) => ({ tagId: t.tagId, name: t.name, role: t.role, t: t.pose?.t ?? null })),
		jointSteps,
		tolerances,
		captureDriftSteps,
		supersedes: previous.map((p) => p._id),
		referenceImageKey,
		warnings
	});
	const summary = (await getPoseCalibration(_id))!;
	return { summary, warnings };
}

export async function setPoseTolerances(user: User, calibrationId: string, raw: unknown): Promise<StepTolerances> {
	await connectDB();
	const doc = (await RobotArmPoseCalibration.findOne({ _id: calibrationId, status: 'active' }).select('tolerances poseName').lean()) as any;
	if (!doc) throw new AnimateError('That reference is no longer active — reload the page.', 404);
	let after: StepTolerances;
	try {
		after = cleanStepTolerances(raw, tolerancesOf(doc));
	} catch (e) {
		throw new AnimateError((e as Error).message);
	}
	await RobotArmPoseCalibration.updateOne({ _id: calibrationId }, { $set: { tolerances: after } });
	await audit(user, 'robot_arm.verified.pose_tolerances', 'robot_arm_pose_calibrations', calibrationId, { poseName: doc.poseName, before: tolerancesOf(doc), after });
	return after;
}

export async function retirePoseCalibration(user: User, calibrationId: string): Promise<boolean> {
	await connectDB();
	const res = await RobotArmPoseCalibration.updateOne({ _id: calibrationId, status: 'active' }, { $set: { status: 'superseded', supersededAt: new Date(), supersededBy: null } });
	if (res.modifiedCount) await audit(user, 'robot_arm.verified.pose_reference_retire', 'robot_arm_pose_calibrations', calibrationId, {});
	return res.modifiedCount > 0;
}

// ── one check against a reference ────────────────────────────────────────

interface CheckOutcome {
	assessment: StepAssessment;
	residuals: Residuals | null;
	vision: VisionAssessment | null;
	snapshotDataUrl: string | null;
	message: string;
	warnings: string[];
	elapsedMs: number;
}

/**
 * Read the encoders and detect the tags, compare both with `ref` under
 * `tol`. No motion. Shared by "Check now" and the verified run.
 */
async function checkAgainst(ref: any, stepName: string, tol: StepTolerances): Promise<CheckOutcome> {
	const t0 = Date.now();
	const warnings: string[] = [];
	const target = mapToSteps(ref.jointSteps);
	let residuals: Residuals | null = null;
	try {
		const now = await readServos();
		if (target) residuals = stepResiduals(now.steps, target, tol);
		else warnings.push('This reference has no encoder reading — retake it.');
	} catch (e) {
		warnings.push(`Servos not read: ${e instanceof Error ? e.message : String(e)}`);
	}
	let vision: VisionAssessment | null = null;
	let snapshotDataUrl: string | null = null;
	const tags = tagsOf(ref);
	if (!tags.length) warnings.push('This reference has no tags.');
	else {
		try {
			const det = await detectTags(ref.cameraName, { includeFrame: true, frames: CHECK_FRAMES });
			if (!det.available) warnings.push(`Camera check skipped: ${det.reason ?? 'no detection'}`);
			else {
				if (det.width !== ref.frameWidth || det.height !== ref.frameHeight) warnings.push(`The stream is ${det.width}×${det.height} but the reference was ${ref.frameWidth}×${ref.frameHeight} — retake the reference at the new resolution.`);
				vision = assessTags(tags, det.tags, { positionMm: tol.positionMm, angleDeg: tol.angleDeg, pixel: DEFAULT_TOLERANCES.pixel });
				snapshotDataUrl = det.frame ? await thumbnail(det.frame) : null;
			}
		} catch (e) {
			warnings.push(`Camera check skipped: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	const assessment = assessStep(residuals, vision);
	const message = describeStep(stepName, assessment, residuals, vision ? describeVision(vision) : null, tol);
	return { assessment, residuals, vision, snapshotDataUrl, message, warnings, elapsedMs: Date.now() - t0 };
}

function markersOf(vision: VisionAssessment | null) {
	return (vision?.markers ?? []).map((m) => ({ markerId: m.markerId, tagId: m.tagId, name: m.name, role: m.role, status: m.status, offMm: m.offMm, offDeg: m.offDeg, offTiltDeg: m.offTiltDeg, ambiguous: m.ambiguous }));
}

async function recordPoseCheck(ref: any, user: User, kind: 'check' | 'run', c: CheckOutcome, runId: string | null) {
	const shift = c.vision?.cameraShift;
	await RobotArmPoseCalibration.updateOne(
		{ _id: ref._id },
		{
			$set: {
				lastCheck: {
					at: new Date(),
					by: opRef(user),
					kind,
					verdict: c.assessment.verdict,
					visionVerdict: c.vision?.verdict ?? null,
					residualMax: c.assessment.residualMax != null && Number.isFinite(c.assessment.residualMax) ? c.assessment.residualMax : null,
					residuals: c.residuals?.perJoint ?? undefined,
					cameraShiftMm: shift?.compensated ? shift.mm : null,
					markers: markersOf(c.vision),
					runId
				}
			}
		}
	);
}

export interface PoseCheckResult {
	calibrationId: string;
	poseId: string;
	cameraName: string;
	verdict: string;
	passed: boolean;
	residuals: Record<string, number> | null;
	residualMax: number | null;
	tolerances: StepTolerances;
	markers: ReturnType<typeof markersOf>;
	cameraShiftMm: number | null;
	message: string;
	snapshotDataUrl: string | null;
	warnings: string[];
}

/**
 * No motion: where is the arm and where are the tags, against this pose's
 * reference? Run it with the arm sitting on the pose to see the real
 * jitter, then set the tolerances above it.
 */
export async function checkPose(user: User, o: { poseId: string; cameraName: string }): Promise<PoseCheckResult> {
	await connectDB();
	const ref = await activeReference(o.poseId, o.cameraName);
	if (!ref) throw new AnimateError('This pose has no camera reference for that camera yet — Go to pose, then Capture reference.', 404);
	await requireIdle();
	const tol = tolerancesOf(ref);
	const c = await checkAgainst(ref, friendlyName(ref.poseName), tol);
	await recordPoseCheck(ref, user, 'check', c, null);
	await audit(user, 'robot_arm.verified.pose_check', 'robot_arm_pose_calibrations', String(ref._id), {
		poseId: o.poseId,
		verdict: c.assessment.verdict,
		residuals: c.residuals?.perJoint ?? null,
		visionVerdict: c.vision?.verdict ?? null,
		markers: markersOf(c.vision),
		warnings: c.warnings
	});
	return {
		calibrationId: String(ref._id),
		poseId: o.poseId,
		cameraName: o.cameraName,
		verdict: c.assessment.verdict,
		passed: c.assessment.passed,
		residuals: c.residuals?.perJoint ?? null,
		residualMax: c.assessment.residualMax,
		tolerances: tol,
		markers: markersOf(c.vision),
		cameraShiftMm: c.vision?.cameraShift?.compensated ? c.vision.cameraShift.mm : null,
		message: c.message,
		snapshotDataUrl: c.snapshotDataUrl,
		warnings: c.warnings
	};
}

// ── verified runs ────────────────────────────────────────────────────────

export interface RunStepSummary {
	index: number;
	poseId: string;
	name: string;
	positions: number[];
	verify: boolean;
	calibrationId: string | null;
	tolerances: StepTolerances | null;
}

export interface RunResultSummary {
	step: number;
	at: string;
	verdict: string;
	passed: boolean;
	residuals: Record<string, number> | null;
	residualMax: number | null;
	visionVerdict: string | null;
	cameraShiftMm: number | null;
	markers: ReturnType<typeof markersOf>;
	tolerances: StepTolerances | null;
	snapshotDataUrl: string | null;
	message: string;
	warnings: string[];
	elapsedMs: number | null;
}

export interface VerifiedRunSummary {
	_id: string;
	kind: PlayKind;
	sourceId: string;
	name: string;
	cameraName: string;
	status: RunStatus;
	startedAt: string;
	startedBy: { username?: string } | null;
	endedAt: string | null;
	steps: RunStepSummary[];
	chunks: Chunk[];
	cursor: RunCursor;
	/** The chunk being played right now, with when it started and how long the path is. */
	playing: { chunk: number; runId: string; startedAt: string; durationS: number } | null;
	results: RunResultSummary[];
	failure: { step: number; verdict: string; message: string } | null;
	warnings: string[];
	error: string | null;
	verifiedSteps: number;
	passedSteps: number;
}

function runSummary(doc: any, o: { snapshots: 'latest' | 'all' | 'none' } = { snapshots: 'latest' }): VerifiedRunSummary {
	const results: any[] = doc.results ?? [];
	const plays: any[] = doc.plays ?? [];
	const live = plays.find((p) => !p.endedAt && p.chunk === doc.cursor?.chunk) ?? null;
	const steps: RunStepSummary[] = (doc.steps ?? []).map((s: any) => ({
		index: s.index,
		poseId: s.poseId,
		name: s.name,
		positions: (s.positions ?? []).map(Number),
		verify: !!s.verify,
		calibrationId: s.calibrationId ?? null,
		tolerances: s.tolerances ? tolerancesOf({ tolerances: s.tolerances }) : null
	}));
	return {
		_id: String(doc._id),
		kind: doc.kind,
		sourceId: doc.sourceId,
		name: doc.name,
		cameraName: doc.cameraName,
		status: doc.status,
		startedAt: new Date(doc.startedAt).toISOString(),
		startedBy: doc.startedBy ?? null,
		endedAt: doc.endedAt ? new Date(doc.endedAt).toISOString() : null,
		steps,
		chunks: (doc.chunks ?? []).map((c: any) => ({ from: c.from, to: c.to, verifyStep: c.verifyStep ?? null })),
		cursor: { chunk: doc.cursor?.chunk ?? 0, phase: doc.cursor?.phase ?? 'play' },
		playing: live ? { chunk: live.chunk, runId: live.runId, startedAt: new Date(live.startedAt).toISOString(), durationS: live.durationS } : null,
		results: results.map((r, i) => ({
			step: r.step,
			at: new Date(r.at).toISOString(),
			verdict: r.verdict,
			passed: !!r.passed,
			residuals: mapToSteps(r.residuals),
			residualMax: numOrNull(r.residualMax),
			visionVerdict: r.visionVerdict ?? null,
			cameraShiftMm: numOrNull(r.cameraShiftMm),
			markers: r.markers ?? [],
			tolerances: r.tolerances ? tolerancesOf({ tolerances: r.tolerances }) : null,
			snapshotDataUrl: o.snapshots === 'all' || (o.snapshots === 'latest' && i >= results.length - LAST_RESULTS_WITH_SNAPSHOT) ? (r.snapshotDataUrl ?? null) : null,
			message: r.message ?? '',
			warnings: r.warnings ?? [],
			elapsedMs: numOrNull(r.elapsedMs)
		})),
		failure: doc.failure?.message ? { step: doc.failure.step, verdict: doc.failure.verdict, message: doc.failure.message } : null,
		warnings: doc.warnings ?? [],
		error: doc.error ?? null,
		verifiedSteps: steps.filter((s) => s.verify).length,
		passedSteps: results.filter((r) => r.passed).length
	};
}

async function loadRun(id: string): Promise<any> {
	await connectDB();
	const doc = (await RobotArmVerifiedRun.findById(id).lean()) as any;
	if (!doc) throw new AnimateError('Verified run not found.', 404);
	return doc;
}

export async function getVerifiedRun(id: string, snapshots: 'latest' | 'all' = 'all'): Promise<VerifiedRunSummary> {
	return runSummary(await loadRun(id), { snapshots });
}

export async function listVerifiedRuns(o: { sourceId?: string; limit?: number } = {}): Promise<VerifiedRunSummary[]> {
	await connectDB();
	const q: Record<string, unknown> = {};
	if (o.sourceId) q.sourceId = o.sourceId;
	const docs = (await RobotArmVerifiedRun.find(q).select('-results.snapshotDataUrl').sort({ startedAt: -1 }).limit(o.limit ?? 10).lean()) as any[];
	return docs.map((d) => runSummary(d, { snapshots: 'none' }));
}

/** A run still marked running (one at a time: the arm is one arm). */
export async function activeVerifiedRun(): Promise<VerifiedRunSummary | null> {
	await connectDB();
	const doc = (await RobotArmVerifiedRun.findOne({ status: 'running' }).sort({ startedAt: -1 }).lean()) as any;
	return doc ? runSummary(doc, { snapshots: 'none' }) : null;
}

async function resolveSource(kind: PlayKind, id: string): Promise<{ name: string; keyframes: ResolvedKeyframe[]; rateHz: number }> {
	if (kind === 'move_set') {
		const r = await resolveMoveSet(id);
		return { name: r.summary.name, keyframes: r.keyframes, rateHz: r.summary.rateHz || DEFAULT_RATE_HZ };
	}
	if (kind === 'sequence') {
		const r = await resolveSequence(id);
		return { name: r.summary.name, keyframes: r.keyframes, rateHz: DEFAULT_RATE_HZ };
	}
	const doc = (await RobotArmPose.findById(id).select('-lastPlay').lean()) as any;
	if (!doc) throw new AnimateError('Pose not found.', 404);
	const p: PoseSummary = poseSummary(doc);
	return { name: p.name, keyframes: resolveKeyframes([{ poseId: id, holdS: 1, durationS: 1, easing: 'ease' }], new Map([[id, p]])), rateHz: DEFAULT_RATE_HZ };
}

/**
 * Start a verified run: resolve the steps, decide which are verified (the
 * keyframe's `verify`, else "has a reference for this camera"), refuse when
 * a step that must be verified has no reference or a stale one, plan the
 * chunks, and create the run record. Nothing moves yet — the page calls
 * `verifiedRunNext` straight after, and again after every chunk.
 */
export async function startVerifiedRun(user: User, o: { kind: PlayKind; id: string; cameraName: string }): Promise<VerifiedRunSummary> {
	await connectDB();
	if (!o.cameraName) throw new AnimateError('No camera selected.');
	const running = await RobotArmVerifiedRun.findOne({ status: 'running' }).select('_id name').lean();
	if (running) throw new AnimateError(`A verified run ("${(running as any).name}") is still marked running — stop it first.`, 409);
	const src = await resolveSource(o.kind, o.id);
	if (!src.keyframes.length) throw new AnimateError('Nothing to play — add poses first.');
	const refs = await listPoseCalibrations({ poseIds: [...new Set(src.keyframes.filter((k) => !k.fire).map((k) => k.poseId))], cameraName: o.cameraName });
	const refByPose = new Map(refs.map((r) => [r.poseId, r]));
	const problems: string[] = [];
	// A fire step holds where the arm is; it is stored with the pose before it
	// (or the next one when it comes first) so the step record has positions.
	const holdAt = (index: number): number[] =>
		[...src.keyframes.slice(0, index)].reverse().find((k) => !k.fire)?.positions ?? src.keyframes.slice(index).find((k) => !k.fire)?.positions ?? [];
	const steps = src.keyframes.map((k, index) => {
		if (k.fire) {
			// Never camera-checked: the trapdoors have no markers. Fired by the Pi inside its chunk's play.
			return { index, poseId: '', name: k.name, positions: holdAt(index), holdS: k.holdS, durationS: 0, easing: 'linear', verify: false, calibrationId: null, tolerances: null, fire: k.fire };
		}
		const ref = refByPose.get(k.poseId) ?? null;
		const verify = verifyWanted(k.verify, !!ref && !ref.stale);
		if (verify && !ref) problems.push(`step ${index + 1} "${friendlyName(k.name)}" has no camera reference for ${o.cameraName}`);
		else if (verify && ref?.stale) problems.push(`step ${index + 1} "${friendlyName(k.name)}" was edited after its reference was taken — retake it`);
		const tol = verify && ref ? effectiveTolerances(ref.tolerances, k.tolerances as ToleranceOverride | undefined) : null;
		return {
			index,
			poseId: k.poseId,
			name: k.name,
			positions: k.positions,
			target: k.target,
			holdS: k.holdS,
			durationS: k.durationS,
			easing: k.easing,
			settle: k.settle,
			verify,
			calibrationId: verify && ref ? ref._id : null,
			tolerances: tol
		};
	});
	if (problems.length) throw new AnimateError(`Cannot start a verified run: ${problems.join('; ')}. Capture the reference (Go to pose → Capture), or turn verification off for that step.`, 409);
	if (!steps.some((s) => s.verify)) throw new AnimateError('No step is verified — capture a reference for at least one pose, or use plain Play.', 409);
	// The arm is checked before the first chunk (verifiedRunNext); here only "is it there".
	await requireIdle();
	const chunks = planChunks(steps.map((s) => s.verify));
	const _id = generateId();
	const now = new Date();
	await RobotArmVerifiedRun.create({
		_id,
		kind: o.kind,
		sourceId: o.id,
		name: src.name,
		cameraName: o.cameraName,
		status: 'running',
		startedAt: now,
		startedBy: opRef(user),
		rateHz: src.rateHz,
		steps,
		chunks,
		cursor: { chunk: 0, phase: 'play' },
		plays: [],
		results: [],
		failure: null,
		warnings: []
	});
	await audit(user, 'robot_arm.verified.run_start', 'robot_arm_verified_runs', _id, {
		kind: o.kind,
		sourceId: o.id,
		name: src.name,
		cameraName: o.cameraName,
		steps: steps.map((s) => ({ index: s.index, name: s.name, verify: s.verify, tolerances: s.tolerances })),
		chunks
	});
	return runSummary(await loadRun(_id));
}

async function endRun(doc: any, status: RunStatus, extra: Record<string, unknown> = {}) {
	await RobotArmVerifiedRun.updateOne({ _id: doc._id, status: 'running' }, { $set: { status, endedAt: new Date(), 'cursor.phase': 'done', ...extra } });
}

function chunkKeyframes(doc: any, chunk: Chunk): ResolvedKeyframe[] {
	return (doc.steps as any[]).slice(chunk.from, chunk.to + 1).map((s) => ({
		poseId: s.poseId ?? '',
		name: s.name,
		positions: (s.positions ?? []).map(Number),
		...(Array.isArray(s.target) && s.target.length ? { target: s.target.map(Number) } : {}),
		holdS: Number(s.holdS ?? 0),
		durationS: Number(s.durationS ?? 1),
		easing: s.easing ?? 'ease',
		...(s.settle === false ? { settle: false } : {}),
		...(s.fire?.solenoid ? { fire: { solenoid: s.fire.solenoid, pulseMs: Number(s.fire.pulseMs) } } : {})
	}));
}

/**
 * Advance the run by one request. What happens depends on the cursor:
 *
 *   play     — the arm MOVES: render the chunk from where the arm is, write
 *              it to the Pi, start the replay. → playing
 *   playing  — the Pi still reports the replay: nothing (the page polls).
 *              Idle: the chunk is over → verify if it ends at a verified
 *              step, else on to the next chunk (or done).
 *   verify   — settle, read the encoders, detect, judge with the step's
 *              tolerances, record. Pass → next chunk / passed. Fail →
 *              failed, torque left on, nothing else moves.
 *
 * Each branch is a handful of Pi calls, so one request is a few seconds.
 */
export async function verifiedRunNext(user: User, id: string): Promise<VerifiedRunSummary> {
	let doc = await loadRun(id);
	if (doc.status !== 'running') return runSummary(doc);
	const chunks: Chunk[] = (doc.chunks ?? []).map((c: any) => ({ from: c.from, to: c.to, verifyStep: c.verifyStep ?? null }));
	const cursor: RunCursor = { chunk: doc.cursor?.chunk ?? 0, phase: doc.cursor?.phase ?? 'play' };
	const chunk = chunks[cursor.chunk];
	if (!chunk) {
		await endRun(doc, 'error', { error: 'The run lost its place (no such chunk).' });
		return runSummary(await loadRun(id));
	}

	try {
		if (cursor.phase === 'play') {
			const now = await armNowIdle();
			const warnings = requireCool(now);
			const kfs = chunkKeyframes(doc, chunk);
			const label = chunk.verifyStep != null ? `→ ${friendlyName(doc.steps[chunk.verifyStep].name)}` : `steps ${chunk.from + 1}–${chunk.to + 1}`;
			const play = await writeAndPlay(user, {
				title: `${friendlyName(doc.name)} ${label}`,
				keyframes: kfs,
				rateHz: doc.rateHz || DEFAULT_RATE_HZ,
				kind: doc.kind,
				id: doc.sourceId,
				lastPlay: false,
				auditAction: 'robot_arm.verified.chunk_play',
				auditExtra: { verifiedRunId: id, chunk: cursor.chunk, from: chunk.from, to: chunk.to, verifyStep: chunk.verifyStep }
			});
			await RobotArmVerifiedRun.updateOne(
				{ _id: id, status: 'running' },
				{
					$set: { 'cursor.phase': 'playing' },
					$push: {
						plays: { chunk: cursor.chunk, runId: play.runId, startedAt: new Date(), durationS: play.durationS, leadInS: play.leadInS, frames: play.frames },
						...(warnings.length || play.warnings.length ? { warnings: { $each: [...warnings, ...play.warnings] } } : {})
					}
				}
			);
			return runSummary(await loadRun(id));
		}

		if (cursor.phase === 'playing') {
			const live = (doc.plays as any[]).find((p) => !p.endedAt && p.chunk === cursor.chunk);
			const active = (await robotArm.getActive()).active;
			if (active && live && active.run_id !== live.runId) throw new AnimateError(`A ${active.kind} session (${active.run_id}) took the arm while the run was playing — stopped.`, 409);
			if (active) {
				// Still playing. Give up only if it is far past its own length.
				const over = live ? (Date.now() - new Date(live.startedAt).getTime()) / 1000 - live.durationS : 0;
				if (over < PLAY_GRACE_S) return runSummary(doc);
				throw new AnimateError(`The Pi still reports the replay ${Math.round(over)} s after it should have ended — stopped. Check the Control tab.`, 502);
			}
			if (live) await RobotArmVerifiedRun.updateOne({ _id: id, 'plays.runId': live.runId }, { $set: { 'plays.$.endedAt': new Date() } });
			if (chunk.verifyStep == null) {
				const next = advanceCursor(cursor, chunks.length);
				if (next.phase === 'done') {
					await endRun(doc, 'passed');
					await audit(user, 'robot_arm.verified.run_passed', 'robot_arm_verified_runs', id, { name: doc.name, steps: doc.steps.length });
				} else await RobotArmVerifiedRun.updateOne({ _id: id, status: 'running' }, { $set: { cursor: next } });
				return runSummary(await loadRun(id));
			}
			await RobotArmVerifiedRun.updateOne({ _id: id, status: 'running' }, { $set: { 'cursor.phase': 'verify' } });
			cursor.phase = 'verify';
			doc = await loadRun(id);
		}

		// verify
		const step = doc.steps[chunk.verifyStep!];
		const ref = (await RobotArmPoseCalibration.findById(step.calibrationId).lean()) as any;
		if (!ref) throw new AnimateError(`The reference for "${friendlyName(step.name)}" is gone.`, 404);
		// Torque first (an older Pi replay drops it at the end), then let the arm stop swaying.
		const now = await readArm().catch(() => null);
		const torqueNote: string[] = [];
		if (now && now.torqueOn === false) {
			const t = await torqueBackOn();
			if (!t.ok) torqueNote.push(`Torque could not be turned back on before the check (${t.error}).`);
			else await sleep(400);
		}
		await sleep(SETTLE_MS);
		const tol: StepTolerances = step.tolerances ? tolerancesOf({ tolerances: step.tolerances }) : tolerancesOf(ref);
		const c = await checkAgainst(ref, friendlyName(step.name), tol);
		c.warnings.unshift(...torqueNote);
		const result = {
			step: step.index,
			at: new Date(),
			verdict: c.assessment.verdict,
			passed: c.assessment.passed,
			residuals: c.residuals?.perJoint ?? undefined,
			residualMax: c.assessment.residualMax,
			visionVerdict: c.vision?.verdict ?? null,
			cameraShiftMm: c.vision?.cameraShift?.compensated ? c.vision.cameraShift.mm : null,
			markers: markersOf(c.vision),
			tolerances: tol,
			snapshotDataUrl: c.snapshotDataUrl,
			message: c.message,
			warnings: c.warnings,
			elapsedMs: c.elapsedMs
		};
		await recordPoseCheck(ref, user, 'run', c, id);
		await audit(user, c.assessment.passed ? 'robot_arm.verified.step_ok' : 'robot_arm.verified.step_failed', 'robot_arm_verified_runs', id, {
			step: step.index,
			name: step.name,
			poseId: step.poseId,
			verdict: c.assessment.verdict,
			residuals: c.residuals?.perJoint ?? null,
			tolerances: tol,
			visionVerdict: c.vision?.verdict ?? null,
			markers: markersOf(c.vision),
			warnings: c.warnings
		});
		if (c.assessment.passed) {
			const next = advanceCursor(cursor, chunks.length);
			if (next.phase === 'done') {
				await RobotArmVerifiedRun.updateOne({ _id: id, status: 'running' }, { $push: { results: result } });
				await endRun(doc, 'passed');
				await audit(user, 'robot_arm.verified.run_passed', 'robot_arm_verified_runs', id, { name: doc.name, steps: doc.steps.length });
			} else await RobotArmVerifiedRun.updateOne({ _id: id, status: 'running' }, { $set: { cursor: next }, $push: { results: result } });
		} else {
			// Stop here. Torque is on (checked above), so the arm holds this pose; no retry by design.
			await RobotArmVerifiedRun.updateOne({ _id: id, status: 'running' }, { $push: { results: result } });
			await endRun(doc, 'failed', { failure: { step: step.index, verdict: c.assessment.verdict, message: c.message } });
			await audit(user, 'robot_arm.verified.run_failed', 'robot_arm_verified_runs', id, { name: doc.name, step: step.index, verdict: c.assessment.verdict, message: c.message });
		}
		return runSummary(await loadRun(id));
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await endRun(doc, 'error', { error: msg });
		await audit(user, 'robot_arm.verified.run_error', 'robot_arm_verified_runs', id, { name: doc.name, phase: cursor.phase, chunk: cursor.chunk, error: msg });
		return runSummary(await loadRun(id));
	}
}

/** Stop a run: stop whatever the Pi is playing, torque back on, mark it stopped. */
export async function stopVerifiedRun(user: User, id: string): Promise<{ run: VerifiedRunSummary; torqueOn: boolean; error: string | null }> {
	const doc = await loadRun(id);
	let stoppedRunId: string | null = null;
	let error: string | null = null;
	try {
		stoppedRunId = (await robotArm.stop()).stopped_run_id ?? null;
	} catch (e) {
		error = (e as Error).message;
	}
	const t = await torqueBackOn();
	if (doc.status === 'running') {
		await endRun(doc, 'stopped', { error: error ?? null });
		await audit(user, 'robot_arm.verified.run_stop', 'robot_arm_verified_runs', id, { name: doc.name, stoppedRunId, torqueOn: t.ok, error: error ?? t.error });
	}
	return { run: runSummary(await loadRun(id)), torqueOn: t.ok, error: error ?? t.error };
}
