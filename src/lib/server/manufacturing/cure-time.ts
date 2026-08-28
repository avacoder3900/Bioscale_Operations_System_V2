/**
 * Wax cure-time (oven) requirement — ONE switch.
 *
 * Backed cartridges used to be blocked from wax filling until they had spent
 * `waxFilling.minOvenTimeMin` (default 60) in the oven; loadDeck refused the
 * deck and offered an admin override. Suspended 2026-08-28 at the operator's
 * request ("completely abolish the heating/oven timing requirement for wax
 * carts, we might reinstate it later") after carts backed ~12 minutes earlier
 * could not be filled.
 *
 * Nothing about the DATA changed: backing.ovenEntryTime is still recorded, the
 * shortfall is still measured, and loadDeck still writes an audit note naming
 * every cartridge that would have been blocked. Reinstating is:
 *   1. flip ENFORCE_CURE_TIME to true here, and
 *   2. restore the fail() in wax-filling loadDeck (the client's
 *      `requiresOverride` handling and admin re-auth modal were left intact).
 *
 * Everything that ASKS "is this cartridge ready?" goes through
 * `isCureComplete()` so the answer can never disagree between the run gate and
 * the dashboards that count ready cartridges.
 */
export const ENFORCE_CURE_TIME = false;

/**
 * Has this cartridge finished its oven cure?
 *
 * With enforcement off this is always true — including for a cartridge with no
 * recorded oven entry — because nothing downstream may block on it.
 */
export function isCureComplete(
	ovenEntryTime: Date | string | null | undefined,
	minOvenTimeMin: number,
	now: number = Date.now()
): boolean {
	if (!ENFORCE_CURE_TIME) return true;
	const entry = ovenEntryTime ? new Date(ovenEntryTime).getTime() : 0;
	if (!entry) return false;
	return (now - entry) / 60000 >= minOvenTimeMin;
}

/**
 * Minutes still owed on the cure, for display only. Returns 0 while
 * enforcement is off so no UI shows a countdown that gates nothing.
 */
export function cureRemainingMin(
	ovenEntryTime: Date | string | null | undefined,
	minOvenTimeMin: number,
	now: number = Date.now()
): number {
	if (!ENFORCE_CURE_TIME) return 0;
	const entry = ovenEntryTime ? new Date(ovenEntryTime).getTime() : 0;
	if (!entry) return minOvenTimeMin;
	return Math.max(0, Math.ceil(minOvenTimeMin - (now - entry) / 60000));
}
