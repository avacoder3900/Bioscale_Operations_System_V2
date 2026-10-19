/**
 * Robot arm — sticker-marker vision calibration (ARM-04): the I/O half.
 *
 * Pure decisions live in $lib/robot-arm/markers (tracking, verdicts) and
 * $lib/robot-arm/home-calibration (jog plan, encoder residuals), both
 * unit-tested. This module owns the marker registry, turns a frozen frame +
 * the operator's placements into a calibration, and runs the server-side
 * check that answers "is every tracked point where it was at home?" — the
 * backstop for a run that ends with the arm not back home.
 *
 * Pi calls (live arm-pi OpenAPI, 2026-10-19, plus the ARM-04 depth route):
 *   GET  /cameras/{name}/snapshot.jpg       frame to check against
 *   POST /cameras/{name}/depth/sample       depth at points (404 until installed)
 *   GET  /pose                              encoder steps, servos 1–5
 *   POST /torque, POST /servos/{id}/jog     return to home
 */
import sharp from 'sharp';
import { connectDB, AuditLog, generateId } from '$lib/server/db';
import { RobotArmMarker, RobotArmVisionCalibration } from '$lib/server/db/models';
import { robotArm } from './robot-arm-client';
import {
	assessMarkers,
	describeVision,
	hexToRgb,
	isLowSaturation,
	samplePatch,
	trackAll,
	DEFAULT_DEPTH_TOLERANCE_MM,
	DEFAULT_POSITION_TOLERANCE,
	type PixelImage,
	type Placement,
	type Rgb,
	type VisionAssessment
} from '$lib/robot-arm/markers';
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
/** Calibration frames above this are refused — a Pi snapshot is ~50–150 kB. */
export const MAX_FRAME_BYTES = 3 * 1024 * 1024;

// ── registry ─────────────────────────────────────────────────────────────

export interface MarkerSummary {
	_id: string;
	name: string;
	group: string | null;
	color: Rgb;
	notes: string | null;
	archived: boolean;
	createdAt: string | null;
}

function markerSummary(d: any): MarkerSummary {
	return {
		_id: String(d._id),
		name: d.name,
		group: d.group ?? null,
		color: { r: d.color?.r ?? 0, g: d.color?.g ?? 0, b: d.color?.b ?? 0 },
		notes: d.notes ?? null,
		archived: !!d.archivedAt,
		createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : null
	};
}

export async function listMarkers(): Promise<MarkerSummary[]> {
	await connectDB();
	const rows = await RobotArmMarker.find({}).sort({ archivedAt: 1, group: 1, name: 1 }).lean();
	return (rows as any[]).map(markerSummary);
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

function cleanMarkerInput(input: { name?: string | null; group?: string | null; color?: string | null; notes?: string | null }) {
	const name = (input.name ?? '').trim();
	if (!name) throw new Error('A marker needs a name.');
	if (name.length > 60) throw new Error('Marker names are limited to 60 characters.');
	const color = hexToRgb(input.color ?? '');
	if (!color) throw new Error('Pick the sticker colour.');
	const group = (input.group ?? '').trim() || null;
	const notes = (input.notes ?? '').trim() || null;
	return { name, group, color, notes };
}

async function assertNameFree(name: string, exceptId?: string) {
	const clash = await RobotArmMarker.findOne({
		archivedAt: null,
		name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
		...(exceptId ? { _id: { $ne: exceptId } } : {})
	})
		.select('_id')
		.lean();
	if (clash) throw new Error(`A marker called "${name}" already exists.`);
}

export async function createMarker(user: User, input: { name?: string | null; group?: string | null; color?: string | null; notes?: string | null }) {
	await connectDB();
	const m = cleanMarkerInput(input);
	await assertNameFree(m.name);
	const _id = generateId();
	await RobotArmMarker.create({ _id, ...m, createdBy: { _id: user._id, username: user.username } });
	await audit('robot_arm.marker.create', 'robot_arm_markers', _id, user, { ...m, lowSaturation: isLowSaturation(m.color) });
	return { _id, ...m };
}

export async function updateMarker(user: User, id: string, input: { name?: string | null; group?: string | null; color?: string | null; notes?: string | null }) {
	await connectDB();
	const before = (await RobotArmMarker.findById(id).lean()) as any;
	if (!before) throw new Error('Marker not found.');
	const m = cleanMarkerInput(input);
	await assertNameFree(m.name, id);
	await RobotArmMarker.updateOne({ _id: id }, { $set: m });
	await audit('robot_arm.marker.update', 'robot_arm_markers', id, user, {
		before: { name: before.name, group: before.group, color: before.color, notes: before.notes },
		after: m
	});
	return m;
}

export async function setMarkerArchived(user: User, id: string, archived: boolean) {
	await connectDB();
	const doc = (await RobotArmMarker.findById(id).lean()) as any;
	if (!doc) throw new Error('Marker not found.');
	if (!archived) await assertNameFree(doc.name, id);
	await RobotArmMarker.updateOne(
		{ _id: id },
		{ $set: archived ? { archivedAt: new Date(), archivedBy: { _id: user._id, username: user.username } } : { archivedAt: null, archivedBy: null } }
	);
	await audit(archived ? 'robot_arm.marker.archive' : 'robot_arm.marker.restore', 'robot_arm_markers', id, user, { name: doc.name });
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
	thumbnailDataUrl: string | null;
	placements: Placement[];
	depthAvailable: boolean;
	tolerances: { position: number; depthMm: number };
	jointSteps: JointSteps | null;
	supersededAt: string | null;
	lastCheck: {
		at: string;
		by: { username?: string } | null;
		kind: string;
		verdict: string;
		visionVerdict: string | null;
		residualMax: number | null;
		markers: { markerId: string; name: string; status: string; distance: number | null; depthDeltaMm: number | null }[];
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
		thumbnailDataUrl: o.withThumb ? (doc.thumbnailDataUrl ?? null) : null,
		placements: (doc.placements ?? []).map((p: any) => ({
			markerId: p.markerId,
			name: p.name,
			group: p.group ?? null,
			color: { r: p.color.r, g: p.color.g, b: p.color.b },
			x: p.x,
			y: p.y,
			depthMm: p.depthMm ?? null
		})),
		depthAvailable: !!doc.depthAvailable,
		tolerances: { position: doc.tolerances?.position ?? DEFAULT_POSITION_TOLERANCE, depthMm: doc.tolerances?.depthMm ?? DEFAULT_DEPTH_TOLERANCE_MM },
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
					markers: (doc.lastCheck.markers ?? []).map((m: any) => ({
						markerId: m.markerId,
						name: m.name,
						status: m.status,
						distance: m.distance ?? null,
						depthDeltaMm: m.depthDeltaMm ?? null
					}))
				}
			: null
	};
}

/** Active calibration per camera (with thumbnails) and the recent history (without). */
export async function loadCalibrations(): Promise<{ active: CalibrationSummary[]; history: CalibrationSummary[] }> {
	await connectDB();
	const [active, history] = await Promise.all([
		RobotArmVisionCalibration.find({ status: 'active' }).sort({ capturedAt: -1 }).lean(),
		RobotArmVisionCalibration.find({ status: 'superseded' })
			.select('-thumbnailDataUrl')
			.sort({ capturedAt: -1 })
			.limit(10)
			.lean()
	]);
	return {
		active: (active as any[]).map((d) => calibrationSummary(d, { withThumb: true })),
		history: (history as any[]).map((d) => calibrationSummary(d, { withThumb: false }))
	};
}

async function decodeFrame(buf: Buffer): Promise<PixelImage> {
	const { data, info } = await sharp(buf).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
	return { data, width: info.width, height: info.height, channels: 3 };
}

async function thumbnail(buf: Buffer): Promise<string> {
	const t = await sharp(buf).rotate().resize({ width: THUMB_WIDTH, withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer();
	return `data:image/jpeg;base64,${t.toString('base64')}`;
}

/**
 * One frame from the Pi camera. The Pi serves its worker's latest frame, so a
 * camera nobody is viewing may have none yet: one retry after a short wait
 * covers the worker spinning up.
 */
async function grabFrame(cameraName: string): Promise<Buffer> {
	let lastErr: unknown;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const { bytes } = await robotArm.getCameraSnapshot(cameraName);
			return Buffer.from(bytes);
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

/** Depth at normalised points; never throws (depth is optional). */
async function depthAt(cameraName: string, points: [number, number][]): Promise<{ depth: (number | null)[]; available: boolean; warning: string | null }> {
	if (!points.length) return { depth: [], available: false, warning: null };
	try {
		const s = await robotArm.sampleDepth(cameraName, points);
		const depth = points.map((_, i) => {
			const v = s.depth_mm?.[i];
			return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
		});
		return { depth, available: !!s.available, warning: s.available ? null : (s.reason ?? 'The camera reports no depth.') };
	} catch (e) {
		return { depth: points.map(() => null), available: false, warning: `Depth not read: ${e instanceof Error ? e.message : String(e)}` };
	}
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

export interface PlacementInput {
	markerId: string;
	x: number;
	y: number;
}

/**
 * Save a calibration from the frame the operator placed markers on.
 *
 * The frame is the exact JPEG the browser froze (not a fresh grab), so every
 * placement is on the picture the operator actually saw. Colours are sampled
 * here, server-side, from that frame — they are what tracking matches from now
 * on. Depth and the encoders are read live: the operator is told to keep the
 * arm parked at home until the save completes.
 */
export async function saveCalibration(
	user: User,
	o: {
		cameraName: string;
		frame: Buffer;
		placements: PlacementInput[];
		tolerances?: { position?: number | null; depthMm?: number | null };
		note?: string | null;
	}
): Promise<{ summary: CalibrationSummary; warnings: string[] }> {
	await connectDB();
	if (!o.cameraName) throw new Error('No camera selected.');
	if (!o.frame.length) throw new Error('No calibration frame was sent — freeze a frame first.');
	if (o.frame.length > MAX_FRAME_BYTES) throw new Error('The calibration frame is too large.');
	if (!o.placements.length) throw new Error('Place at least one marker before saving.');

	const ids = o.placements.map((p) => p.markerId);
	if (new Set(ids).size !== ids.length) throw new Error('A marker was placed twice.');
	for (const p of o.placements) {
		if (![p.x, p.y].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) throw new Error('A marker is outside the frame.');
	}
	const markers = (await RobotArmMarker.find({ _id: { $in: ids }, archivedAt: null }).lean()) as any[];
	const byId = new Map(markers.map((m) => [String(m._id), m]));
	const unknown = ids.filter((id) => !byId.has(id));
	if (unknown.length) throw new Error('One or more placed markers are archived or no longer exist — reload the page.');

	// The arm must be parked and idle: the encoders read now become "home".
	await requireArmFree();

	const warnings: string[] = [];
	const img = await decodeFrame(o.frame);
	const sampleR = Math.max(2, Math.round(img.width * 0.005));
	const placements: Placement[] = o.placements.map((p) => {
		const m = byId.get(p.markerId)!;
		const sampled = samplePatch(img, p.x * img.width, p.y * img.height, sampleR) ?? m.color;
		if (isLowSaturation(sampled)) warnings.push(`${m.name}: the sticker reads as nearly grey on camera, so it is tracked by brightness, not colour — expect it to be less reliable.`);
		return { markerId: p.markerId, name: m.name, group: m.group ?? null, color: sampled, x: p.x, y: p.y, depthMm: null };
	});

	const depth = await depthAt(o.cameraName, placements.map((p) => [p.x, p.y]));
	placements.forEach((p, i) => (p.depthMm = depth.depth[i]));
	if (depth.warning) warnings.push(`${depth.warning} Saved without depth; the check will use the picture only.`);
	else if (depth.depth.some((d) => d == null)) warnings.push(`No depth reading at: ${placements.filter((p) => p.depthMm == null).map((p) => p.name).join(', ')}.`);

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
		referenceImageKey = `robot-arm/vision-calibration/${o.cameraName}/${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`;
		await uploadViaWorker(o.frame, referenceImageKey, 'image/jpeg');
	} catch (e) {
		console.warn('[arm-vision] calibration frame not uploaded to R2:', e instanceof Error ? e.message : e);
		referenceImageKey = null;
	}

	const position = o.tolerances?.position;
	const depthMm = o.tolerances?.depthMm;
	const tolerances = {
		position: Number.isFinite(position) && position! > 0 && position! < 0.5 ? position! : DEFAULT_POSITION_TOLERANCE,
		depthMm: Number.isFinite(depthMm) && depthMm! > 0 && depthMm! < 1000 ? depthMm! : DEFAULT_DEPTH_TOLERANCE_MM
	};

	const _id = generateId();
	const now = new Date();
	const previous = (await RobotArmVisionCalibration.find({ cameraName: o.cameraName, status: 'active' }).select('_id').lean()) as any[];
	await RobotArmVisionCalibration.create({
		_id,
		cameraName: o.cameraName,
		status: 'active',
		capturedAt: now,
		capturedBy: { _id: user._id, username: user.username },
		note: o.note ?? null,
		frameWidth: img.width,
		frameHeight: img.height,
		thumbnailDataUrl: await thumbnail(o.frame),
		referenceImageKey,
		placements,
		depthAvailable: depth.available,
		tolerances,
		jointSteps,
		pose
	});
	if (previous.length) {
		await RobotArmVisionCalibration.updateMany(
			{ _id: { $in: previous.map((p) => p._id) } },
			{ $set: { status: 'superseded', supersededAt: now, supersededBy: _id } }
		);
	}
	await audit('robot_arm.vision.calibrate', 'robot_arm_vision_calibrations', _id, user, {
		cameraName: o.cameraName,
		placements: placements.map((p) => ({ markerId: p.markerId, name: p.name, x: p.x, y: p.y, depthMm: p.depthMm, color: p.color })),
		frame: { width: img.width, height: img.height },
		depthAvailable: depth.available,
		tolerances,
		jointSteps,
		supersedes: previous.map((p) => p._id),
		referenceImageKey,
		warnings
	});
	const doc = await RobotArmVisionCalibration.findById(_id).lean();
	return { summary: calibrationSummary(doc, { withThumb: true }), warnings };
}

/** Retire the active calibration for a camera without replacing it. */
export async function retireCalibration(user: User, id: string): Promise<boolean> {
	await connectDB();
	const res = await RobotArmVisionCalibration.updateOne({ _id: id, status: 'active' }, { $set: { status: 'superseded', supersededAt: new Date(), supersededBy: null } });
	if (res.modifiedCount) await audit('robot_arm.vision.retire', 'robot_arm_vision_calibrations', id, user, {});
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
	const doc = (await RobotArmVisionCalibration.findOne(q).sort({ capturedAt: -1 }).lean()) as any;
	if (!doc) throw new Error('no vision calibration yet — park the arm at home and calibrate the markers first');
	return doc;
}

/** Track every calibrated marker in a fresh frame and compare with the calibration. */
async function visionCheck(doc: any): Promise<{ vision: VisionAssessment | null; snapshotDataUrl: string | null; warnings: string[] }> {
	const summary = calibrationSummary(doc, { withThumb: false });
	if (!summary.placements.length) return { vision: null, snapshotDataUrl: null, warnings: ['This calibration has no markers placed.'] };
	const warnings: string[] = [];
	let buf: Buffer;
	try {
		buf = await grabFrame(summary.cameraName);
	} catch (e) {
		return { vision: null, snapshotDataUrl: null, warnings: [`Camera check skipped: ${e instanceof Error ? e.message : String(e)}`] };
	}
	const img = await decodeFrame(buf);
	const observations = trackAll(img, summary.placements);
	if (summary.depthAvailable) {
		const found = observations.filter((o) => o.x != null && o.y != null);
		const d = await depthAt(summary.cameraName, found.map((o) => [o.x!, o.y!]));
		found.forEach((o, i) => (o.depthMm = d.depth[i]));
		if (d.warning) warnings.push(`${d.warning} Checked on the picture only.`);
	}
	const vision = assessMarkers(summary.placements, observations, summary.tolerances);
	return { vision, snapshotDataUrl: await thumbnail(buf), warnings };
}

function homeMessage(home: HomeAssessment, vision: VisionAssessment | null, r: Residuals | null, frameWidth: number): string {
	const v = vision ? describeVision(vision, frameWidth) : null;
	switch (home.verdict) {
		case 'home':
			return [r ? `Encoders within ${r.max} steps of home.` : null, v].filter(Boolean).join(' ') || 'At home.';
		case 'camera_moved':
			return v ?? 'The camera has moved — recalibrate.';
		case 'position_off':
			return `Encoders are ${r?.max} steps from home on joint(s) ${r?.off.join(', ')} — the arm did not land. ${v ?? ''}`.trim();
		case 'markers_off':
			return `Encoders say home but the markers disagree. ${v}`;
		case 'position_off_and_markers_off':
			return `Not at home: encoders ${r?.max} steps off and ${v ? v.charAt(0).toLowerCase() + v.slice(1) : 'the markers disagree.'}`;
		case 'unverified':
			return 'Nothing could be checked — no encoder target and no camera result.';
	}
}

async function recordCheck(doc: any, user: User, kind: 'check' | 'return' | 'agent', result: Omit<HomeCheckResult, 'message' | 'snapshotDataUrl'>, extra: Record<string, unknown>) {
	const now = new Date();
	await RobotArmVisionCalibration.updateOne(
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
					markers: (result.vision?.markers ?? []).map((m) => ({ markerId: m.markerId, name: m.name, status: m.status, distance: m.distance, depthDeltaMm: m.depthDeltaMm }))
				}
			}
		}
	);
	await audit(`robot_arm.vision.${kind}`, 'robot_arm_vision_calibrations', String(doc._id), user, {
		verdict: result.home.verdict,
		visionVerdict: result.vision?.verdict ?? null,
		markers: result.vision?.markers.map((m) => ({ name: m.name, status: m.status, distance: m.distance, depthDeltaMm: m.depthDeltaMm })),
		residuals: result.residuals,
		warnings: result.warnings,
		...extra
	});
}

/** No motion: are the encoders and every marker where they were at calibration? */
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
	return { ...result, message: homeMessage(home, cam.vision, r, doc.frameWidth), snapshotDataUrl: cam.snapshotDataUrl };
}

/**
 * Return to home: torque on, one bounded jog per joint to the calibrated
 * encoder steps, settle, then verify with the encoders AND the markers.
 * Refused while a session holds the bus. The move itself goes by the encoders
 * alone, so a moved camera does not stop it — it only makes the marker half of
 * the verdict `camera_moved`. The arm WILL move.
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
	const msg = homeMessage(home, cam.vision, r, doc.frameWidth);
	return {
		...result,
		message: moved.length ? msg : `Arm was already within ${HOME_STEP_TOLERANCE} steps of home — nothing moved. ${msg}`,
		snapshotDataUrl: cam.snapshotDataUrl
	};
}
