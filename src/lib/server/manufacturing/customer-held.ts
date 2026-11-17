/**
 * Customer-held cartridges — carts a manufacturing action must never move.
 *
 * A customer app (bioscale-app, bioscale-business, through /api/v1 or, before
 * the API, by writing directly) links a cartridge by setting status 'linked',
 * priorStatus, statusUpdatedOn and checkpoints.linked. The reader then refuses
 * any cartridge whose status is not 'linked', and brevitest-cloud moves it on to
 * underway / completed / cancelled. A manufacturing write (ship, store, QC,
 * scrap, wax fill, loose, void, assay assign, optical assign…) that sets
 * `status` on such a cart silently breaks the customer's test.
 *
 * THE RULE: a cartridge is customer-held when BOTH hold —
 *   1. its status is in CUSTOMER_HELD_STATUSES (linked, underway, completed,
 *      cancelled), and
 *   2. its link checkpoint was written by a customer app:
 *      `checkpoints.linked.via` is one of CUSTOMER_LINK_APPS, or
 *      `checkpoints.linked.who` starts with 'app:' (what /api/v1 writes).
 * A cartridge linked by the research app's arm scan carries neither marker
 * (its checkpoint has no `via` and `who` is a research user), so research
 * workflows keep their existing behaviour. A customer cart that staff unlinked
 * (status restored, checkpoints.linked cleared) is no longer held.
 *
 * Writers put `notCustomerHeld()` IN their update filter so the guard is
 * atomic, then report what they skipped with `customerHeldNotice()`.
 *
 * Pure: no database or SvelteKit import, so scripts can use it too.
 */

export const CUSTOMER_HELD_STATUSES = ['linked', 'underway', 'completed', 'cancelled'] as const;

/** `checkpoints.linked.via` values written by the customer apps (AppName in bims-api/rules.ts). */
export const CUSTOMER_LINK_APPS = ['bioscale-app', 'bioscale-business', 'bioscale-store'] as const;

/** `checkpoints.linked.who` prefix written by /api/v1 (bims-api/rules.ts whoFor). */
export const CUSTOMER_WHO_PREFIX = 'app:';

/** Mongo match for a customer-held cartridge (see THE RULE above). */
export function customerHeldMatch(): Record<string, unknown> {
	return {
		status: { $in: [...CUSTOMER_HELD_STATUSES] },
		$or: [
			{ 'checkpoints.linked.via': { $in: [...CUSTOMER_LINK_APPS] } },
			{ 'checkpoints.linked.who': { $regex: `^${CUSTOMER_WHO_PREFIX}` } }
		]
	};
}

/** Filter fragment that excludes customer-held cartridges. Spread it into a write filter. */
export function notCustomerHeld(): { $nor: Record<string, unknown>[] } {
	return { $nor: [customerHeldMatch()] };
}

/** `filter` plus the guard, keeping any `$nor` the filter already has. */
export function withNotCustomerHeld<T extends Record<string, unknown>>(filter: T): T & { $nor: Record<string, unknown>[] } {
	const existing = Array.isArray((filter as any).$nor) ? ((filter as any).$nor as Record<string, unknown>[]) : [];
	return { ...filter, $nor: [...existing, customerHeldMatch()] };
}

export type HeldProbe = {
	status?: string | null;
	checkpoints?: { linked?: { via?: unknown; who?: unknown } | null } | null;
};

/** The same rule in JS, for records already read. */
export function isCustomerHeld(r: HeldProbe | null | undefined): boolean {
	if (!r) return false;
	if (!(CUSTOMER_HELD_STATUSES as readonly string[]).includes(String(r.status ?? ''))) return false;
	const linked = r.checkpoints?.linked;
	if (!linked) return false;
	if (typeof linked.via === 'string' && (CUSTOMER_LINK_APPS as readonly string[]).includes(linked.via)) return true;
	return typeof linked.who === 'string' && linked.who.startsWith(CUSTOMER_WHO_PREFIX);
}

/** Fields a lookup must select for isCustomerHeld(). */
export const HELD_PROBE_FIELDS = 'status checkpoints.linked.via checkpoints.linked.who';

/**
 * Operator message for skipped carts, e.g.
 * "2 cartridges were not stored because a customer has linked them: A, B".
 * `verb` is the past participle of the action ("stored", "shipped", "released").
 * Null when nothing was skipped.
 */
export function customerHeldNotice(verb: string, ids: string[]): string | null {
	if (!ids.length) return null;
	const n = ids.length;
	return `${n} cartridge${n === 1 ? ' was' : 's were'} not ${verb} because a customer has linked ${n === 1 ? 'it' : 'them'}: ${ids.join(', ')}`;
}
