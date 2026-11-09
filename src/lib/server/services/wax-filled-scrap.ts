/**
 * Bulk scrap of the wax-filled stage (Scrap page, "Scrap Wax Filled Except").
 *
 * An operator reconciling the wax-filled count names the carts that are really
 * there; every other cart at status wax_filled is scrapped the way the QA/QC
 * page scraps one cart (status → scrapped, a scrap transaction, an AuditLog
 * row). Checked-out carts are left alone: they are already out of every count.
 *
 * Two steps so nothing is scrapped unseen: the preview lists the carts, and the
 * scrap acts only on carts that were in that list and are still wax_filled — a
 * cart filled after the preview is never touched.
 */
import { AuditLog, CartridgeRecord, generateId } from '$lib/server/db';
import { getCheckedOutCartridgeIds } from '$lib/server/checkout-utils';
import { recordTransaction } from '$lib/server/services/inventory-transaction';

const WAX_FILLED = 'wax_filled';
/** Carts written at once; each takes a few round trips and the pool holds 10. */
const SCRAP_BATCH = 5;

/** A pasted or scanned list of cart ids: split on whitespace, commas and semicolons, deduped, order kept. */
export function parseCartIdList(raw: unknown): string[] {
	return [...new Set(String(raw ?? '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];
}

export interface WaxFilledScrapPlan {
	/** Named carts that are wax filled: they stay. */
	keep: string[];
	/** Every other wax-filled cart. */
	scrap: string[];
	/** Named carts that are not in the wax-filled count (another status, checked out, unknown). */
	notWaxFilled: string[];
	/** Wax-filled carts already checked out: untouched. */
	checkedOut: number;
}

export function planWaxFilledScrap(waxFilledIds: string[], keepIds: string[], checkedOutIds: string[]): WaxFilledScrapPlan {
	const out = new Set(checkedOutIds);
	const keepSet = new Set(keepIds);
	const live = waxFilledIds.filter((id) => !out.has(id));
	const liveSet = new Set(live);
	return {
		keep: keepIds.filter((id) => liveSet.has(id)),
		scrap: live.filter((id) => !keepSet.has(id)),
		notWaxFilled: keepIds.filter((id) => !liveSet.has(id)),
		checkedOut: waxFilledIds.length - live.length
	};
}

export interface WaxFilledScrapPreview {
	keep: string[];
	scrap: string[];
	notWaxFilled: Array<{ id: string; status: string }>;
	checkedOut: number;
}

/** What scrapping every wax-filled cart except `keepIds` would do right now. Caller has connected. */
export async function previewWaxFilledScrap(keepIds: string[]): Promise<WaxFilledScrapPreview> {
	const [carts, checkedOutIds] = await Promise.all([
		CartridgeRecord.find({ status: WAX_FILLED }).select('_id').lean() as Promise<Array<{ _id: string }>>,
		getCheckedOutCartridgeIds()
	]);
	const plan = planWaxFilledScrap(carts.map((c) => String(c._id)), keepIds, checkedOutIds);
	const others = plan.notWaxFilled.length
		? ((await CartridgeRecord.find({ _id: { $in: plan.notWaxFilled } }).select('_id status').lean()) as Array<{ _id: string; status?: string }>)
		: [];
	const statusById = new Map(others.map((c) => [String(c._id), String(c.status ?? 'none')]));
	return {
		keep: plan.keep,
		scrap: plan.scrap,
		notWaxFilled: plan.notWaxFilled.map((id) => {
			const status = statusById.get(id);
			return { id, status: !status ? 'not found' : status === WAX_FILLED ? 'checked out' : status };
		}),
		checkedOut: plan.checkedOut
	};
}

/**
 * Scrap the previewed carts. `scrapIds` is the list the operator saw; a cart in
 * it that is now kept, checked out or no longer wax filled is skipped.
 */
export async function scrapWaxFilledExcept(o: {
	keepIds: string[];
	scrapIds: string[];
	reason: string;
	user: { _id: string; username: string };
}): Promise<{ scrapped: string[]; skipped: string[] }> {
	const allowed = new Set((await previewWaxFilledScrap(o.keepIds)).scrap);
	const asked = [...new Set(o.scrapIds)];
	const targets = asked.filter((id) => allowed.has(id));
	const skipped = asked.filter((id) => !allowed.has(id));
	const scrapped: string[] = [];
	const now = new Date();
	const voidReason = `Scrapped: other — ${o.reason}`;

	for (let i = 0; i < targets.length; i += SCRAP_BATCH) {
		await Promise.all(
			targets.slice(i, i + SCRAP_BATCH).map(async (id) => {
				// Guarded on the status so a cart reagent filling took in the meantime is left alone.
				const before = await CartridgeRecord.findOneAndUpdate(
					{ _id: id, status: WAX_FILLED },
					{ $set: { status: 'scrapped', voidedAt: now, voidReason } },
					{ projection: { _id: 1 }, lean: true }
				);
				if (!before) {
					skipped.push(id);
					return;
				}
				scrapped.push(id);
				await recordTransaction({
					transactionType: 'scrap',
					cartridgeRecordId: id,
					quantity: 1,
					manufacturingStep: 'scrap',
					operatorId: o.user._id,
					operatorUsername: o.user.username,
					scrapReason: o.reason,
					scrapCategory: 'other',
					notes: `Wax filled reconciliation: ${o.reason}`
				});
				await AuditLog.create({
					_id: generateId(),
					tableName: 'cartridge_records',
					recordId: id,
					action: 'UPDATE',
					changedBy: o.user.username,
					changedAt: now,
					oldData: { status: WAX_FILLED },
					newData: { status: 'scrapped', voidReason },
					reason: `Wax filled reconciliation: ${o.reason}`
				});
			})
		);
	}
	return { scrapped, skipped };
}
