/**
 * Wax/reagent-flow guard: cartridges that are at status='linked' or beyond
 * have been claimed by an SPU (or are terminal). Wax-flow actions must not
 * silently overwrite those carts even when their _id appears in
 * run.cartridgeIds.
 *
 * Calling protectLockedCarts() at the top of any wax-flow write action:
 *   1. Finds the locked carts in the target list
 *   2. Inserts an IMPROPER_ORDER_BLOCKED audit_log row per blocked cart
 *   3. Pushes a visible note onto cartridge.notes[] (rendered in cart-admin)
 *   4. Returns only the cart IDs that are safe to write to
 *
 * The R&D path that lets cartridges reach 'linked' before reagent_filled
 * stays open — this guard only stops the wax flow from clobbering carts
 * that already crossed that line.
 */
import { CartridgeRecord, AuditLog, generateId } from '$lib/server/db';
import {
	customerHeldMatch,
	isCustomerHeld,
	withNotCustomerHeld,
	HELD_PROBE_FIELDS,
	type HeldProbe
} from './customer-held';

// Customer-held carts (linked by a customer app): the shared rule lives in
// customer-held.ts (pure, so scripts can import it); re-exported here beside
// LOCKED_STATUSES so every manufacturing guard is found in one place.
export {
	CUSTOMER_HELD_STATUSES,
	CUSTOMER_LINK_APPS,
	customerHeldMatch,
	notCustomerHeld,
	withNotCustomerHeld,
	isCustomerHeld,
	customerHeldNotice,
	HELD_PROBE_FIELDS
} from './customer-held';

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

/** Which of `ids` are customer-held right now, in the order given. */
export async function findCustomerHeldIds(ids: string[]): Promise<string[]> {
	if (!ids?.length) return [];
	const rows = (await CartridgeRecord.find({ _id: { $in: ids }, ...customerHeldMatch() })
		.select('_id')
		.lean()) as unknown as Array<{ _id: string }>;
	const held = new Set(rows.map((r) => String(r._id)));
	return ids.filter((id) => held.has(id));
}

export interface GuardedUpdateResult {
	/** Matched the filter and were written: the only ids side effects may follow. */
	updated: string[];
	/** Not written because a customer has linked them. */
	held: string[];
	/** Not written for another reason: unknown id, or `extraFilter` did not match. */
	notMatched: string[];
}

const GUARD_CONCURRENCY = 20;

/**
 * One updateOne per cartridge with the customer-held guard IN the filter, so a
 * cart linked a moment ago is never overwritten and the caller learns exactly
 * which carts were written. The ids that did not match are classified
 * held / other with one read.
 */
export async function updateEachUnlessCustomerHeld(
	ids: string[],
	update: Record<string, unknown>,
	extraFilter: Record<string, unknown> = {}
): Promise<GuardedUpdateResult> {
	const unique = Array.from(new Set((ids ?? []).filter(Boolean)));
	const matched = new Set<string>();
	for (let i = 0; i < unique.length; i += GUARD_CONCURRENCY) {
		const chunk = unique.slice(i, i + GUARD_CONCURRENCY);
		const results = await Promise.all(
			chunk.map((id) =>
				CartridgeRecord.updateOne(withNotCustomerHeld({ ...extraFilter, _id: id }) as any, update as any)
			)
		);
		results.forEach((r: any, j) => {
			if ((r?.matchedCount ?? 0) > 0) matched.add(chunk[j]);
		});
	}
	const missed = unique.filter((id) => !matched.has(id));
	let heldSet = new Set<string>();
	if (missed.length) {
		const rows = (await CartridgeRecord.find({ _id: { $in: missed } })
			.select(`_id ${HELD_PROBE_FIELDS}`)
			.lean()) as unknown as Array<{ _id: string } & HeldProbe>;
		heldSet = new Set(rows.filter((r) => isCustomerHeld(r)).map((r) => String(r._id)));
	}
	return {
		updated: unique.filter((id) => matched.has(id)),
		held: missed.filter((id) => heldSet.has(id)),
		notMatched: missed.filter((id) => !heldSet.has(id))
	};
}
