/**
 * Loose carts (user, 2026-11-02) — the pure pieces, no models, so they can be
 * unit-tested without a database.
 *
 * "Loose" is a cart status, not a bucket: a cart that is alive but on no pass,
 * waiting for someone to look at it and say where it goes. It is the landing
 * place for a member an audit could not find in the tub ("Move To Loose"), for
 * a cart scanned into the Loose pile on the board, and for a sticker that was
 * never scanned into a bucket at all (it starts life here). From Loose a cart
 * can be Put In Bucket (it takes that pass's stage), Moved To Oven (status
 * 'backing', loadable by wax filling) or Trashed (scrapped). Scanning a loose
 * cart into a Barcoded pass on the board adopts it the same way.
 *
 * A loose cart is NOT a bucket status: it is not counted in any stage column
 * and never shows under "In oven" (that is loose-at-backing with no stamp,
 * which is a different, intentional place — see inOvenCarts).
 */
export const LOOSE_STATUS = 'loose';
export const LOOSE_LABEL = 'Loose';

/** What the operator chose for a member that was not in the tub during an audit. */
export type MissingAction = 'discard' | 'release' | 'loose' | 'oven';
export const MISSING_ACTIONS: readonly MissingAction[] = ['discard', 'release', 'loose', 'oven'];

export function isMissingAction(s: unknown): s is MissingAction {
	return typeof s === 'string' && (MISSING_ACTIONS as readonly string[]).includes(s);
}

export interface MissingPlan {
	discards: string[];   // Trash: scrapped off the pass
	releases: string[];   // legacy "Take off pass": off the pass, status unchanged
	loose: string[];      // Move To Loose
	oven: string[];       // Move To Oven
}

/**
 * Sort the operator's per-cart choices into the four groups. Only members that
 * are actually missing count; a code listed twice takes its last choice; an
 * action the board does not know is ignored (the cart stays on the pass).
 */
export function partitionMissingActions(
	missing: readonly string[],
	actions: readonly { barcode?: unknown; action?: unknown }[] | undefined | null
): MissingPlan {
	const chosen = new Map<string, MissingAction>();
	for (const a of actions ?? []) {
		const code = typeof a?.barcode === 'string' ? a.barcode.trim() : '';
		if (!code || !missing.includes(code)) continue;
		if (!isMissingAction(a?.action)) { chosen.delete(code); continue; }
		chosen.set(code, a.action);
	}
	const plan: MissingPlan = { discards: [], releases: [], loose: [], oven: [] };
	for (const [code, action] of chosen) {
		if (action === 'discard') plan.discards.push(code);
		else if (action === 'release') plan.releases.push(code);
		else if (action === 'loose') plan.loose.push(code);
		else plan.oven.push(code);
	}
	return plan;
}

/** What happens to a cart in the Loose pile. */
export type LooseDecision = 'bucket' | 'oven' | 'trash';
export const LOOSE_DECISIONS: readonly LooseDecision[] = ['bucket', 'oven', 'trash'];

export function parseLooseDecision(s: unknown): LooseDecision | null {
	return typeof s === 'string' && (LOOSE_DECISIONS as readonly string[]).includes(s) ? (s as LooseDecision) : null;
}
