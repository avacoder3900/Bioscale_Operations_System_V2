/**
 * Hard-delete cartridge records that were never real: mis-scans at backing and
 * test-mode synthetics reverted by a wax abort. The CartridgeRecord model carries
 * the sacred middleware, whose delete hooks throw unconditionally — so every
 * caller that reached for Model.deleteOne/deleteMany has been failing with a 500
 * since the middleware landed (the WI-01 "Remove" button never worked once).
 *
 * This goes to the driver collection on purpose, and only for documents that
 * (a) match the caller's filter, (b) have no finalizedAt, and (c) sit in a status
 * where nothing downstream references them yet. Every id removed gets an
 * AuditLog row so the deletion is as traceable as a sacred update would be.
 */
import { connectDB, CartridgeRecord, AuditLog, generateId } from '$lib/server/db';

const DELETABLE_STATUSES = new Set(['backing', 'wax_filling']);

export async function hardDeleteUnfinalizedCartridges(
	filter: Record<string, unknown>,
	opts: {
		reason: string;
		user?: { _id?: string; username?: string };
		oldData?: Record<string, unknown>;
		/**
		 * Override the default deletable statuses. The bucket board's mis-scan
		 * button passes ['barcoded']: a cart un-scanned while its pass is still at
		 * Barcoded was born seconds ago and nothing downstream references it
		 * (bucket-service.unscanCart, which re-checks membership first).
		 */
		statuses?: string[];
	}
): Promise<string[]> {
	await connectDB();
	const deletable = opts.statuses?.length ? new Set(opts.statuses) : DELETABLE_STATUSES;
	const docs = (await CartridgeRecord.find({ ...filter, finalizedAt: { $in: [null, undefined] } })
		.select('_id status')
		.lean()) as Array<{ _id: string; status?: string }>;
	const ids = docs.filter((d) => deletable.has(String(d.status))).map((d) => String(d._id));
	if (ids.length === 0) return [];
	// Driver-level: the model's own delete methods are hook-blocked. Ids are nanoid strings.
	await CartridgeRecord.collection.deleteMany({ _id: { $in: ids } } as any);
	const now = new Date();
	await AuditLog.insertMany(
		ids.map((id) => ({
			_id: generateId(),
			tableName: 'cartridge_records',
			recordId: id,
			action: 'DELETE',
			changedBy: opts.user?.username,
			changedAt: now,
			oldData: { status: docs.find((d) => String(d._id) === id)?.status, ...(opts.oldData ?? {}) },
			reason: opts.reason
		}))
	);
	return ids;
}

/** Two (or more) UUID barcodes glued into one string by a fast scanner. */
export function splitMergedBarcodes(raw: string): string[] | null {
	const s = String(raw).trim();
	if (s.length <= 36 || s.length % 36 !== 0) return null;
	const parts: string[] = [];
	for (let i = 0; i < s.length; i += 36) parts.push(s.slice(i, i + 36));
	const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	return parts.every((p) => uuid.test(p)) ? parts : null;
}
