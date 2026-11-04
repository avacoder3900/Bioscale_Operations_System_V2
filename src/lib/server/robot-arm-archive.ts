/**
 * Robot Arm archive = R2 trash, 30 days (Alejandro, 2026-11-04).
 *
 * Pressing Archive (or Retire, or recapturing a reference that replaces an old
 * one) moves the item out of Mongo into R2: BIMS uploads a JSON copy through
 * the R2 Worker, downloads it back and compares it byte for byte
 * (uploadVerified), writes a RobotArmArchiveEntry row (the trash list), and
 * only then deletes the item from its collection. For 30 days it can be
 * restored from R2; then the daily cron (/api/cron/purge-robot-arm-archive)
 * deletes the R2 object and marks the row purged. Nothing is kept after that.
 *
 * In use = refused: a pose in a move set, a move set in a sequence, a move set
 * or sequence chosen as a Run (wax fill) animation. The refusal names every
 * user (ArchiveInUseError.users), so they can all be cleared at once.
 *
 * Covered kinds: pose (with its camera references), move set, sequence,
 * pose camera reference, Arm Home calibration, camera preset, recording
 * clean-up. AprilTags are not archived this way (reassigned, never deleted).
 */
import { createHash } from 'node:crypto';
import { connectDB } from '$lib/server/db/connection';
import { AuditLog, generateId } from '$lib/server/db';
import {
	ArmWaxFillSettings,
	RobotArmArchiveEntry,
	RobotArmCameraPreset,
	RobotArmMoveSet,
	RobotArmPose,
	RobotArmPoseCalibration,
	RobotArmRecordingCleanup,
	RobotArmSequence,
	RobotArmTagCalibration
} from '$lib/server/db/models';
import { deleteViaWorker, downloadViaWorker, uploadViaWorker } from '$lib/server/services/r2';

export const ARCHIVE_DAYS = 30;
const R2_PREFIX = 'robot-arm/archive';
const DAY_MS = 24 * 60 * 60 * 1000;

export type ArchiveKind = 'pose' | 'move_set' | 'sequence' | 'pose_calibration' | 'tag_calibration' | 'camera_preset' | 'cleanup';

/* eslint-disable @typescript-eslint/no-explicit-any */
const MODEL: Record<ArchiveKind, any> = {
	pose: RobotArmPose,
	move_set: RobotArmMoveSet,
	sequence: RobotArmSequence,
	pose_calibration: RobotArmPoseCalibration,
	tag_calibration: RobotArmTagCalibration,
	camera_preset: RobotArmCameraPreset,
	cleanup: RobotArmRecordingCleanup
};
/** Documents that travel with an item (a pose's camera references), by name in the R2 copy. */
const RELATED: Record<string, any> = { poseCalibrations: RobotArmPoseCalibration };

type User = { _id: string; username: string };
const opRef = (u: User) => ({ _id: u._id, username: u.username });
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Upload, then read the object back and compare; throws unless R2 holds exactly `buffer`. */
export async function uploadVerified(buffer: Buffer, key: string, contentType: string): Promise<void> {
	await uploadViaWorker(buffer, key, contentType);
	const back = await downloadViaWorker(key);
	if (back.length !== buffer.length || sha256(back) !== sha256(buffer)) {
		throw new Error(`R2 copy of ${key} does not match what was uploaded (${back.length} of ${buffer.length} bytes)`);
	}
}

export class ArchiveError extends Error {
	constructor(
		message: string,
		public status = 400
	) {
		super(message);
	}
}

/** Archive refused: the item is still used. `users` lists every one of them. */
export class ArchiveInUseError extends ArchiveError {
	constructor(
		public itemName: string,
		public users: string[]
	) {
		super(`"${itemName}" is still used by ${users.join(', ')}. Remove it there first.`, 409);
	}
}

const RUN_SLOTS = [
	['grabAnimation', 'Run Grab animation'],
	['withdrawAnimation', 'Run Withdraw animation'],
	['failAnimation', 'Run Fail animation']
] as const;

/** Everything that still uses this item; empty = free to archive. */
export async function whoUses(kind: ArchiveKind, id: string): Promise<string[]> {
	await connectDB();
	const out: string[] = [];
	if (kind === 'pose') {
		const sets = (await RobotArmMoveSet.find({ 'keyframes.poseId': id }).select('name').lean()) as any[];
		for (const s of sets) out.push(`move set "${s.name}"`);
	}
	if (kind === 'move_set') {
		const seqs = (await RobotArmSequence.find({ 'items.moveSetId': id }).select('name').lean()) as any[];
		for (const s of seqs) out.push(`sequence "${s.name}"`);
	}
	if (kind === 'move_set' || kind === 'sequence') {
		const s = (await ArmWaxFillSettings.findById('default').select('grabAnimation withdrawAnimation failAnimation').lean()) as any;
		for (const [field, label] of RUN_SLOTS) if (s?.[field]?.kind === kind && s[field].id === id) out.push(label);
	}
	return out;
}

/**
 * Move one item to the R2 trash. `related` names documents that go with it
 * and come back with it (a pose's camera references). Throws ArchiveInUseError
 * while something uses it, and leaves everything as it was if the R2 copy
 * cannot be proven.
 */
export async function archiveToR2(
	user: User,
	kind: ArchiveKind,
	id: string,
	o: { name?: string; meta?: Record<string, unknown> | ((doc: any) => Record<string, unknown>); related?: Record<string, object>; archivedAt?: Date; skipInUse?: boolean } = {}
): Promise<{ entryId: string; expiresAt: Date }> {
	await connectDB();
	const doc = (await MODEL[kind].findById(id).lean()) as any;
	if (!doc) throw new ArchiveError('Not found.', 404);
	const name = o.name ?? String(doc.name ?? doc.cameraName ?? id);
	if (!o.skipInUse) {
		const users = await whoUses(kind, id);
		if (users.length) throw new ArchiveInUseError(name, users);
	}
	const related: Record<string, any[]> = {};
	for (const [key, filter] of Object.entries(o.related ?? {})) related[key] = await RELATED[key].find(filter).lean();

	const entryId = generateId();
	const archivedAt = o.archivedAt ?? new Date();
	const expiresAt = new Date(archivedAt.getTime() + ARCHIVE_DAYS * DAY_MS);
	const r2Key = `${R2_PREFIX}/${kind}/${id}-${entryId}.json`;
	const body = Buffer.from(JSON.stringify({ kind, itemId: id, archivedAt: archivedAt.toISOString(), doc, related }), 'utf8');
	try {
		await uploadVerified(body, r2Key, 'application/json');
	} catch (err) {
		throw new ArchiveError(`Could not save "${name}" to R2, so it was not archived: ${(err as Error).message}`, 502);
	}
	const meta = typeof o.meta === 'function' ? o.meta(doc) : (o.meta ?? {});
	await RobotArmArchiveEntry.create({ _id: entryId, kind, itemId: id, name, r2Key, sizeBytes: body.length, meta, archivedAt, archivedBy: opRef(user), expiresAt });
	try {
		for (const [key, filter] of Object.entries(o.related ?? {})) await RELATED[key].deleteMany(filter);
		await MODEL[kind].deleteOne({ _id: id });
	} catch (err) {
		// The item is still in Mongo: undo the trash row and the R2 copy.
		await RobotArmArchiveEntry.updateOne({ _id: entryId }, { $set: { restoredAt: new Date(), restoredBy: opRef(user) } });
		await deleteViaWorker(r2Key).catch(() => {});
		throw new ArchiveError(`"${name}" was not archived: ${(err as Error).message}`, 500);
	}
	await AuditLog.create({
		_id: generateId(),
		tableName: 'robot_arm_archive_entries',
		recordId: entryId,
		action: 'robot_arm.archive.to_r2',
		newData: { kind, itemId: id, name, r2Key, expiresAt: expiresAt.toISOString(), related: Object.fromEntries(Object.entries(related).map(([k, v]) => [k, v.length])), userId: user._id },
		changedBy: user.username
	});
	return { entryId, expiresAt };
}

/**
 * Move superseded references / calibrations to the R2 trash right after they
 * were superseded. Never throws: a copy that cannot be proven leaves the item
 * superseded in Mongo, and the error is logged and returned.
 */
export async function archiveSuperseded(
	user: User,
	kind: 'pose_calibration' | 'tag_calibration',
	ids: string[],
	meta?: (doc: any) => Record<string, unknown>
): Promise<string[]> {
	const errors: string[] = [];
	for (const id of ids) {
		try {
			await archiveToR2(user, kind, id, { skipInUse: true, ...(meta ? { meta } : {}) });
		} catch (err) {
			errors.push(`${id}: ${(err as Error).message}`);
			console.error(`[robot-arm-archive] ${kind} ${id} stays superseded in Mongo: ${(err as Error).message}`);
		}
	}
	return errors;
}

/** Calibration History rows: what the Arm Home history list shows, kept in the trash row. */
export function tagCalibrationMeta(d: any): Record<string, unknown> {
	return {
		cameraName: d.cameraName,
		capturedAt: d.capturedAt,
		capturedBy: d.capturedBy ?? null,
		note: d.note ?? null,
		supersededAt: d.supersededAt ?? new Date(),
		tags: (d.tags ?? []).map((t: any) => ({ tagId: t.tagId, name: t.name, role: t.role }))
	};
}

/** Trash rows still in R2 (not restored, not purged), newest first. */
export async function listArchived(kind: ArchiveKind, filter: Record<string, unknown> = {}, limit = 500): Promise<any[]> {
	await connectDB();
	return RobotArmArchiveEntry.find({ kind, restoredAt: null, purgedAt: null, ...filter }).sort({ archivedAt: -1 }).limit(limit).lean();
}

/** Put an archived item back from R2, under its old id. */
export async function restoreFromR2(user: User, kind: ArchiveKind, itemId: string): Promise<{ name: string }> {
	await connectDB();
	const entry = (await RobotArmArchiveEntry.findOne({ kind, itemId, restoredAt: null, purgedAt: null }).sort({ archivedAt: -1 }).lean()) as any;
	if (!entry) throw new ArchiveError('That item is no longer in the archive.', 404);
	if (await MODEL[kind].exists({ _id: itemId })) throw new ArchiveError(`"${entry.name}" already exists.`, 409);
	let copy: { doc: any; related?: Record<string, any[]> };
	try {
		copy = JSON.parse((await downloadViaWorker(entry.r2Key)).toString('utf8'));
	} catch (err) {
		throw new ArchiveError(`Could not read "${entry.name}" from R2: ${(err as Error).message}`, 502);
	}
	// castObject turns the JSON (dates as strings) back into the schema's types; insert keeps timestamps as they were.
	await MODEL[kind].collection.insertOne(MODEL[kind].castObject(copy.doc));
	for (const [key, docs] of Object.entries(copy.related ?? {})) {
		const model = RELATED[key];
		if (model && docs.length) await model.collection.insertMany(docs.map((d) => model.castObject(d)));
	}
	await RobotArmArchiveEntry.updateOne({ _id: entry._id }, { $set: { restoredAt: new Date(), restoredBy: opRef(user) } });
	await deleteViaWorker(entry.r2Key).catch(() => {});
	await AuditLog.create({
		_id: generateId(),
		tableName: 'robot_arm_archive_entries',
		recordId: String(entry._id),
		action: 'robot_arm.archive.restore',
		newData: { kind, itemId, name: entry.name, userId: user._id },
		changedBy: user.username
	});
	return { name: entry.name };
}

/** Delete an archived item from R2 now (Delete For Good); the row is marked purged. */
export async function purgeNow(user: User, kind: ArchiveKind, itemId: string): Promise<{ name: string } | null> {
	await connectDB();
	const entry = (await RobotArmArchiveEntry.findOne({ kind, itemId, restoredAt: null, purgedAt: null }).lean()) as any;
	if (!entry) return null;
	await deleteViaWorker(entry.r2Key);
	await RobotArmArchiveEntry.updateOne({ _id: entry._id }, { $set: { purgedAt: new Date() } });
	await AuditLog.create({
		_id: generateId(),
		tableName: 'robot_arm_archive_entries',
		recordId: String(entry._id),
		action: 'robot_arm.archive.purge_now',
		newData: { kind, itemId, name: entry.name, r2Key: entry.r2Key, userId: user._id },
		changedBy: user.username
	});
	return { name: entry.name };
}

export interface PurgeReport {
	purged: number;
	failed: { id: string; error: string }[];
}

/** Daily: R2 objects past their 30 days are deleted; their rows are marked purged. */
export async function purgeExpiredArchive(now = new Date()): Promise<PurgeReport> {
	await connectDB();
	const due = (await RobotArmArchiveEntry.find({ expiresAt: { $lte: now }, restoredAt: null, purgedAt: null }).select('_id r2Key').limit(500).lean()) as any[];
	const report: PurgeReport = { purged: 0, failed: [] };
	for (const e of due) {
		try {
			await deleteViaWorker(e.r2Key);
			await RobotArmArchiveEntry.updateOne({ _id: e._id }, { $set: { purgedAt: new Date() } });
			report.purged++;
		} catch (err) {
			report.failed.push({ id: String(e._id), error: (err as Error).message });
		}
	}
	if (report.purged || report.failed.length) {
		await AuditLog.create({
			_id: generateId(),
			tableName: 'robot_arm_archive_entries',
			recordId: 'cron-bulk',
			action: 'robot_arm.archive.purge',
			newData: { ...report, cutoff: now.toISOString() },
			changedBy: 'system-cron'
		});
	}
	return report;
}
