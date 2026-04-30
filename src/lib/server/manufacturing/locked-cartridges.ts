/**
 * Wax/reagent-flow guard: cartridges that are at status='linked' or beyond
 * have been claimed by an SPU (or are terminal). Wax-flow actions must not
 * silently overwrite those carts even when their _id appears in
 * run.cartridgeIds.
 *
 * Calling protectLockedCarts() at the top of any wax-flow write action:
 *   1. Finds the locked carts in the target list
 *   2. Inserts an IMPROPER_ORDER_BLOCKED audit_logs row per blocked cart
 *   3. Pushes a visible note onto cartridge.notes[] (rendered in cart-admin)
 *   4. Returns only the cart IDs that are safe to write to
 *
 * The R&D path that lets cartridges reach 'linked' before reagent_filled
 * stays open — this guard only stops the wax flow from clobbering carts
 * that already crossed that line.
 */
import { CartridgeRecord, AuditLog, generateId } from '$lib/server/db';

export const LOCKED_STATUSES = [
	'linked',
	'underway',
	'completed',
	'voided',
	'scrapped'
] as const;
export type LockedStatus = (typeof LOCKED_STATUSES)[number];

export interface LockedCartResult {
	safeIds: string[];
	blockedDetails: Array<{ _id: string; status: string }>;
}

export async function protectLockedCarts(
	cartIds: string[],
	action: string,
	runId: string | undefined,
	user: { _id: string; username: string }
): Promise<LockedCartResult> {
	if (!cartIds?.length) return { safeIds: [], blockedDetails: [] };

	const blocked = (await CartridgeRecord.find({
		_id: { $in: cartIds },
		status: { $in: [...LOCKED_STATUSES] }
	})
		.select('_id status')
		.lean()) as unknown as Array<{ _id: string; status: string }>;

	if (blocked.length === 0) return { safeIds: cartIds, blockedDetails: [] };

	const blockedSet = new Set(blocked.map((c) => String(c._id)));
	const now = new Date();
	const runRef = runId ? `Run ${runId}` : 'unknown run';

	// Audit log row per blocked cart
	await AuditLog.insertMany(
		blocked.map((b) => ({
			_id: generateId(),
			tableName: 'cartridge_records',
			recordId: b._id,
			action: 'IMPROPER_ORDER_BLOCKED',
			changedBy: user.username,
			changedAt: now,
			reason: `Wax-flow action "${action}" attempted on cartridge ${b._id} at status="${b.status}". Skipped to preserve SPU/terminal state. ${runRef}.`,
			newData: { attemptedAction: action, currentStatus: b.status, runId: runId ?? null }
		}))
	);

	// Visible note pushed onto cartridge.notes[] — surfaced in cart-admin.
	// Cast to any[] because Mongoose's bulkWrite types reject our $push shape
	// for nested subdoc arrays in strict mode.
	await CartridgeRecord.bulkWrite(
		blocked.map((b) => ({
			updateOne: {
				filter: { _id: b._id },
				update: {
					$push: {
						notes: {
							_id: generateId(),
							body: `Improper order: wax flow tried to "${action}" while cart was at status="${b.status}". Skipped. (${runRef})`,
							phase: 'wax_flow_blocked',
							author: user,
							createdAt: now
						}
					}
				}
			}
		})) as any[]
	);

	return {
		safeIds: cartIds.filter((id) => !blockedSet.has(id)),
		blockedDetails: blocked
	};
}
