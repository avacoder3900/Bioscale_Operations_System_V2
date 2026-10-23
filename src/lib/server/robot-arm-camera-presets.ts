/**
 * Robot arm — named camera-setting presets: the I/O half.
 *
 * A preset is a set of UVC control values for the arm camera, saved with the
 * lighting it was taken under, so the exposure that worked in one condition
 * can be found and re-applied later. The camera itself validates values when
 * a preset is applied (robot-arm-client setCameraControls → camera_controls.py
 * on the Pi); here we only keep and audit them.
 */
import { connectDB, AuditLog, generateId } from '$lib/server/db';
import { RobotArmCameraPreset } from '$lib/server/db/models';
import { robotArm, type CameraControl, type CameraControlsResponse } from './robot-arm-client';

interface User {
	_id: string;
	username: string;
}

export interface PresetSummary {
	_id: string;
	cameraName: string;
	name: string;
	conditions: string | null;
	notes: string | null;
	kind: 'camera-default' | 'operator';
	values: Record<string, number>;
	controls: Pick<CameraControl, 'id' | 'type' | 'min' | 'max' | 'step' | 'default' | 'value' | 'flags' | 'unit'>[];
	device: string | null;
	createdBy: { username?: string } | null;
	createdAt: string | null;
	lastAppliedAt: string | null;
	lastAppliedBy: { username?: string } | null;
	archivedAt: string | null;
}

const NAME_MAX = 120;
const TEXT_MAX = 500;
const CONTROL_RE = /^[a-z0-9_]{1,64}$/;

function valuesOf(raw: unknown): Record<string, number> {
	const src = raw instanceof Map ? Object.fromEntries(raw) : (raw as Record<string, unknown>) ?? {};
	const out: Record<string, number> = {};
	for (const [k, v] of Object.entries(src)) if (typeof v === 'number') out[k] = v;
	return out;
}

function summary(d: any): PresetSummary {
	return {
		_id: String(d._id),
		cameraName: d.cameraName,
		name: d.name,
		conditions: d.conditions ?? null,
		notes: d.notes ?? null,
		kind: d.kind === 'camera-default' ? 'camera-default' : 'operator',
		values: valuesOf(d.values),
		controls: Array.isArray(d.controls) ? d.controls.map((c: any) => ({ id: c.id, type: c.type, min: c.min, max: c.max, step: c.step, default: c.default, value: c.value, flags: c.flags ?? [], unit: c.unit ?? '' })) : [],
		device: d.device ?? null,
		createdBy: d.createdBy ?? null,
		createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : null,
		lastAppliedAt: d.lastAppliedAt ? new Date(d.lastAppliedAt).toISOString() : null,
		lastAppliedBy: d.lastAppliedBy ?? null,
		archivedAt: d.archivedAt ? new Date(d.archivedAt).toISOString() : null
	};
}

async function audit(action: string, recordId: string, user: User, newData: Record<string, unknown>) {
	await AuditLog.create({
		_id: generateId(),
		tableName: 'robot_arm_camera_presets',
		recordId,
		action,
		newData: { userId: user._id, ...newData },
		changedBy: user.username,
		changedAt: new Date()
	});
}

export async function listPresets(cameraName: string, o: { includeArchived?: boolean } = {}): Promise<PresetSummary[]> {
	await connectDB();
	const q: Record<string, unknown> = { cameraName };
	if (!o.includeArchived) q.archivedAt = null;
	const rows = await RobotArmCameraPreset.find(q).sort({ archivedAt: 1, createdAt: -1 }).lean();
	return rows.map(summary);
}

export interface PresetInput {
	name: string;
	conditions?: string | null;
	notes?: string | null;
	kind?: 'camera-default' | 'operator';
	/** Omitted = the camera's current values, read from the Pi now. */
	values?: Record<string, number> | null;
}

/** Validates the input; throws an Error with a message the panel can show. */
export function cleanPresetInput(input: PresetInput): Required<Pick<PresetInput, 'name' | 'kind'>> & { conditions: string | null; notes: string | null; values: Record<string, number> | null } {
	const name = String(input.name ?? '').trim();
	if (!name) throw new Error('Give the preset a name.');
	if (name.length > NAME_MAX) throw new Error(`Name is longer than ${NAME_MAX} characters.`);
	const conditions = input.conditions == null ? null : String(input.conditions).trim().slice(0, TEXT_MAX) || null;
	const notes = input.notes == null ? null : String(input.notes).trim().slice(0, TEXT_MAX) || null;
	const kind = input.kind === 'camera-default' ? 'camera-default' : 'operator';
	let values: Record<string, number> | null = null;
	if (input.values != null) {
		if (typeof input.values !== 'object' || Array.isArray(input.values)) throw new Error('values must map control names to numbers.');
		values = {};
		for (const [k, v] of Object.entries(input.values)) {
			if (!CONTROL_RE.test(k)) throw new Error(`"${k}" is not a control name.`);
			const n = typeof v === 'boolean' ? (v ? 1 : 0) : Number(v);
			if (!Number.isInteger(n)) throw new Error(`${k}: value must be a whole number.`);
			values[k] = n;
		}
		if (!Object.keys(values).length) throw new Error('values is empty.');
	}
	return { name, conditions, notes, kind, values };
}

/**
 * Save a preset. Without `values`, the camera's current values are read from
 * the Pi and stored, together with its control report (ranges and defaults).
 */
export async function savePreset(user: User, cameraName: string, input: PresetInput): Promise<PresetSummary> {
	const clean = cleanPresetInput(input);
	let values = clean.values;
	let controls: CameraControlsResponse['controls'] = [];
	let device: string | null = null;
	let report: CameraControlsResponse | null = null;
	try {
		report = await robotArm.getCameraControls(cameraName);
	} catch (err) {
		if (!values) throw new Error(`Could not read the camera to capture its values: ${(err as Error).message}`);
	}
	if (report?.available) {
		controls = report.controls;
		device = report.device;
		if (!values) {
			values = {};
			for (const c of report.controls) if (typeof c.value === 'number') values[c.id] = c.value;
		}
	} else if (!values) {
		throw new Error(report?.reason ?? 'The camera reported no controls to capture.');
	}
	await connectDB();
	const doc = await RobotArmCameraPreset.create({
		_id: generateId(),
		cameraName,
		name: clean.name,
		conditions: clean.conditions,
		notes: clean.notes,
		kind: clean.kind,
		values,
		controls: controls.map((c) => ({ id: c.id, type: c.type, min: c.min, max: c.max, step: c.step, default: c.default, value: c.value, flags: c.flags, unit: c.unit })),
		device,
		createdBy: { _id: user._id, username: user.username }
	});
	await audit('robot_arm.camera_preset.save', doc._id, user, { cameraName, name: clean.name, conditions: clean.conditions, kind: clean.kind, values });
	return summary(doc.toObject());
}

/** Write a preset's values to the camera (persisted on the Pi) and record the use. */
export async function applyPreset(user: User, cameraName: string, id: string): Promise<{ preset: PresetSummary; result: CameraControlsResponse }> {
	await connectDB();
	const doc = await RobotArmCameraPreset.findOne({ _id: id, cameraName, archivedAt: null }).lean();
	if (!doc) throw new Error('Preset not found.');
	const values = valuesOf((doc as any).values);
	if (!Object.keys(values).length) throw new Error('Preset holds no values.');
	const result = await robotArm.setCameraControls(cameraName, values, true);
	await RobotArmCameraPreset.updateOne({ _id: id }, { $set: { lastAppliedAt: new Date(), lastAppliedBy: { _id: user._id, username: user.username } } });
	await audit('robot_arm.camera_preset.apply', id, user, { cameraName, name: (doc as any).name, applied: result.applied ?? [], rejected: result.rejected ?? {} });
	const fresh = await RobotArmCameraPreset.findById(id).lean();
	return { preset: summary(fresh), result };
}

export async function archivePreset(user: User, cameraName: string, id: string, archived: boolean): Promise<PresetSummary> {
	await connectDB();
	const doc = await RobotArmCameraPreset.findOne({ _id: id, cameraName });
	if (!doc) throw new Error('Preset not found.');
	doc.archivedAt = archived ? new Date() : null;
	doc.archivedBy = archived ? { _id: user._id, username: user.username } : null;
	await doc.save();
	await audit(archived ? 'robot_arm.camera_preset.archive' : 'robot_arm.camera_preset.restore', id, user, { cameraName, name: doc.name });
	return summary(doc.toObject());
}
