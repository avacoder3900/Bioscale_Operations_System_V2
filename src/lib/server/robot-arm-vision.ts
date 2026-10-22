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
 *   GET  /servos                            encoder steps + load/temp/voltage/torque per servo (no IK)
 *   GET  /pose                              Cartesian pose, record only (501 until IK is ported)
 *   POST /torque, POST /servos/{id}/jog     return to home
 *
 * Calibration and checks rely on BOTH the servos and the camera: a save needs
 * a servo read on each side of the camera capture (and the two must agree),
 * and "home" needs the encoders and the arm tags to agree.
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
	baseOutOfRange,
	chunkJogPlan,
	degToSteps,
	planJogDeltas,
	residuals,
	stepsToDeg,
	strainedJoints,
	unsteadyJoints,
	DEFAULT_HOMING,
	GRIPPER_SERVO_ID,
	HOME_SERVO_IDS,
	HOME_STEP_TOLERANCE,
	LIFT_SERVO_ID,
	CLAW_STALL_STEPS,
	MAX_JOG_STEPS,
	type BaseOutOfRange,
	type HomeAssessment,
	type HomingSettings,
	type JointSteps,
	type Residuals,
	type ServoReading,
	type StrainedJoint
} from '$lib/robot-arm/home-calibration';

type User = { _id: string; username: string };

/** Settle time after each pass of jogs before the encoders are re-read. */
const SETTLE_MS = 800;
/** One attempt stops starting new jogs after this, leaving room for the camera check in Vercel's 30 s. */
const ATTEMPT_MOVE_BUDGET_MS = 20_000;
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
		pose: t.pose
			? {
					t: t.pose.t_mm,
					R: t.pose.R,
					reprojPx: t.pose.reproj_px ?? null,
					alt: t.pose.alt ? { t: t.pose.alt.t_mm, R: t.pose.alt.R, reprojPx: t.pose.alt.reproj_px ?? null } : null
				}
			: null,
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
	/** Servo state at home (load/temp are null when only /pose could be read). */
	servos: ServoReading[];
	homing: HomingSettings;
	supersededAt: string | null;
	lastCheck: {
		at: string;
		by: { username?: string } | null;
		kind: string;
		verdict: string;
		visionVerdict: string | null;
		residualMax: number | null;
		cameraShiftMm: number | null;
		markers: { markerId: string; tagId: number; name: string; status: string; offMm: number | null; offDeg: number | null; offTiltDeg: number | null; ambiguous: boolean }[];
		strained: StrainedJoint[];
	} | null;
}

function jointStepsOf(doc: any): JointSteps | null {
	const raw = doc.jointSteps instanceof Map ? Object.fromEntries(doc.jointSteps) : doc.jointSteps;
	if (!raw || typeof raw !== 'object' || !Object.keys(raw).length) return null;
	const out: JointSteps = {};
	for (const [k, v] of Object.entries(raw)) out[String(k)] = Number(v);
	return out;
}

function numOrNull(v: unknown): number | null {
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function servosOf(doc: any): ServoReading[] {
	return (doc.servos ?? []).map(
		(s: any): ServoReading => ({
			sid: Number(s.sid),
			steps: Number(s.steps),
			load: numOrNull(s.load),
			temperatureC: numOrNull(s.temperatureC),
			voltage: numOrNull(s.voltage),
			torque: typeof s.torque === 'boolean' ? s.torque : null
		})
	);
}

function strainedOf(list: any[] | undefined): StrainedJoint[] {
	return (list ?? []).map((s: any) => ({
		sid: Number(s.sid),
		load: numOrNull(s.load),
		temperatureC: numOrNull(s.temperatureC),
		reason: s.reason === 'hot' ? 'hot' : 'high_load'
	}));
}

function homingOf(doc: any): HomingSettings {
	const b = doc?.homing?.baseRangeSteps;
	const g = doc?.homing?.gripperOpenSteps;
	return {
		baseRangeSteps: Number.isFinite(b) && b > 0 ? b : DEFAULT_HOMING.baseRangeSteps,
		gripperOpenSteps: Number.isFinite(g) && g >= 0 ? g : DEFAULT_HOMING.gripperOpenSteps
	};
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
				pose:
					t.pose?.t?.length === 3 && t.pose?.R?.length === 9
						? {
								t: [t.pose.t[0], t.pose.t[1], t.pose.t[2]],
								R: [...t.pose.R],
								reprojPx: t.pose.reprojPx ?? null,
								alt:
									t.pose.alt?.t?.length === 3 && t.pose.alt?.R?.length === 9
										? { t: [t.pose.alt.t[0], t.pose.alt.t[1], t.pose.alt.t[2]], R: [...t.pose.alt.R], reprojPx: t.pose.alt.reprojPx ?? null }
										: null
							}
						: null,
				depthMm: t.depthMm ?? null
			})
		),
		tolerances: {
			positionMm: doc.tolerances?.positionMm ?? DEFAULT_TOLERANCES.positionMm,
			angleDeg: doc.tolerances?.angleDeg ?? DEFAULT_TOLERANCES.angleDeg,
			pixel: doc.tolerances?.pixel ?? DEFAULT_TOLERANCES.pixel
		},
		jointSteps: jointStepsOf(doc),
		servos: servosOf(doc),
		homing: homingOf(doc),
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
						offDeg: m.offDeg ?? null,
						offTiltDeg: m.offTiltDeg ?? null,
						ambiguous: m.ambiguous === true
					})),
					strained: strainedOf(doc.lastCheck.strained)
				}
			: null
	};
}

/**
 * Home as encoder steps per camera, servo ids 1..6 at index 0..5 (gripper
 * from the servo readings when present, else null), from each camera's
 * active calibration. The Animate pose editor draws it as the reference
 * marker above the sliders (ARM-09 follow-up, 2026-10-22).
 */
export async function homeStepsByCamera(): Promise<Record<string, (number | null)[]>> {
	await connectDB();
	const docs = (await RobotArmTagCalibration.find({ status: 'active' }).select('cameraName jointSteps servos').lean()) as any[];
	const out: Record<string, (number | null)[]> = {};
	for (const d of docs) {
		const steps = jointStepsOf(d);
		if (!steps) continue;
		const gripper = (d.servos ?? []).find((s: any) => Number(s.sid) === GRIPPER_SERVO_ID);
		out[d.cameraName] = [1, 2, 3, 4, 5].map((sid) => (Number.isFinite(steps[String(sid)]) ? steps[String(sid)] : null)).concat([gripper && Number.isFinite(Number(gripper.steps)) ? Number(gripper.steps) : null]);
	}
	return out;
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

export async function thumbnail(buf: Buffer): Promise<string> {
	const t = await sharp(buf).rotate().resize({ width: THUMB_WIDTH, withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer();
	return `data:image/jpeg;base64,${t.toString('base64')}`;
}

async function requireArmFree(): Promise<void> {
	const { active } = await robotArm.getActive();
	if (active) throw new Error(`the arm is busy (${active.kind} run ${active.run_id}) — stop it first`);
}

export interface ServoRead {
	steps: JointSteps;
	readings: ServoReading[];
	/** Which Pi route answered: /servos carries load/temp, /pose only steps. */
	source: 'servos' | 'pose';
}

function requireHomeJoints(steps: JointSteps): void {
	for (const sid of HOME_SERVO_IDS) {
		if (!Number.isFinite(steps[String(sid)])) throw new Error(`the arm did not report a position for servo ${sid}`);
	}
}

/**
 * Read the follower: GET /servos — raw per-servo state (steps + load/temp/
 * voltage/torque), no IK — falling back to GET /pose (steps only) when
 * /servos fails. On the current Pi /pose answers 501 until the IK stack is
 * ported, so the fallback rarely helps, but both report the same raw encoder
 * step. Throws when neither gives all of servos 1–5.
 */
export async function readServos(): Promise<ServoRead> {
	let servosErr: unknown;
	try {
		const list = await robotArm.listServos();
		if (!Array.isArray(list)) throw new Error('response was not a list');
		const readings: ServoReading[] = list
			.filter((s) => Number.isFinite(Number(s?.id)) && Number.isFinite(Number(s?.position)))
			.map((s) => ({
				sid: Number(s.id),
				steps: Number(s.position),
				load: numOrNull(s.load),
				temperatureC: numOrNull(s.temperature),
				voltage: numOrNull(s.voltage),
				torque: typeof s.torque === 'boolean' ? s.torque : null
			}));
		const steps: JointSteps = {};
		for (const r of readings) steps[String(r.sid)] = r.steps;
		requireHomeJoints(steps);
		return { steps, readings, source: 'servos' };
	} catch (e) {
		servosErr = e;
	}
	try {
		const p = await robotArm.getPose();
		const steps: JointSteps = {};
		for (const [k, v] of Object.entries(p.joint_steps ?? {})) steps[String(k)] = Number(v);
		requireHomeJoints(steps);
		const readings: ServoReading[] = Object.entries(steps).map(([k, v]) => ({ sid: Number(k), steps: v, load: null, temperatureC: null, voltage: null, torque: null }));
		return { steps, readings, source: 'pose' };
	} catch (e) {
		const msg = (x: unknown) => (x instanceof Error ? x.message : String(x));
		throw new Error(`the servos could not be read (GET /servos: ${msg(servosErr)}; GET /pose: ${msg(e)})`);
	}
}

function strainText(s: StrainedJoint[]): string {
	return s.map((j) => (j.reason === 'hot' ? `J${j.sid} is hot (${j.temperatureC} °C)` : `J${j.sid} is pushing hard (load ${j.load})`)).join(', ');
}

/** Cartesian pose for the record only; null while the Pi has no IK (/pose → 501). */
async function readCartesianPose(): Promise<{ x_mm: number; y_mm: number; z_mm: number } | null> {
	try {
		const p = await robotArm.getPose();
		return [p.x_mm, p.y_mm, p.z_mm].every(Number.isFinite) ? { x_mm: p.x_mm, y_mm: p.y_mm, z_mm: p.z_mm } : null;
	} catch {
		return null;
	}
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
 * Save a calibration with the arm parked at home. It relies on the servos AND
 * the camera; if either cannot be read, nothing is saved.
 *
 *   1. Read the servos (steps, plus load/temp when /servos answers).
 *   2. One fresh AprilTag detection on the Pi.
 *   3. Read the servos again. If any joint moved past the home tolerance
 *      between the two reads, the frame and the encoders do not describe the
 *      same pose — refused.
 *
 * Every registered tag found is stored with its pose (unregistered tags are
 * ignored; register them first). At least one arm tag must be in view. The
 * encoder steps become the Return-to-home target, and the servo loads the
 * baseline that later checks compare against.
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

	// Servos on both sides of the camera capture, so they describe the frame.
	const servoErr = (e: unknown) => new Error(`${e instanceof Error ? e.message : String(e)} — a calibration needs the servos as well as the camera`);
	const before = await readServos().catch((e) => {
		throw servoErr(e);
	});
	const det = await detectTags(o.cameraName, { includeFrame: true, registry });
	if (!det.available) throw new Error(det.reason ?? 'the Pi could not detect tags');
	if (!det.frame) throw new Error('the Pi did not return the frame it detected on');
	const servos = await readServos().catch((e) => {
		throw servoErr(e);
	});
	const unsteady = unsteadyJoints(before.steps, servos.steps);
	if (unsteady.length) {
		throw new Error(
			`the arm moved while the camera was capturing (joint ${unsteady.map((sid) => `${sid}: ${before.steps[String(sid)]} → ${servos.steps[String(sid)]}`).join(', ')} steps) — let it settle at home and save again`
		);
	}
	const captureDriftSteps = Math.max(0, ...HOME_SERVO_IDS.map((sid) => Math.abs(servos.steps[String(sid)] - before.steps[String(sid)])));

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
	if (!tags.some((t) => t.role === 'arm')) {
		throw new Error('no arm tag is in view — the camera half of the calibration would say nothing about the arm. Register a tag on the arm, or bring one into view');
	}

	const unregistered = det.tags.filter((d) => !byTagId.has(d.id)).map((d) => d.id);
	if (unregistered.length) warnings.push(`Seen but not registered, so not calibrated: tag ${unregistered.join(', ')}.`);
	const seen = new Set(tags.map((t) => t.tagId));
	const unseen = registry.filter((t) => !seen.has(t.tagId));
	if (unseen.length) warnings.push(`Registered but not visible, so not calibrated: ${unseen.map((t) => `${t.name} (tag ${t.tagId})`).join(', ')}.`);
	const noPose = tags.filter((t) => !t.pose);
	if (noPose.length) warnings.push(`No pose for ${noPose.map((t) => t.name).join(', ')} — checked on the picture only.`);
	if (!tags.some((t) => t.role === 'fixed')) warnings.push('No fixed tag in view — a bumped camera cannot be told apart from the arm moving. Add a tag on the deck or the Opentron.');
	if (det.intrinsics?.source === 'nominal') warnings.push('The Pi used nominal camera intrinsics (pyrealsense2 not available) — millimetres are approximate; movement is still caught.');
	if (servos.source === 'pose') warnings.push('Servo load and temperature were not available (GET /servos failed, steps came from /pose) — checks will catch a missed position but cannot say a joint is blocked.');
	const strainedAtHome = strainedJoints(servos.readings);
	if (strainedAtHome.length) {
		warnings.push(`At home, ${strainText(strainedAtHome)}. Make sure nothing is pressing on the arm — saved as the baseline anyway.`);
	}

	const jointSteps: JointSteps = {};
	for (const sid of HOME_SERVO_IDS) jointSteps[String(sid)] = servos.steps[String(sid)];
	const pose = await readCartesianPose();

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
	const previous = (await RobotArmTagCalibration.find({ cameraName: o.cameraName, status: 'active' }).select('_id homing').lean()) as any[];
	// Home settings are about the arm, not the picture: keep them across recalibrations.
	const homing = homingOf(previous[0]);
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
		servos: servos.readings,
		servoSource: servos.source,
		captureDriftSteps,
		homing,
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
		servos: servos.readings,
		servoSource: servos.source,
		captureDriftSteps,
		supersedes: previous.map((p) => p._id),
		referenceImageKey,
		warnings
	});
	const doc = await RobotArmTagCalibration.findById(_id).lean();
	return { summary: calibrationSummary(doc, { withThumb: true }), warnings };
}

/**
 * Change the Return-to-home settings on a camera's active calibration:
 * servo 1's safe range (± degrees of home) and how far the mouth opens.
 */
export async function updateHoming(user: User, id: string, input: { baseRangeDeg?: number | null; gripperOpenSteps?: number | null }): Promise<HomingSettings> {
	await connectDB();
	const doc = (await RobotArmTagCalibration.findOne({ _id: id, status: 'active' }).select('homing').lean()) as any;
	if (!doc) throw new Error('That calibration is no longer active — reload the page.');
	const deg = Number(input.baseRangeDeg);
	if (!Number.isFinite(deg) || deg <= 0 || deg > 180) throw new Error('Servo 1 range must be between 0 and 180 degrees either side of home.');
	const open = Number(input.gripperOpenSteps);
	if (!Number.isInteger(open) || open < 0 || open > MAX_JOG_STEPS) throw new Error(`Mouth opening must be a whole number of steps, 0–${MAX_JOG_STEPS} (0 = don't open).`);
	const before = homingOf(doc);
	const after: HomingSettings = { baseRangeSteps: degToSteps(deg), gripperOpenSteps: open };
	await RobotArmTagCalibration.updateOne({ _id: id }, { $set: { homing: after } });
	await audit('robot_arm.vision.homing', 'robot_arm_tag_calibrations', id, user, { before, after });
	return after;
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
	/** Return only: net steps sent per servo this attempt. */
	moved: { sid: number; delta: number }[];
	/** Return only: which attempt of the browser's loop this was (1-based). */
	attempt?: number;
	/** Return only: jogs sent this attempt. */
	jogs?: number;
	/** Return only: servo 1 was out of its safe range — nothing moved, torque dropped. */
	frozen?: (BaseOutOfRange & { torqueOff: boolean }) | null;
	/** Return only: the claw closed this attempt (null = no claw reading). */
	clawClosed?: boolean | null;
	/** Return only: this attempt ended early because the operator pressed Stop returning. */
	stopped?: boolean;
	elapsedMs?: number;
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

/**
 * The verdict in words, naming the likely failure: a joint short of home that
 * is also pushing hard is blocked (a rigid object, or it cannot extend); the
 * encoders at home with the arm tags elsewhere means the servo turned but the
 * arm did not follow (a broken or slipped printed part).
 */
function homeMessage(home: HomeAssessment, vision: VisionAssessment | null, r: Residuals | null, ctx: { hasTarget: boolean }): string {
	const v = vision ? describeVision(vision) : null;
	const offStrained = r ? home.strained.filter((s) => r.off.includes(s.sid)) : [];
	const blocked = offStrained.length ? ` ${strainText(offStrained)} — something is blocking it (a rigid object in the way, or the joint cannot fully extend). Clear it before moving the arm again.` : '';
	const note = home.strained.length && !offStrained.length ? ` Note: ${strainText(home.strained)}.` : '';
	switch (home.verdict) {
		case 'home':
			return `At home: encoders within ${r?.max} steps and the arm tags agree. ${v ?? ''}${note}`.trim();
		case 'camera_moved':
			return v ?? 'The camera has moved — recalibrate.';
		case 'position_off':
			return `Encoders are ${r?.max} steps from home on joint(s) ${r?.off.join(', ')} — the arm did not land.${blocked} ${v ?? ''}${note}`.trim();
		case 'markers_off':
			return `${home.landed ? 'Encoders say home but the tags disagree — the servos turned but the arm is not where they say: look for a broken or slipped 3D-printed part, a loose servo horn, or a tag that came loose.' : 'The tags disagree with home.'} ${v}${note}`.trim();
		case 'position_off_and_markers_off':
			return `Not at home: encoders ${r?.max} steps off and ${v ? v.charAt(0).toLowerCase() + v.slice(1) : 'the tags disagree.'}${blocked}${note}`;
		case 'unverified': {
			const missing: string[] = [];
			if (home.landed === null) missing.push(ctx.hasTarget ? 'the servos could not be read' : 'this calibration has no encoder home (recalibrate)');
			if (home.markersOk === null) missing.push(vision ? 'no arm tag was tracked' : 'the camera check did not run');
			const ok = [home.landed ? `encoders within ${r?.max} steps` : null, home.markersOk ? 'arm tags agree' : null].filter(Boolean).join(', ');
			return `Not confirmed as home — ${missing.join(' and ')}. Home needs both the servos and the camera.${ok ? ` (Checked: ${ok}.)` : ''}${note}`;
		}
		case 'frozen':
			return 'Frozen: servo 1 is outside its safe range — return the arm to home by hand.';
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
					markers: (result.vision?.markers ?? []).map((m) => ({
						markerId: m.markerId,
						tagId: m.tagId,
						name: m.name,
						status: m.status,
						offMm: m.offMm,
						offDeg: m.offDeg,
						offTiltDeg: m.offTiltDeg,
						ambiguous: m.ambiguous
					})),
					strained: result.home.strained
				}
			}
		}
	);
	await audit(`robot_arm.vision.${kind}`, 'robot_arm_tag_calibrations', String(doc._id), user, {
		verdict: result.home.verdict,
		visionVerdict: result.vision?.verdict ?? null,
		cameraShift: shift ?? null,
		markers: result.vision?.markers.map((m) => ({ tagId: m.tagId, name: m.name, status: m.status, offMm: m.offMm, offDeg: m.offDeg, offTiltDeg: m.offTiltDeg, ambiguous: m.ambiguous })),
		residuals: result.residuals,
		strained: result.home.strained,
		warnings: result.warnings,
		...extra
	});
}

/**
 * No motion: are the encoders and every tag where they were at calibration?
 * Both are read; a side that cannot be read makes the verdict "unverified".
 */
export async function checkHome(user: User, o: { cameraName?: string | null; kind?: 'check' | 'agent' } = {}): Promise<HomeCheckResult> {
	const doc = await loadActive(o.cameraName);
	const target = jointStepsOf(doc);
	const warnings: string[] = [];
	let r: Residuals | null = null;
	let strained: StrainedJoint[] = [];
	if (!target) warnings.push('This calibration has no encoder home — recalibrate with the arm parked at home.');
	try {
		const now = await readServos();
		if (target) r = residuals(now.steps, target);
		strained = strainedJoints(now.readings, servosOf(doc));
	} catch (e) {
		warnings.push(`Servos not read: ${e instanceof Error ? e.message : String(e)}`);
	}
	const cam = await visionCheck(doc);
	warnings.push(...cam.warnings);
	const home = assessHome(r, cam.vision, strained);
	const result = { calibrationId: String(doc._id), cameraName: doc.cameraName, home, vision: cam.vision, residuals: r?.perJoint ?? null, warnings, moved: [] };
	await recordCheck(doc, user, o.kind ?? 'check', result, {});
	return { ...result, message: homeMessage(home, cam.vision, r, { hasTarget: !!target }), snapshotDataUrl: cam.snapshotDataUrl };
}

/**
 * One Return-to-home ATTEMPT. The arm WILL move (unless it freezes).
 *
 * Order (operator spec, 2026-10-21):
 *   0. Safety gate: servo 1 (base, "servo A") further than its safe range
 *      from home → move NOTHING, drop torque so a person can walk the arm
 *      home by hand, report `frozen`. (A head camera will handle this later.)
 *   1. Open the mouth (servo 6, +gripperOpenSteps) to release the cartridge —
 *      first attempt only, so repeats do not keep opening it.
 *   2. Servo 2 (shoulder lift, "servo B") to home on its own.
 *   3. All of servos 1–5 to home.
 *   4. Close the claw completely (until it stops moving), once every joint is home.
 * Every move goes in ≤300-step jogs (the Pi's cap) with settle + re-read +
 * correction passes — no jog limit. Each request only has a time slice so it
 * plus the camera check fits Vercel's 30 s; the Vision tab sends the next
 * attempt automatically until everything is home and the claw is closed, the
 * operator presses Stop, a freeze, or 90 s (shouldRetryHome).
 * Refused while a session holds the bus.
 */
export async function returnToHome(
	user: User,
	o: { cameraName?: string | null; attempt?: number; runId?: string | null } = {}
): Promise<HomeCheckResult> {
	const t0 = Date.now();
	const attempt = Number.isInteger(o.attempt) && o.attempt! > 0 ? o.attempt! : 1;
	const doc = await loadActive(o.cameraName);
	const target = jointStepsOf(doc);
	if (!target) throw new Error('this calibration has no encoder home (the arm could not be read when it was taken) — recalibrate with the arm parked at home');
	const homing = homingOf(doc);
	await requireArmFree();
	const before = await readServos();
	let lastReadings = before.readings;
	const base = { calibrationId: String(doc._id), cameraName: doc.cameraName, attempt };

	// 0. Safety gate.
	const out = baseOutOfRange(before.steps, target, homing.baseRangeSteps);
	if (out) {
		const warnings: string[] = [];
		let torqueOff = false;
		try {
			await robotArm.setTorque(false);
			torqueOff = true;
		} catch (e) {
			warnings.push(`Torque could NOT be turned off (${e instanceof Error ? e.message : String(e)}) — use the E-stop / Control tab before touching the arm.`);
		}
		const r = residuals(before.steps, target);
		const home: HomeAssessment = { verdict: 'frozen', landed: false, markersOk: null, residualMax: r.max, strained: strainedJoints(before.readings, servosOf(doc)) };
		const frozen = { ...out, torqueOff };
		const result = { ...base, home, vision: null, residuals: r.perJoint, warnings, moved: [], jogs: 0, frozen, elapsedMs: Date.now() - t0 };
		await recordCheck(doc, user, 'return', result, { before: before.steps, frozen, homing });
		return { ...result, message: frozenMessage(frozen), snapshotDataUrl: null };
	}

	await robotArm.setTorque(true);
	const warnings: string[] = [];
	const sent = new Map<number, number>();
	let jogs = 0;
	let current = before.steps;
	let budgetHit = false;

	const jog = async (sid: number, delta: number) => {
		try {
			await robotArm.jogJoint(sid, delta);
		} catch (e) {
			throw new Error(`servo ${sid} jog failed after ${jogs} jog(s): ${e instanceof Error ? e.message : String(e)}`);
		}
		jogs++;
		sent.set(sid, (sent.get(sid) ?? 0) + delta);
	};
	const settle = async () => {
		await new Promise((res) => setTimeout(res, SETTLE_MS));
		const read = await readServos();
		current = read.steps;
		lastReadings = read.readings;
	};
	const outOfTime = () => Date.now() - t0 > ATTEMPT_MOVE_BUDGET_MS;
	// Stop returning: the Vision tab writes this loop's runId to the
	// calibration (requestHomeStop); checked before every jog, so the attempt
	// ends within one jog and the tab can close the mouth straight away.
	let stopped = false;
	const stopRequested = async () => {
		if (stopped) return true;
		if (!o.runId) return false;
		const s = (await RobotArmTagCalibration.findById(doc._id).select('homeStopRunId').lean()) as any;
		stopped = s?.homeStopRunId === o.runId;
		return stopped;
	};
	/**
	 * Jog `sids` to home: ≤300-step chunks, settle, re-read, correct — as many
	 * passes as it takes (no jog limit). Only this request's time slice (or
	 * Stop) ends it; the browser's next attempt carries on from there.
	 */
	const phase = async (sids: readonly number[]) => {
		while (!budgetHit && !stopped) {
			const chunks = chunkJogPlan(planJogDeltas(current, target, HOME_STEP_TOLERANCE, sids));
			if (!chunks.length) return;
			for (const c of chunks) {
				if (outOfTime()) {
					budgetHit = true;
					break;
				}
				if (await stopRequested()) break;
				await jog(c.sid, c.delta);
			}
			await settle();
		}
	};

	// 1. Open the mouth (first attempt only).
	const g = String(GRIPPER_SERVO_ID);
	if (attempt === 1 && homing.gripperOpenSteps > 0 && !(await stopRequested())) {
		if (Number.isFinite(current[g])) {
			await jog(GRIPPER_SERVO_ID, Math.min(MAX_JOG_STEPS, homing.gripperOpenSteps));
			await settle();
		} else {
			warnings.push('The mouth (servo 6) did not report a position, so it was not opened.');
		}
	}
	// 2. Servo B, then 3. everything.
	await phase([LIFT_SERVO_ID]);
	await phase(HOME_SERVO_IDS);

	// 4. Last: close the claw completely — closing jogs until it stops moving
	// (the closed stop), then ease off 1 step so the servo is not left pushing
	// against the stop. Only once every joint is home.
	// If this attempt ends before the joints land, the Vision tab still closes
	// the claw afterwards (closeClaw) — the mouth is closed at the end every time.
	let r = residuals(current, target);
	let clawClosed: boolean | null = Number.isFinite(current[g]) ? false : null;
	if (stopped) warnings.push('Stopped by you — the arm stays where it is; closing the mouth next.');
	if (clawClosed === null) warnings.push('The claw (servo 6) did not report a position, so it was not closed.');
	else if (!r.off.length && !stopped) {
		const c = await closeClawToStop(t0 + ATTEMPT_MOVE_BUDGET_MS);
		jogs += c.jogs;
		sent.set(GRIPPER_SERVO_ID, (sent.get(GRIPPER_SERVO_ID) ?? 0) + c.delta);
		clawClosed = c.closed;
		const read = await readServos();
		current = read.steps;
		lastReadings = read.readings;
		r = residuals(current, target);
	}

	const moved = [...sent.entries()].sort(([a], [b]) => a - b).map(([sid, delta]) => ({ sid, delta }));
	// The camera check is only worth its seconds once the encoders say home.
	let cam: { vision: VisionAssessment | null; snapshotDataUrl: string | null; warnings: string[] } = { vision: null, snapshotDataUrl: null, warnings: [] };
	if (!r.off.length && !stopped) {
		cam = await visionCheck(doc);
		warnings.push(...cam.warnings);
	}
	const home = assessHome(r, cam.vision, strainedJoints(lastReadings, servosOf(doc)));
	const result = { ...base, home, vision: cam.vision, residuals: r.perJoint, warnings, moved, jogs, frozen: null, clawClosed, stopped, elapsedMs: Date.now() - t0 };
	await recordCheck(doc, user, 'return', result, { before: before.steps, after: current, jogs, attempt, clawClosed, stopped, tolerance: HOME_STEP_TOLERANCE });
	const msg = homeMessage(home, cam.vision, r, { hasTarget: true });
	return {
		...result,
		message: moved.length ? msg : `Arm was already within ${HOME_STEP_TOLERANCE} steps of home — nothing moved. ${msg}`,
		snapshotDataUrl: cam.snapshotDataUrl
	};
}

/**
 * Stop returning: mark this loop (runId) as stopped on the camera's active
 * calibration. The attempt in progress sees it before its next jog and ends;
 * the Vision tab then closes the mouth.
 */
export async function requestHomeStop(user: User, o: { cameraName?: string | null; runId: string }): Promise<void> {
	if (!o.runId || o.runId.length > 64) throw new Error('Stop request is missing its run id.');
	const doc = await loadActive(o.cameraName);
	await RobotArmTagCalibration.updateOne({ _id: doc._id }, { $set: { homeStopRunId: o.runId } });
	await audit('robot_arm.vision.return_stop', 'robot_arm_tag_calibrations', String(doc._id), user, { runId: o.runId });
}

/**
 * Close the claw (servo 6) completely: −300-step jogs until one moves it less
 * than CLAW_STALL_STEPS (the closed stop), then ease off 1 step so the servo
 * is not left pushing against the stop. Stops at `deadline` (ms epoch) with
 * closed=false; the caller tries again.
 */
async function closeClawToStop(deadline: number): Promise<{ closed: boolean; jogs: number; delta: number }> {
	const pos = async () => {
		const s = (await robotArm.listServos()).find((x) => x?.id === GRIPPER_SERVO_ID);
		if (!s || !Number.isFinite(s.position)) throw new Error('the claw (servo 6) did not report a position');
		return Number(s.position);
	};
	let jogs = 0;
	let delta = 0;
	let now = await pos();
	while (Date.now() < deadline) {
		await robotArm.jogJoint(GRIPPER_SERVO_ID, -MAX_JOG_STEPS);
		jogs++;
		delta -= MAX_JOG_STEPS;
		await new Promise((res) => setTimeout(res, SETTLE_MS));
		const next = await pos();
		const movedBy = Math.abs(next - now);
		now = next;
		if (movedBy < CLAW_STALL_STEPS) {
			await robotArm.jogJoint(GRIPPER_SERVO_ID, 1);
			return { closed: true, jogs: jogs + 1, delta: delta + 1 };
		}
	}
	return { closed: false, jogs, delta };
}

/**
 * The final step of every Return to home: the Vision tab calls this when its
 * loop ends with the claw still open (Stop pressed, 90 s cap, an error, or
 * the joints never landed). Torque on, close to the stop. Not after a freeze —
 * then torque stays off for the technician. Refused while a session holds
 * the bus. One request ≤ ~20 s; the tab repeats it until closed.
 */
export async function closeClaw(user: User, o: { cameraName?: string | null } = {}): Promise<{ closed: boolean; jogs: number; message: string }> {
	const doc = await loadActive(o.cameraName);
	await requireArmFree();
	await robotArm.setTorque(true);
	const c = await closeClawToStop(Date.now() + ATTEMPT_MOVE_BUDGET_MS);
	await audit('robot_arm.vision.close_claw', 'robot_arm_tag_calibrations', String(doc._id), user, { closed: c.closed, jogs: c.jogs, delta: c.delta });
	return { ...c, message: c.closed ? 'Claw closed.' : 'Claw still closing…' };
}

function frozenMessage(f: BaseOutOfRange & { torqueOff: boolean }): string {
	const where = Number.isFinite(f.offSteps)
		? `${Math.abs(stepsToDeg(f.offSteps)).toFixed(0)}° ${f.offSteps > 0 ? 'one way' : 'the other way'} from home (${f.offSteps > 0 ? '+' : ''}${f.offSteps} steps)`
		: 'at an unknown position (no reading)';
	return (
		`FROZEN: servo ${f.sid} (base) is ${where}, outside its ±${stepsToDeg(f.limitSteps).toFixed(0)}° safe range. Nothing moved. ` +
		(f.torqueOff
			? 'Torque is OFF so the arm can be moved by hand — return it to home by hand, then press Check without moving.'
			: 'Torque could not be turned off — stop the arm from the Control tab before touching it.')
	);
}
