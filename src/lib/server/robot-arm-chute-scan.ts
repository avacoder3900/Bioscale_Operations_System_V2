/**
 * Chute barcode scans (2026-11-16), BIMS side. See $lib/robot-arm/chute-scan.
 *
 *   recordChuteScans  the Pi's POST: one robot_arm_chute_scans row + one
 *                     Movement Log row (kind chute_scan) per scan
 *   chuteScanWarning  the newest failed scan not yet closed, with how many
 *                     failed since the last Close (last 24 h)
 *   closeChuteWarning Close: every failed scan up to now is dismissed for everyone
 */
import { connectDB } from './db/connection';
import { AuditLog, RobotArmChuteScan, RobotArmMove } from './db/models';
import { generateId } from './db/utils';
import { chuteScanLine, type ChuteScanInput, type ChuteScanWarning } from '$lib/robot-arm/chute-scan';

const WARNING_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function recordChuteScans(host: string | null, scans: ChuteScanInput[]): Promise<{ written: number; duplicates: number; failed: number }> {
	await connectDB();
	let written = 0;
	let duplicates = 0;
	let failed = 0;
	for (const s of scans) {
		if (s.piScanId && (await RobotArmChuteScan.exists({ piScanId: s.piScanId }))) {
			duplicates++;
			continue;
		}
		const id = generateId();
		try {
			await RobotArmChuteScan.create({ _id: id, ...s, host });
			written++;
		} catch (err) {
			// A re-sent row racing its first copy hits the unique piScanId index.
			if ((err as { code?: number }).code === 11000) duplicates++;
			else {
				failed++;
				console.warn('[chute-scan] write failed:', err instanceof Error ? err.message : err);
			}
			continue;
		}
		try {
			await RobotArmMove.create({
				_id: generateId(),
				device: 'arm',
				at: s.at,
				kind: 'chute_scan',
				servo: null,
				goal: null,
				delta: null,
				goals: null,
				what: s.code,
				line: chuteScanLine(s),
				ok: s.ok,
				error: s.ok ? null : s.error,
				durationMs: s.elapsedMs,
				from: 'arm-pi',
				movedBy: { _id: 'arm-pi', username: host ?? 'arm-pi' },
				runId: s.runId ?? undefined,
				params: { solenoid: s.solenoid, pin: s.pin, title: s.title, scanDelayMs: s.delayMs, scanId: id }
			});
		} catch (err) {
			console.warn('[chute-scan] movement log row failed:', err instanceof Error ? err.message : err);
		}
	}
	return { written, duplicates, failed };
}

export async function chuteScanWarning(now: Date = new Date()): Promise<ChuteScanWarning | null> {
	await connectDB();
	const q = { ok: false, dismissedAt: null, at: { $gte: new Date(now.getTime() - WARNING_WINDOW_MS) } };
	const latest = await RobotArmChuteScan.findOne(q).sort({ at: -1 }).select('at code error solenoid title').lean<{
		_id: string;
		at: Date;
		code: string | null;
		error: string | null;
		solenoid: string | null;
		title: string | null;
	}>();
	if (!latest) return null;
	const failedCount = await RobotArmChuteScan.countDocuments(q);
	return {
		_id: latest._id,
		at: new Date(latest.at).toISOString(),
		code: latest.code,
		error: latest.error,
		solenoid: latest.solenoid,
		title: latest.title,
		failedCount
	};
}

export async function closeChuteWarning(user: { _id: string; username: string }, now: Date = new Date()): Promise<number> {
	await connectDB();
	const r = await RobotArmChuteScan.updateMany(
		{ ok: false, dismissedAt: null, at: { $lte: now } },
		{ $set: { dismissedAt: now, dismissedBy: { _id: user._id, username: user.username } } }
	);
	const closed = r.modifiedCount ?? 0;
	await AuditLog.create({
		_id: generateId(),
		tableName: 'robot_arm_chute_scans',
		recordId: 'warning',
		action: 'robot_arm.chute_scan.close_warning',
		newData: { closed, userId: user._id },
		changedBy: user.username,
		changedAt: now
	});
	return closed;
}
