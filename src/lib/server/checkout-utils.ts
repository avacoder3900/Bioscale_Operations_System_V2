import { ManualCartridgeRemoval } from '$lib/server/db/models';

/**
 * Return the set of cartridge IDs that have been manually checked out.
 *
 * Manual checkout is a physical-possession event that preserves the
 * cartridge's quality status (scrapped/accepted stays the same) but takes
 * it out of active inventory. Any query that counts "what's currently in
 * the fridge / wax storage" must exclude this set; otherwise the
 * dashboard double-counts cartridges that are physically gone.
 *
 * Caller is expected to have already called connectDB(). Returns an array
 * (not a Set) because Mongo's `$nin` operator takes an array directly.
 */
export async function getCheckedOutCartridgeIds(): Promise<string[]> {
	const docs = await ManualCartridgeRemoval.find({}, { cartridgeIds: 1 }).lean() as Array<{ cartridgeIds?: string[] }>;
	const ids = new Set<string>();
	for (const d of docs) {
		for (const cid of d.cartridgeIds ?? []) ids.add(cid);
	}
	return Array.from(ids);
}
