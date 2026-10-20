/**
 * Robot arm — AprilTag vision calibration (ARM-05): the I/O half.
 *
 * Pure decisions live in $lib/robot-arm/apriltags (pose comparison, camera
 * shift, verdicts) and $lib/robot-arm/home-calibration (jog plan, encoder
 * residuals), both unit-tested. This module owns the tag registry, turns one
 * detection with the arm parked at home into a calibration, and runs the
 * server-side check that answers "is every tag where it was at home?" — the
 * backstop for a run that ends with the arm not back home.
 *
 * Pi calls:
 *   POST /cameras/{name}/apriltags/detect   tags + poses (+ the frame); 404 until installed
 *   GET  /pose                              encoder steps, servos 1–5
 *   POST /torque, POST /servos/{id}/jog     return to home
 */
import sharp from 'sharp';
import { connectDB, AuditLog, generateId } from '$lib/server/db';
import { RobotArmTag, RobotArmTagCalibration } from '$lib/server/db/models';
import { robotArm, type AprilTagDetectResponse } from './robot-arm-client';
import {
	assessTags,
	describeVision,
	sheetSizeMm,
	DEFAULT_TOLERANCES,
	MAX_TAG_ID,
	SHEET_MAX_ID,
	type CalibratedTag,
	type TagDetection,
	type TagRole,
	type Tolerances,
	type VisionAssessment
} from '$lib/robot-arm/apriltags';
import {
	assessHome,
	planJogDeltas,
	residuals,
	HOME_SERVO_IDS,
	HOME_STEP_TOLERANCE,
	type HomeAssessment,
	type JointSteps,
	type Residuals
} from '$lib/robot-arm/home-calibration';

type User = { _id: string; username: string };

/** Settle time after the last jog before the encoders and camera are re-read. */
const SETTLE_MS = 1500;
/** Width of the stored thumbnails (data URLs in Mongo). */
const THUMB_WIDTH = 480;

// ── registry ─────────────────────────────────────────────────────────────

export interface TagSummary {
	_id: string;
	tagId: number;
	sizeMm: number;
	role: TagRole;
	name: string;
	group: string | null;
	notes: string | null;
	archived: boolean;
	createdAt: string | null;
}

function tagSummary(d: any): TagSummary {
	return {
		_id: String(d._id),
		tagId: Number(d.tagId),
		sizeMm: Number(d.sizeMm),
		role: d.role === 'fixed' ? 'fixed' : 'arm',
		name: d.name,
		group: d.group ?? null,
		notes: d.notes ?? null,
		archived: !!d.archivedAt,
		createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : null
	};
}

export async function listTags(): Promise<TagSummary[]> {
	await connectDB();
	const rows = await RobotArmTag.find({}).sort({ archivedAt: 1, tagId: 1 }).lean();
	return (rows as any[]).map(tagSummary);
}

async function audit(action: string, tableName: string, recordId: string, user: User, newData: Record<string, unknown>) {
	await AuditLog.create({
		_id: generateId(),
		tableName,
		recordId,
		action,
		newData: { ...newData, userId: user._id },
		changedBy: user.username,
		changedAt: new Date()
	});
}

export interface TagInput {
	tagId?: string | number | null;
	sizeMm?: string | number | null;
	role?: string | null;
	name?: string | null;
	group?: string | null;
	notes?: string | null;
}

function cleanTagInput(input: TagInput) {
	const tagId = Number(input.tagId);
	if (!Number.isInteger(tagId) || tagId < 0 || tagId > MAX_TAG_ID) throw new Error(`Tag ID must be a whole number 0–${MAX_TAG_ID}.`);
	const rawSize = input.sizeMm == null || input.sizeMm === '' ? sheetSizeMm(tagId) : Number(input.sizeMm);
	if (rawSize == null) throw new Error(`Tag ${tagId} is not on the printed sheet (IDs 0–${SHEET_MAX_ID}); enter its size.`);
	if (!Number.isFinite(rawSize) || rawSize < 1 || rawSize > 500) throw new Error('Tag size must be 1–500 mm (edge of the black square).');
	const role: TagRole = input.role === 'fixed' ? 'fixed' : input.role === 'arm' ? 'arm' : (() => {
		throw new Error('Say whether the tag is on the arm or fixed to the surroundings.');
	})();
	const name = (input.name ?? '').trim();
	if (!name) throw new Error('A tag needs a name (where it is stuck).');
	if (name.length > 60) throw new Error('Tag names are limited to 60 characters.');
	const group = (input.group ?? '').trim() || null;
	const notes = (input.notes ?? '').trim() || null;
	return { tagId, sizeMm: Math.round(rawSize * 100) / 100, role, name, group, notes };
}

async function assertFree(tagId: number, name: string, exceptId?: string) {
	const notMe = exceptId ? { _id: { $ne: exceptId } } : {};
	const idClash = await RobotArmTag.findOne({ archivedAt: null, tagId, ...notMe }).select('name').lean();
	if (idClash) throw new Error(`Tag ${tagId} is already registered as "${(idClash as any).name}". Each printed ID goes on one spot only.`);
	const nameClash = await RobotArmTag.findOne({
		archivedAt: null,
		name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
		...notMe
	})
		.select('_id')
		.lean();
	if (nameClash) throw new Error(`A tag called "${name}" already exists.`);
}

export async function createTag(user: User, input: TagInput) {
	await connectDB();
	const t = cleanTagInput(input);
	await assertFree(t.tagId, t.name);
	const _id = generateId();
	await RobotArmTag.create({ _id, ...t, createdBy: { _id: user._id, username: user.username } });
	await audit('robot_arm.tag.create', 'robot_arm_tags', _id, user, t);
	return { _id, ...t };
}

export async function updateTag(user: User, id: string, input: TagInput) {
	await connectDB();
	const before = (await RobotArmTag.findById(id).lean()) as any;
	if (!before) throw new Error('Tag not found.');
	const t = cleanTagInput(input);
	await assertFree(t.tagId, t.name, id);
	await RobotArmTag.updateOne({ _id: id }, { $set: t });
	await audit('robot_arm.tag.update', 'robot_arm_tags', id, user, {
		before: { tagId: before.tagId, sizeMm: before.sizeMm, role: before.role, name: before.name, group: before.group, notes: before.notes },
		after: t
	});
	return t;
}

export async function setTagArchived(user: User, id: string, archived: boolean) {
	await connectDB();
	const doc = (await RobotArmTag.findById(id).lean()) as any;
	if (!doc) throw new Error('Tag not found.');
	if (!archived) await assertFree(doc.tagId, doc.name, id);
	await RobotArmTag.updateOne(
		{ _id: id },
		{ $set: archived ? { archivedAt: new Date(), archivedBy: { _id: user._id, username: user.username } } : { archivedAt: null, archivedBy: null } }
	);
	await audit(archived ? 'robot_arm.tag.archive' : 'robot_arm.tag.restore', 'robot_arm_tags', id, user, { tagId: doc.tagId, name: doc.name });
}

// ── detection ────────────────────────────────────────────────────────────

/** A detection annotated with the registry: what each tag is, if registered. */
export interface DetectedTag extends TagDetection {
	registered: { _id: string; name: string; group: string | null; role: TagRole } | null;
}

export interface DetectResult {
	cameraName: string;
	available: boolean;
	reason: string | null;
	detector: string | null;
	width: number;
	height: number;
	intrinsics: { fx: number; fy: number; cx: number; cy: number; source: string } | null;
	tags: DetectedTag[];
	/** The JPEG the tags were found in, when asked for. */
	frame: Buffer | null;
}

/**
 * Sizes sent to the Pi: the registry's (as measured), falling back to the
 * printed sheet's for unregistered IDs so a preview can still show distance.
 */
function sizeMap(active: TagSummary[]): Record<string, number> {
	const sizes: Record<string, number> = {};
	for (let id = 0; id <= SHEET_MAX_ID; id++) sizes[String(id)] = sheetSizeMm(id)!;
	for (const t of active) sizes[String(t.tagId)] = t.sizeMm;
	return sizes;
}

function toDetection(t: AprilTagDetectResponse['tags'][number]): TagDetection {
	return {
		id: t.id,
		center: t.center,
		corners: t.corners,
		sizeMm: t.size_mm,
		pose: t.pose ? { t: t.pose.t_mm, R: t.pose.R, reprojPx: t.pose.reproj_px ?? null } : null,
		depthMm: typeof t.depth_mm === 'number' && t.depth_mm > 0 ? t.depth_mm : null
	};
}

export async function detectTags(cameraName: string, o: { includeFrame?: boolean; registry?: TagSummary[] } = {}): Promise<DetectResult> {
	if (!cameraName) throw new Error('No camera selected.');
	const registry = (o.registry ?? (await listTags())).filter((t) => !t.archived);
	const byTagId = new Map(registry.map((t) => [t.tagId, t]));
	const r = await robotArm.detectAprilTags(cameraName, { tag_sizes_mm: sizeMap(registry), include_frame: !!o.includeFrame, depth: true });
	const tags: DetectedTag[] = (r.tags ?? []).map((t) => {
		const reg = byTagId.get(t.id);
		return { ...toDetection(t), registered: reg ? { _id: reg._id, name: reg.name, group: reg.group, role: reg.role } : null };
	});
	return {
		cameraName,
		available: !!r.available,
		reason: r.reason ?? null,
		detector: r.detector ?? null,
		width: r.frame?.width ?? 0,
		height: r.frame?.height ?? 0,
		intrinsics: r.intrinsics ? { fx: r.intrinsics.fx, fy: r.intrinsics.fy, cx: r.intrinsics.cx, cy: r.intrinsics.cy, source: r.intrinsics.source } : null,
		tags,
		frame: r.frame_jpeg_b64 ? Buffer.from(r.frame_jpeg_b64, 'base64') : null
	};
}

// ── calibrations ─────────────────────────────────────────────────────────

export interface CalibrationSummary {
	_id: string;
	cameraName: string;
	status: 'active' | 'superseded';
	capturedAt: string;
	capturedBy: { username?: string } | null;
	note: string | null;
	frameWidth: number;
	frameHeight: number;
	intrinsicsSource: string | null;
	thumbnailDataUrl: string | null;
	tags: CalibratedTag[];
	tolerances: Tolerances;
	jointSteps: JointSteps | null;
	supersededAt: string | null;
	lastCheck: {
		at: string;
		by: { username?: string } | null;
		kind: string;
		verdict: string;
		visionVerdict: string | null;
		residualMax: number | null;
		cameraShiftMm: number | null;
		markers: { markerId: string; tagId: number; name: string; status: string; offMm: number | null; offDeg: number | null }[];
	} | null;
}

function jointStepsOf(doc: any): JointSteps | null {
	const raw = doc.jointSteps instanceof Map ? Object.fromEntries(doc.jointSteps) : doc.jointSteps;
	if (!raw || typeof raw !== 'object' || !Object.keys(raw).length) return null;
	const out: JointSteps = {};
	for (const [k, v] of Object.entries(raw)) out[String(k)] = Number(v);
	return out;
}

function calibrationSummary(doc: any, o: { withThumb: boolean }): CalibrationSummary {
	return {
		_id: String(doc._id),
		cameraName: doc.cameraName,
		status: doc.status,
		capturedAt: new Date(doc.capturedAt).toISOString(),
		capturedBy: doc.capturedBy ?? null,
		note: doc.note ?? null,
		frameWidth: doc.frameWidth,
		frameHeight: doc.frameHeight,
		intrinsicsSource: doc.intrinsics?.source ?? null,
		thumbnailDataUrl: o.withThumb ? (doc.thumbnailDataUrl ?? null) : null,
		tags: (doc.tags ?? []).map(
			(t: any): CalibratedTag => ({
				markerId: t.markerId,
				tagId: t.tagId,
				name: t.name,
				group: t.group ?? null,
				role: t.role === 'fixed' ? 'fixed' : 'arm',
				sizeMm: t.sizeMm,
				center: [t.center[0], t.center[1]],
				corners: (t.corners ?? []).map((c: number[]) => [c[0], c[1]] as [number, number]),
				pose: t.pose?.t?.length === 3 && t.pose?.R?.length === 9 ? { t: [t.pose.t[0], t.pose.t[1], t.pose.t[2]], R: [...t.pose.R], reprojPx: t.pose.reprojPx ?? null } : null,
				depthMm: t.depthMm ?? null
			})
		),
		tolerances: {
			positionMm: doc.tolerances?.positionMm ?? DEFAULT_TOLERANCES.positionMm,
			angleDeg: doc.tolerances?.angleDeg ?? DEFAULT_TOLERANCES.angleDeg,
			pixel: doc.tolerances?.pixel ?? DEFAULT_TOLERANCES.pixel
		},
		jointSteps: jointStepsOf(doc),
		supersededAt: doc.supersededAt ? new Date(doc.supersededAt).toISOString() : null,
		lastCheck: doc.lastCheck?.at
			? {
					at: new Date(doc.lastCheck.at).toISOString(),
					by: doc.lastCheck.by ?? null,
					kind: String(doc.lastCheck.kind ?? ''),
					verdict: String(doc.lastCheck.verdict ?? ''),
					visionVerdict: doc.lastCheck.visionVerdict ?? null,
					residualMax: doc.lastCheck.residualMax ?? null,
					cameraShiftMm: doc.lastCheck.cameraShiftMm ?? null,
					markers: (doc.lastCheck.markers ?? []).map((m: any) => ({
						markerId: m.markerId,
						tagId: m.tagId,
						name: m.name,
						status: m.status,
						offMm: m.offMm ?? null,
						offDeg: m.offDeg ?? null
					}))
				}
			: null
	};
}

/** Active calibration per camera (with thumbnails) and the recent history (without). */
export async function loadCalibrations(): Promise<{ active: CalibrationSummary[]; history: CalibrationSummary[] }> {
	await connectDB();
	const [active, history] = await Promise.all([
		RobotArmTagCalibration.find({ status: 'active' }).sort({ capturedAt: -1 }).lean(),
		RobotArmTagCalibration.find({ status: 'superseded' }).select('-thumbnailDataUrl').sort({ capturedAt: -1 }).limit(10).lean()
	]);
	return {
		active: (active as any[]).map((d) => calibrationSummary(d, { withThumb: true })),
		history: (history as any[]).map((d) => calibrationSummary(d, { withThumb: false }))
	};
}

async function thumbnail(buf: Buffer): Promise<string> {
	const t = await sharp(buf).rotate().resize({ width: THUMB_WIDTH, withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer();
	return `data:image/jpeg;base64,${t.toString('base64')}`;
}

async function requireArmFree(): Promise<void> {
	const { active } = await robotArm.getActive();
	if (active) throw new Error(`the arm is busy (${active.kind} run ${active.run_id}) — stop it first`);
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

function cleanTolerances(t?: { positionMm?: number | null; angleDeg?: number | null }): Tolerances {
	const pos = t?.positionMm;
	const ang = t?.angleDeg;
	return {
		positionMm: Number.isFinite(pos) && pos! > 0 && pos! <= 100 ? pos! : DEFAULT_TOLERANCES.positionMm,
		angleDeg: Number.isFinite(ang) && ang! >= 0 && ang! <= 90 ? ang! : DEFAULT_TOLERANCES.angleDeg,
		pixel: DEFAULT_TOLERANCES.pixel
	};
}

/**
 * Save a calibration: one fresh detection on the Pi, with the arm parked at
 * home. Every registered tag found is stored with its pose; unregistered tags
 * are ignored (register them first to include them). The encoders are read
 * in the same request and become the Return-to-home target.
 */
export async function saveCalibration(
	user: User,
	o: { cameraName: string; tolerances?: { positionMm?: number | null; angleDeg?: number | null }; note?: string | null }
): Promise<{ summary: CalibrationSummary; warnings: string[] }> {
	await connectDB();
	if (!o.cameraName) throw new Error('No camera selected.');
	const registry = (await listTags()).filter((t) => !t.archived);
	if (!registry.length) throw new Error('Register the tags first — none are in the registry.');

	// The arm must be parked and idle: the encoders read now become "home".
	await requireArmFree();

	const det = await detectTags(o.cameraName, { includeFrame: true, registry });
	if (!det.available) throw new Error(det.reason ?? 'the Pi could not detect tags');
	if (!det.frame) throw new Error('the Pi did not return the frame it detected on');

	const warnings: string[] = [];
	const byTagId = new Map(registry.map((t) => [t.tagId, t]));
	const tags: CalibratedTag[] = det.tags
		.filter((d) => byTagId.has(d.id))
		.map((d) => {
			const reg = byTagId.get(d.id)!;
			return {
				markerId: reg._id,
				tagId: d.id,
				name: reg.name,
				group: reg.group,
				role: reg.role,
				sizeMm: reg.sizeMm,
				center: d.center,
				corners: d.corners,
				pose: d.pose,
				depthMm: d.depthMm
			};
		});
	if (!tags.length) throw new Error(`none of the ${registry.length} registered tag(s) is visible — check the camera and lighting`);

	const unregistered = det.tags.filter((d) => !byTagId.has(d.id)).map((d) => d.id);
	if (unregistered.length) warnings.push(`Seen but not registered, so not calibrated: tag ${unregistered.join(', ')}.`);
	const seen = new Set(tags.map((t) => t.tagId));
	const unseen = registry.filter((t) => !seen.has(t.tagId));
	if (unseen.length) warnings.push(`Registered but not visible, so not calibrated: ${unseen.map((t) => `${t.name} (tag ${t.tagId})`).join(', ')}.`);
	const noPose = tags.filter((t) => !t.pose);
	if (noPose.length) warnings.push(`No pose for ${noPose.map((t) => t.name).join(', ')} — checked on the picture only.`);
	if (!tags.some((t) => t.role === 'fixed')) warnings.push('No fixed tag in view — a bumped camera cannot be told apart from the arm moving. Add a tag on the deck or the Opentron.');
	if (!tags.some((t) => t.role === 'arm')) warnings.push('No arm tag in view — this calibration cannot say anything about the arm itself.');
	if (det.intrinsics?.source === 'nominal') warnings.push('The Pi used nominal camera intrinsics (pyrealsense2 not available) — millimetres are approximate; movement is still caught.');

	let jointSteps: JointSteps | null = null;
	let pose: { x_mm: number; y_mm: number; z_mm: number } | null = null;
	try {
		({ steps: jointSteps, pose } = await readJointSteps());
	} catch (e) {
		warnings.push(`Arm encoders not read (${e instanceof Error ? e.message : String(e)}) — Return to home will be unavailable for this calibration.`);
	}

	let referenceImageKey: string | null = null;
	try {
		// Worker path, not direct S3: production's direct R2 credentials are
		// invalid (228ae7d2), and the Worker is what the rest of the app uses.
		const { uploadViaWorker } = await import('./services/r2');
		referenceImageKey = `robot-arm/tag-calibration/${o.cameraName}/${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`;
		await uploadViaWorker(det.frame, referenceImageKey, 'image/jpeg');
	} catch (e) {
		console.warn('[arm-vision] calibration frame not uploaded to R2:', e instanceof Error ? e.message : e);
		referenceImageKey = null;
	}

	const tolerances = cleanTolerances(o.tolerances);
	const _id = generateId();
	const now = new Date();
	const previous = (await RobotArmTagCalibration.find({ cameraName: o.cameraName, status: 'active' }).select('_id').lean()) as any[];
	await RobotArmTagCalibration.create({
		_id,
		cameraName: o.cameraName,
		status: 'active',
		capturedAt: now,
		capturedBy: { _id: user._id, username: user.username },
		note: o.note ?? null,
		frameWidth: det.width,
		frameHeight: det.height,
		intrinsics: det.intrinsics,
		detector: det.detector,
		thumbnailDataUrl: await thumbnail(det.frame),
		referenceImageKey,
		tags,
		tolerances,
		jointSteps,
		pose
	});
	if (previous.length) {
		await RobotArmTagCalibration.updateMany(
			{ _id: { $in: previous.map((p) => p._id) } },
			{ $set: { status: 'superseded', supersededAt: now, supersededBy: _id } }
		);
	}
	await audit('robot_arm.vision.calibrate', 'robot_arm_tag_calibrations', _id, user, {
		cameraName: o.cameraName,
		tags: tags.map((t) => ({ tagId: t.tagId, name: t.name, role: t.role, sizeMm: t.sizeMm, t: t.pose?.t ?? null, depthMm: t.depthMm })),
		frame: { width: det.width, height: det.height },
		intrinsics: det.intrinsics,
		tolerances,
		jointSteps,
		supersedes: previous.map((p) => p._id),
		referenceImageKey,
		warnings
	});
	const doc = await RobotArmTagCalibration.findById(_id).lean();
	return { summary: calibrationSummary(doc, { withThumb: true }), warnings };
}

/** Retire the active calibration for a camera without replacing it. */
export async function retireCalibration(user: User, id: string): Promise<boolean> {
	await connectDB();
	const res = await RobotArmTagCalibration.updateOne({ _id: id, status: 'active' }, { $set: { status: 'superseded', supersededAt: new Date(), supersededBy: null } });
	if (res.modifiedCount) await audit('robot_arm.vision.retire', 'robot_arm_tag_calibrations', id, user, {});
	return res.modifiedCount > 0;
}

// ── check / return ───────────────────────────────────────────────────────

export interface HomeCheckResult {
	calibrationId: string;
	cameraName: string;
	home: HomeAssessment;
	vision: VisionAssessment | null;
	residuals: Record<string, number> | null;
	message: string;
	/** What the camera saw during this check. */
	snapshotDataUrl: string | null;
	warnings: string[];
	/** Return only: the jogs that were sent. */
	moved: { sid: number; delta: number }[];
}

async function loadActive(cameraName?: string | null): Promise<any> {
	await connectDB();
	const q: Record<string, unknown> = { status: 'active' };
	if (cameraName) q.cameraName = cameraName;
	const doc = (await RobotArmTagCalibration.findOne(q).sort({ capturedAt: -1 }).lean()) as any;
	if (!doc) throw new Error('no vision calibration yet — park the arm at home and calibrate the tags first');
	return doc;
}

/** Detect every tag in a fresh frame and compare with the calibration. */
async function visionCheck(doc: any): Promise<{ vision: VisionAssessment | null; snapshotDataUrl: string | null; warnings: string[] }> {
	const summary = calibrationSummary(doc, { withThumb: false });
	if (!summary.tags.length) return { vision: null, snapshotDataUrl: null, warnings: ['This calibration has no tags.'] };
	let det: DetectResult;
	try {
		det = await detectTags(summary.cameraName, { includeFrame: true });
	} catch (e) {
		return { vision: null, snapshotDataUrl: null, warnings: [`Camera check skipped: ${e instanceof Error ? e.message : String(e)}`] };
	}
	if (!det.available) return { vision: null, snapshotDataUrl: null, warnings: [`Camera check skipped: ${det.reason ?? 'no detection'}`] };
	const warnings: string[] = [];
	if (det.width !== summary.frameWidth || det.height !== summary.frameHeight) {
		warnings.push(`The stream is ${det.width}×${det.height} but the calibration was ${summary.frameWidth}×${summary.frameHeight} — poses are compared in mm, picture offsets may read wrong; recalibrate at the new resolution.`);
	}
	const vision = assessTags(summary.tags, det.tags, summary.tolerances);
	return { vision, snapshotDataUrl: det.frame ? await thumbnail(det.frame) : null, warnings };
}

function homeMessage(home: HomeAssessment, vision: VisionAssessment | null, r: Residuals | null): string {
	const v = vision ? describeVision(vision) : null;
	switch (home.verdict) {
		case 'home':
			return [r ? `Encoders within ${r.max} steps of home.` : null, v].filter(Boolean).join(' ') || 'At home.';
		case 'camera_moved':
			return v ?? 'The camera has moved — recalibrate.';
		case 'position_off':
			return `Encoders are ${r?.max} steps from home on joint(s) ${r?.off.join(', ')} — the arm did not land. ${v ?? ''}`.trim();
		case 'markers_off':
			return `Encoders say home but the tags disagree. ${v}`;
		case 'position_off_and_markers_off':
			return `Not at home: encoders ${r?.max} steps off and ${v ? v.charAt(0).toLowerCase() + v.slice(1) : 'the tags disagree.'}`;
		case 'unverified':
			return 'Nothing could be checked — no encoder target and no camera result.';
	}
}

async function recordCheck(doc: any, user: User, kind: 'check' | 'return' | 'agent', result: Omit<HomeCheckResult, 'message' | 'snapshotDataUrl'>, extra: Record<string, unknown>) {
	const now = new Date();
	const shift = result.vision?.cameraShift;
	await RobotArmTagCalibration.updateOne(
		{ _id: doc._id },
		{
			$set: {
				lastCheck: {
					at: now,
					by: { _id: user._id, username: user.username },
					kind,
					verdict: result.home.verdict,
					visionVerdict: result.vision?.verdict ?? null,
					residualMax: result.home.residualMax != null && Number.isFinite(result.home.residualMax) ? result.home.residualMax : null,
					cameraShiftMm: shift?.compensated ? shift.mm : null,
					markers: (result.vision?.markers ?? []).map((m) => ({ markerId: m.markerId, tagId: m.tagId, name: m.name, status: m.status, offMm: m.offMm, offDeg: m.offDeg }))
				}
			}
		}
	);
	await audit(`robot_arm.vision.${kind}`, 'robot_arm_tag_calibrations', String(doc._id), user, {
		verdict: result.home.verdict,
		visionVerdict: result.vision?.verdict ?? null,
		cameraShift: shift ?? null,
		markers: result.vision?.markers.map((m) => ({ tagId: m.tagId, name: m.name, status: m.status, offMm: m.offMm, offDeg: m.offDeg })),
		residuals: result.residuals,
		warnings: result.warnings,
		...extra
	});
}

/** No motion: are the encoders and every tag where they were at calibration? */
export async function checkHome(user: User, o: { cameraName?: string | null; kind?: 'check' | 'agent' } = {}): Promise<HomeCheckResult> {
	const doc = await loadActive(o.cameraName);
	const target = jointStepsOf(doc);
	const warnings: string[] = [];
	let r: Residuals | null = null;
	if (target) {
		try {
			r = residuals((await readJointSteps()).steps, target);
		} catch (e) {
			warnings.push(`Encoders not read: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	const cam = await visionCheck(doc);
	warnings.push(...cam.warnings);
	const home = assessHome(r, cam.vision);
	const result = { calibrationId: String(doc._id), cameraName: doc.cameraName, home, vision: cam.vision, residuals: r?.perJoint ?? null, warnings, moved: [] };
	await recordCheck(doc, user, o.kind ?? 'check', result, {});
	return { ...result, message: homeMessage(home, cam.vision, r), snapshotDataUrl: cam.snapshotDataUrl };
}

/**
 * Return to home: torque on, one bounded jog per joint to the calibrated
 * encoder steps, settle, then verify with the encoders AND the tags.
 * Refused while a session holds the bus. The move itself goes by the encoders
 * alone, so a moved camera does not stop it. The arm WILL move.
 */
export async function returnToHome(user: User, o: { cameraName?: string | null } = {}): Promise<HomeCheckResult> {
	const doc = await loadActive(o.cameraName);
	const target = jointStepsOf(doc);
	if (!target) throw new Error('this calibration has no encoder home (the arm could not be read when it was taken) — recalibrate with the arm parked at home');
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
	const cam = await visionCheck(doc);
	const home = assessHome(r, cam.vision);
	const result = { calibrationId: String(doc._id), cameraName: doc.cameraName, home, vision: cam.vision, residuals: r.perJoint, warnings: cam.warnings, moved };
	await recordCheck(doc, user, 'return', result, { before: before.steps, after: after.steps, tolerance: HOME_STEP_TOLERANCE });
	const msg = homeMessage(home, cam.vision, r);
	return {
		...result,
		message: moved.length ? msg : `Arm was already within ${HOME_STEP_TOLERANCE} steps of home — nothing moved. ${msg}`,
		snapshotDataUrl: cam.snapshotDataUrl
	};
}
