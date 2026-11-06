/**
 * Robot arm change log — the writes and reads (2026-11-06).
 *
 * One entry point, like the OT-2's applyMaintenanceRecord: every BIMS route
 * that changes an arm setting calls logArmChange() beside its AuditLog row,
 * so the Maintenance page's Change Log fills itself. Labels are checked here
 * (page, hardware, key) so a typo cannot get into the log. Never throws: a
 * change that happened must not fail because its log row did not.
 */
import { connectDB } from './db/connection';
import { RobotArmChange } from './db/models';
import {
	changeLine,
	isArmHardware,
	isArmKey,
	isArmPage,
	isArmSource,
	type ArmChangeLabel,
	type ArmHardware,
	type ArmPage,
	type ArmSource
} from '$lib/robot-arm/change-labels';

export type ArmUser = { _id: string; username: string } | null;

export interface ArmChangeInput extends ArmChangeLabel {
	source: ArmSource;
	note?: string | null;
	details?: unknown;
	/** When it happened; defaults to now (the seed sets past dates). */
	at?: Date;
}

export interface ArmChangeRow {
	_id: string;
	at: string;
	page: ArmPage;
	hardware: ArmHardware;
	key: string;
	target: string | null;
	oldValue: unknown;
	newValue: unknown;
	unit: string | null;
	source: ArmSource;
	line: string;
	note: string | null;
	changedBy: { _id?: string; username?: string } | null;
}

export function validateArmChange(e: ArmChangeInput): string | null {
	if (!isArmPage(e.page)) return `unknown page "${e.page}"`;
	if (!isArmHardware(e.hardware)) return `unknown hardware "${e.hardware}"`;
	if (!isArmKey(e.key)) return `bad key "${e.key}"`;
	if (!isArmSource(e.source)) return `unknown source "${e.source}"`;
	return null;
}

/** Write one change row. Returns its id, or null when the write failed (logged, never thrown). */
export async function logArmChange(user: ArmUser, e: ArmChangeInput, opts: { id?: string } = {}): Promise<string | null> {
	const bad = validateArmChange(e);
	if (bad) {
		console.warn(`[arm-change-log] not logged: ${bad}`);
		return null;
	}
	try {
		await connectDB();
		const doc = await RobotArmChange.create({
			...(opts.id ? { _id: opts.id } : {}),
			at: e.at ?? new Date(),
			page: e.page,
			hardware: e.hardware,
			key: e.key,
			target: e.target ?? null,
			oldValue: e.oldValue ?? null,
			newValue: e.newValue ?? null,
			unit: e.unit ?? null,
			source: e.source,
			line: changeLine(e),
			note: e.note ?? null,
			details: e.details ?? null,
			changedBy: user ? { _id: user._id, username: user.username } : null
		});
		return String(doc._id);
	} catch (err) {
		console.warn('[arm-change-log] write failed:', err instanceof Error ? err.message : err);
		return null;
	}
}

/** Newest first. */
export async function listArmChanges(o: { limit?: number } = {}): Promise<ArmChangeRow[]> {
	await connectDB();
	const rows = await RobotArmChange.find({})
		.sort({ at: -1 })
		.limit(Math.min(Math.max(o.limit ?? 200, 1), 1000))
		.select('at page hardware key target oldValue newValue unit source line note changedBy')
		.lean();
	return JSON.parse(JSON.stringify(rows));
}

/** The newest logged value for a key (and target): what the arm is meant to be set to. */
export async function lastLoggedValue(key: string, target: string | null = null): Promise<{ newValue: unknown; at: Date } | null> {
	await connectDB();
	const row = (await RobotArmChange.findOne({ key, target, source: { $ne: 'test' } })
		.sort({ at: -1 })
		.select('newValue at')
		.lean()) as { newValue?: unknown; at?: Date } | null;
	return row ? { newValue: row.newValue ?? null, at: new Date(row.at ?? 0) } : null;
}
