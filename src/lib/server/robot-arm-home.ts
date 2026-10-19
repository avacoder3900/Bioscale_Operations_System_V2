/**
 * Robot arm — camera-verified HOME calibration: the I/O half.
 *
 * Pure decisions live in $lib/robot-arm/home-calibration (unit-tested). This
 * module talks to the Pi (pose, torque, per-joint jog, camera snapshot),
 * decodes frames with sharp, and persists the one calibration record.
 *
 * Pi facts this relies on (live arm-pi OpenAPI, 2026-10-19):
 *   GET  /pose                      → joint_steps keyed by servo id "1".."5"
 *   POST /servos/{id}/jog           → bounded delta move; 409 while torque is off
 *   POST /torque                    → {enable} on the follower
 *   GET  /cameras/{name}/snapshot.jpg
 * There is NO absolute "move to positions" route on the live Pi, so a return
 * to home is one jog per joint (delta = taught − current), then a re-read.
 */
import sharp from 'sharp';
import { connectDB, AuditLog, generateId } from '$lib/server/db';
import { RobotArmHomeCalibration } from '$lib/server/db/models';
import { robotArm, type CameraStatus } from './robot-arm-client';
import {
	assessHome,
	describeVerdict,
	imageSimilarity,
	planJogDeltas,
	residuals,
	signatureFromGrey,
	HOME_SERVO_IDS,
	HOME_STEP_TOLERANCE,
	SIGNATURE_HEIGHT,
	SIGNATURE_WIDTH,
	type HomeAssessment,
	type JointSteps
} from '$lib/robot-arm/home-calibration';

type User = { _id: string; username: string };

/** Settle time after the last jog before the encoders are re-read. */
const SETTLE_MS = 1500;
/** Width of the stored thumbnail (data URL in Mongo). */
const THUMB_WIDTH = 240;

export interface HomeCalibrationSummary {
	capturedAt: string;
	capturedBy: { _id?: string; username?: string } | null;
	jointSteps: JointSteps;
	pose: { x_mm: number | null; y_mm: number | null; z_mm: number | null };
	cameraName: string | null;
	hasSignature: boolean;
	thumbnailDataUrl: string | null;
	note: string | null;
	lastCheck: {
		at: string;
		by: { username?: string } | null;
		verdict: string;
		similarity: number | null;
		residualMax: number | null;
		kind: string;
	} | null;
}

export async function loadHomeCalibration(): Promise<HomeCalibrationSummary | null> {
	await connectDB();
	const doc = (await RobotArmHomeCalibration.findById('default').lean()) as any;
	if (!doc) return null;
	return summarize(doc);
}

function summarize(doc: any): HomeCalibrationSummary {
	const steps: JointSteps = {};
	const raw = doc.jointSteps instanceof Map ? Object.fromEntries(doc.jointSteps) : doc.jointSteps ?? {};
	for (const [k, v] of Object.entries(raw)) steps[String(k)] = Number(v);
	return {
		capturedAt: new Date(doc.capturedAt).toISOString(),
		capturedBy: doc.capturedBy ?? null,
		jointSteps: steps,
		pose: { x_mm: doc.pose?.x_mm ?? null, y_mm: doc.pose?.y_mm ?? null, z_mm: doc.pose?.z_mm ?? null },
		cameraName: doc.cameraName ?? null,
		hasSignature: Array.isArray(doc.signature) && doc.signature.length > 0,
		thumbnailDataUrl: doc.thumbnailDataUrl ?? null,
		note: doc.note ?? null,
		lastCheck: doc.lastCheck?.at
			? {
					at: new Date(doc.lastCheck.at).toISOString(),
					by: doc.lastCheck.by ?? null,
					verdict: String(doc.lastCheck.verdict ?? ''),
					similarity: doc.lastCheck.similarity ?? null,
					residualMax: doc.lastCheck.residualMax ?? null,
					kind: String(doc.lastCheck.kind ?? '')
				}
			: null
	};
}

/** The camera to calibrate against: the one asked for, else the first the Pi lists. */
export function pickHomeCamera(cameras: CameraStatus[], requested?: string | null): string | null {
	if (requested && cameras.some((c) => c.name === requested)) return requested;
	return cameras[0]?.name ?? null;
}

async function readJointSteps(): Promise<{ steps: JointSteps; pose: { x_mm: number; y_mm: number; z_mm: number } }> {
	const p = await robotArm.getPose();
	const steps: JointSteps = {};
	for (const [k, v] of Object.entries(p.joint_steps ?? {})) steps[String(k)] = Number(v);
	for (const sid of HOME_SERVO_IDS) {
		if (!Number.isFinite(steps[String(sid)])) throw new Error(`the arm did not report a position for servo ${sid}`);
	}
	return { steps, pose: { x_mm: p.x_mm, y_mm: p.y_mm, z_mm: p.z_mm } };
}

interface Frame {
	bytes: ArrayBuffer;
	signature: number[];
	thumbnailDataUrl: string;
}

/**
 * One frame from the Pi camera, as the stored signature + a thumbnail. The Pi
 * serves its worker's latest frame, so a camera nobody is viewing may have
 * none yet: one retry after a short wait covers the worker spinning up.
 */
async function grabFrame(cameraName: string): Promise<Frame> {
	let lastErr: unknown;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const { bytes } = await robotArm.getCameraSnapshot(cameraName);
			const buf = Buffer.from(bytes);
			const grey = await sharp(buf)
				.rotate()
				.greyscale()
				.resize(SIGNATURE_WIDTH, SIGNATURE_HEIGHT, { fit: 'fill' })
				.raw()
				.toBuffer();
			const thumb = await sharp(buf).rotate().resize({ width: THUMB_WIDTH }).jpeg({ quality: 70 }).toBuffer();
			return {
				bytes,
				signature: signatureFromGrey(grey),
				thumbnailDataUrl: `data:image/jpeg;base64,${thumb.toString('base64')}`
			};
		} catch (e) {
			lastErr = e;
			await new Promise((r) => setTimeout(r, 1500));
		}
	}
	throw new Error(
		`no frame from camera "${cameraName}": ${lastErr instanceof Error ? lastErr.message : String(lastErr)}. ` +
			'Open the camera panel so the feed is running, then try again.'
	);
}

async function requireArmFree(): Promise<void> {
	const { active } = await robotArm.getActive();
	if (active) throw new Error(`the arm is busy (${active.kind} run ${active.run_id}) — stop it first`);
}

/**
 * Capture: the arm is at its zero/home (placed by the operator) → record the
 * encoders and the camera's view of it. Replaces any previous calibration.
 */
export async function captureHomeCalibration(
	user: User,
	o: { cameraName?: string | null; note?: string | null } = {}
): Promise<{ summary: HomeCalibrationSummary; cameraWarning: string | null }> {
	await connectDB();
	await requireArmFree();
	const { steps, pose } = await readJointSteps();

	let frame: Frame | null = null;
	let cameraWarning: string | null = null;
	let cameraName: string | null = null;
	try {
		cameraName = pickHomeCamera(await robotArm.listCameras(), o.cameraName);
		if (!cameraName) cameraWarning = 'The Pi lists no camera — home was calibrated from the encoders only.';
		else frame = await grabFrame(cameraName);
	} catch (e) {
		cameraWarning = `Camera reference not captured: ${e instanceof Error ? e.message : String(e)}`;
	}

	// Full-resolution frame to R2, best-effort: the signature + thumbnail in
	// Mongo are what the feature runs on; the original is for humans later.
	let referenceImageKey: string | null = null;
	if (frame) {
		try {
			// Worker path, not direct S3: production's direct R2 credentials are
			// invalid (228ae7d2), and the Worker is what the rest of the app uses.
			const { uploadViaWorker } = await import('./services/r2');
			referenceImageKey = `robot-arm/home-calibration/${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`;
			await uploadViaWorker(Buffer.from(frame.bytes), referenceImageKey, 'image/jpeg');
		} catch (e) {
			console.warn('[arm-home] reference frame not uploaded to R2:', e instanceof Error ? e.message : e);
			referenceImageKey = null;
		}
	}

	const now = new Date();
	await RobotArmHomeCalibration.findByIdAndUpdate(
		'default',
		{
			$set: {
				capturedAt: now,
				capturedBy: { _id: user._id, username: user.username },
				jointSteps: steps,
				pose,
				cameraName: frame ? cameraName : null,
				signature: frame?.signature ?? null,
				signatureWidth: frame ? SIGNATURE_WIDTH : null,
				signatureHeight: frame ? SIGNATURE_HEIGHT : null,
				thumbnailDataUrl: frame?.thumbnailDataUrl ?? null,
				referenceImageKey,
				note: o.note ?? null
			},
			$unset: { lastCheck: '' }
		},
		{ upsert: true, setDefaultsOnInsert: true }
	);
	await AuditLog.create({
		_id: generateId(),
		tableName: 'robot_arm_home_calibrations',
		recordId: 'default',
		action: 'robot_arm.home.calibrate',
		newData: { jointSteps: steps, pose, cameraName: frame ? cameraName : null, hasSignature: !!frame, referenceImageKey, cameraWarning, userId: user._id },
		changedBy: user.username,
		changedAt: now
	});
	const doc = await RobotArmHomeCalibration.findById('default').lean();
	return { summary: summarize(doc), cameraWarning };
}

export interface HomeCheckResult {
	assessment: HomeAssessment;
	message: string;
	residuals: Record<string, number>;
	/** What the camera saw during this check, for the page to show beside the reference. */
	snapshotDataUrl: string | null;
	cameraWarning: string | null;
	/** Return only: the jogs that were sent. */
	moved: { sid: number; delta: number }[];
}

async function compareWithReference(doc: any): Promise<{ similarity: number | null; snapshotDataUrl: string | null; warning: string | null }> {
	if (!Array.isArray(doc.signature) || !doc.signature.length || !doc.cameraName) {
		return { similarity: null, snapshotDataUrl: null, warning: 'This calibration has no camera reference — only the encoders were checked.' };
	}
	try {
		const frame = await grabFrame(doc.cameraName);
		return { similarity: imageSimilarity(doc.signature, frame.signature), snapshotDataUrl: frame.thumbnailDataUrl, warning: null };
	} catch (e) {
		return { similarity: null, snapshotDataUrl: null, warning: `Camera check skipped: ${e instanceof Error ? e.message : String(e)}` };
	}
}

async function recordCheck(doc: any, user: User, kind: 'return' | 'check', a: HomeAssessment, extra: Record<string, unknown>) {
	const now = new Date();
	await RobotArmHomeCalibration.updateOne(
		{ _id: 'default' },
		{ $set: { lastCheck: { at: now, by: { _id: user._id, username: user.username }, verdict: a.verdict, similarity: a.similarity, residualMax: Number.isFinite(a.residualMax) ? a.residualMax : null, kind } } }
	);
	await AuditLog.create({
		_id: generateId(),
		tableName: 'robot_arm_home_calibrations',
		recordId: 'default',
		action: kind === 'return' ? 'robot_arm.home.return' : 'robot_arm.home.check',
		newData: { verdict: a.verdict, similarity: a.similarity, residualMax: a.residualMax, calibratedAt: doc.capturedAt, ...extra, userId: user._id },
		changedBy: user.username,
		changedAt: now
	});
}

async function loadDoc(): Promise<any> {
	await connectDB();
	const doc = (await RobotArmHomeCalibration.findById('default').lean()) as any;
	if (!doc) throw new Error('no home calibration yet — place the arm at zero and press Calibrate home first');
	return doc;
}

function taughtSteps(doc: any): JointSteps {
	const raw = doc.jointSteps instanceof Map ? Object.fromEntries(doc.jointSteps) : doc.jointSteps ?? {};
	const steps: JointSteps = {};
	for (const [k, v] of Object.entries(raw)) steps[String(k)] = Number(v);
	return steps;
}

/** Check only: where is the arm relative to home, and does the camera agree? No motion. */
export async function checkHome(user: User): Promise<HomeCheckResult> {
	const doc = await loadDoc();
	const target = taughtSteps(doc);
	const { steps } = await readJointSteps();
	const r = residuals(steps, target);
	const cam = await compareWithReference(doc);
	const assessment = assessHome(r, cam.similarity);
	await recordCheck(doc, user, 'check', assessment, { residuals: r.perJoint });
	return { assessment, message: describeVerdict(assessment), residuals: r.perJoint, snapshotDataUrl: cam.snapshotDataUrl, cameraWarning: cam.warning, moved: [] };
}

/**
 * Return to home: torque on, one bounded jog per joint to the taught steps,
 * settle, re-read, and verify against the camera reference. Refused while a
 * session holds the bus. The arm WILL move.
 */
export async function returnToHome(user: User): Promise<HomeCheckResult> {
	const doc = await loadDoc();
	const target = taughtSteps(doc);
	await requireArmFree();
	await robotArm.setTorque(true);
	const before = await readJointSteps();
	const plan = planJogDeltas(before.steps, target);
	const moved: { sid: number; delta: number }[] = [];
	for (const step of plan) {
		await robotArm.jogJoint(step.sid, step.delta);
		moved.push(step);
	}
	if (moved.length) await new Promise((res) => setTimeout(res, SETTLE_MS));
	const after = await readJointSteps();
	const r = residuals(after.steps, target);
	const cam = await compareWithReference(doc);
	const assessment = assessHome(r, cam.similarity);
	await recordCheck(doc, user, 'return', assessment, { before: before.steps, moved, after: after.steps, residuals: r.perJoint, tolerance: HOME_STEP_TOLERANCE });
	const message = moved.length ? describeVerdict(assessment) : `Arm was already within ${HOME_STEP_TOLERANCE} steps of home — nothing moved. ${describeVerdict(assessment)}`;
	return { assessment, message, residuals: r.perJoint, snapshotDataUrl: cam.snapshotDataUrl, cameraWarning: cam.warning, moved };
}

export async function clearHomeCalibration(user: User): Promise<boolean> {
	await connectDB();
	const res = await RobotArmHomeCalibration.deleteOne({ _id: 'default' });
	if (res.deletedCount) {
		await AuditLog.create({
			_id: generateId(),
			tableName: 'robot_arm_home_calibrations',
			recordId: 'default',
			action: 'robot_arm.home.clear',
			newData: { userId: user._id },
			changedBy: user.username,
			changedAt: new Date()
		});
	}
	return res.deletedCount > 0;
}
