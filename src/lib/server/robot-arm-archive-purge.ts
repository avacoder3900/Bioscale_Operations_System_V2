/**
 * Robot Arm archive → 30-day deletion (Alejandro, 2026-11-04: "We will not use
 * them in the future"). Archived items stay restorable for ARCHIVE_DAYS; after
 * that the daily cron (/api/cron/purge-robot-arm-archive) removes them.
 *
 * Before anything is deleted, a JSON copy of it goes to R2 and is downloaded
 * back and compared byte for byte (uploadVerified). A failed upload or a copy
 * that does not match keeps the item, and the next run tries again. The R2
 * copies are kept, so a purged item can still be recovered by hand.
 *
 * Covered: poses, move sets, sequences, superseded pose camera references,
 * superseded Arm Home calibrations, archived camera presets, archived
 * recording clean-ups. NOT covered: AprilTags (reassigned, never deleted).
 *
 * In use = kept, even past 30 days, until nothing points at it any more:
 * a sequence or move set chosen as a Run (wax fill) animation, a move set in a
 * remaining sequence, a pose in a remaining move set. Sequences go first, then
 * move sets, then poses, so one run frees what it purged.
 */
import { createHash } from 'node:crypto';
import { connectDB } from '$lib/server/db/connection';
import { AuditLog, generateId } from '$lib/server/db';
import {
	ArmWaxFillSettings,
	RobotArmCameraPreset,
	RobotArmMoveSet,
	RobotArmPose,
	RobotArmPoseCalibration,
	RobotArmRecordingCleanup,
	RobotArmSequence,
	RobotArmTagCalibration
} from '$lib/server/db/models';
import { downloadViaWorker, uploadViaWorker } from '$lib/server/services/r2';

export const ARCHIVE_DAYS = 30;
const R2_PREFIX = 'robot-arm/archive-purged';
const BATCH = 200;

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Upload, then read the object back and compare; throws unless R2 holds exactly `buffer`. */
export async function uploadVerified(buffer: Buffer, key: string, contentType: string): Promise<void> {
	await uploadViaWorker(buffer, key, contentType);
	const back = await downloadViaWorker(key);
	if (back.length !== buffer.length || sha256(back) !== sha256(buffer)) {
		throw new Error(`R2 copy of ${key} does not match what was uploaded (${back.length} of ${buffer.length} bytes)`);
	}
}

export interface PurgeReport {
	cutoff: string;
	purged: Record<string, string[]>;
	keptInUse: Record<string, string[]>;
	failed: { collection: string; id: string; error: string }[];
}

type Doc = Record<string, any> & { _id: string };

async function backupThenDelete(
	report: PurgeReport,
	collection: string,
	doc: Doc,
	remove: () => Promise<unknown>,
	related: Record<string, unknown> = {}
): Promise<boolean> {
	const key = `${R2_PREFIX}/${collection}/${doc._id}.json`;
	try {
		const body = Buffer.from(JSON.stringify({ collection, id: doc._id, purgedAt: new Date().toISOString(), doc, ...related }), 'utf8');
		await uploadVerified(body, key, 'application/json');
		await remove();
		(report.purged[collection] ??= []).push(doc._id);
		return true;
	} catch (err) {
		report.failed.push({ collection, id: doc._id, error: (err as Error).message ?? String(err) });
		return false;
	}
}

function kept(report: PurgeReport, collection: string, id: string) {
	(report.keptInUse[collection] ??= []).push(id);
}

/** Run animations (wax fill) refer to move sets / sequences by id. */
async function runAnimationRefs(): Promise<Set<string>> {
	const s = (await ArmWaxFillSettings.findById('default').select('grabAnimation withdrawAnimation failAnimation').lean()) as any;
	const ids = new Set<string>();
	for (const r of [s?.grabAnimation, s?.withdrawAnimation, s?.failAnimation]) if (r?.id) ids.add(`${r.kind}:${r.id}`);
	return ids;
}

export async function purgeExpiredArchive(now = new Date()): Promise<PurgeReport> {
	await connectDB();
	const cutoff = new Date(now.getTime() - ARCHIVE_DAYS * 24 * 60 * 60 * 1000);
	const report: PurgeReport = { cutoff: cutoff.toISOString(), purged: {}, keptInUse: {}, failed: [] };
	const runRefs = await runAnimationRefs();

	// Sequences
	for (const d of (await RobotArmSequence.find({ archivedAt: { $ne: null, $lte: cutoff } }).limit(BATCH).lean()) as Doc[]) {
		if (runRefs.has(`sequence:${d._id}`)) kept(report, 'robot_arm_sequences', d._id);
		else await backupThenDelete(report, 'robot_arm_sequences', d, () => RobotArmSequence.deleteOne({ _id: d._id, archivedAt: { $ne: null } }));
	}

	// Move sets: not in a remaining sequence, not a Run animation
	for (const d of (await RobotArmMoveSet.find({ archivedAt: { $ne: null, $lte: cutoff } }).limit(BATCH).lean()) as Doc[]) {
		const inSequence = await RobotArmSequence.exists({ 'items.moveSetId': d._id });
		if (inSequence || runRefs.has(`move_set:${d._id}`)) kept(report, 'robot_arm_move_sets', d._id);
		else await backupThenDelete(report, 'robot_arm_move_sets', d, () => RobotArmMoveSet.deleteOne({ _id: d._id, archivedAt: { $ne: null } }));
	}

	// Poses: not in a remaining move set; their camera references go with them
	for (const d of (await RobotArmPose.find({ archivedAt: { $ne: null, $lte: cutoff } }).limit(BATCH).lean()) as Doc[]) {
		if (await RobotArmMoveSet.exists({ 'keyframes.poseId': d._id })) {
			kept(report, 'robot_arm_poses', d._id);
			continue;
		}
		const calibrations = await RobotArmPoseCalibration.find({ poseId: d._id }).lean();
		await backupThenDelete(
			report,
			'robot_arm_poses',
			d,
			async () => {
				await RobotArmPoseCalibration.deleteMany({ poseId: d._id });
				await RobotArmPose.deleteOne({ _id: d._id, archivedAt: { $ne: null } });
			},
			{ poseCalibrations: calibrations }
		);
	}

	// Superseded pose camera references (retired or recaptured)
	for (const d of (await RobotArmPoseCalibration.find({ status: 'superseded', supersededAt: { $ne: null, $lte: cutoff } }).limit(BATCH).lean()) as Doc[]) {
		await backupThenDelete(report, 'robot_arm_pose_calibrations', d, () => RobotArmPoseCalibration.deleteOne({ _id: d._id, status: 'superseded' }));
	}

	// Superseded Arm Home calibrations (retired or recalibrated)
	for (const d of (await RobotArmTagCalibration.find({ status: 'superseded', supersededAt: { $ne: null, $lte: cutoff } }).limit(BATCH).lean()) as Doc[]) {
		await backupThenDelete(report, 'robot_arm_tag_calibrations', d, () => RobotArmTagCalibration.deleteOne({ _id: d._id, status: 'superseded' }));
	}

	// Archived camera presets
	for (const d of (await RobotArmCameraPreset.find({ archivedAt: { $ne: null, $lte: cutoff } }).limit(BATCH).lean()) as Doc[]) {
		await backupThenDelete(report, 'robot_arm_camera_presets', d, () => RobotArmCameraPreset.deleteOne({ _id: d._id, archivedAt: { $ne: null } }));
	}

	// Archived recording clean-ups (archivedAt since 2026-11-04; older ones by their last update)
	const cleanups = (await RobotArmRecordingCleanup.find({
		status: 'archived',
		$or: [{ archivedAt: { $ne: null, $lte: cutoff } }, { archivedAt: null, updatedAt: { $lte: cutoff } }]
	})
		.limit(BATCH)
		.lean()) as Doc[];
	for (const d of cleanups) {
		await backupThenDelete(report, 'robot_arm_recording_cleanups', d, () => RobotArmRecordingCleanup.deleteOne({ _id: d._id, status: 'archived' }));
	}

	const purgedCount = Object.values(report.purged).reduce((n, a) => n + a.length, 0);
	if (purgedCount || report.failed.length) {
		await AuditLog.create({
			_id: generateId(),
			tableName: 'robot_arm_archive',
			recordId: 'cron-bulk',
			action: 'DELETE',
			newData: { ...report, r2Prefix: R2_PREFIX },
			changedBy: 'system-cron'
		});
	}
	return report;
}
