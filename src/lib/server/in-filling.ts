import { WaxFillingRun } from '$lib/server/db/models';
import { WAX_PAGE_OWNED } from '$lib/server/db/models/wax-filling-run';

/**
 * Derived "in the filling step" marker.
 *
 * Answers "which cartridges are actively being wax-filled right now?" WITHOUT
 * relying on a cartridge status value. The source of truth is active
 * WaxFillingRun membership: a cartridge is in-filling iff it belongs to a run
 * whose status is one of the filling-page-owned stages (robot/deck still held,
 * i.e. pre-QC/Storage — see WAX_PAGE_OWNED).
 *
 * This deliberately does NOT read CartridgeRecord.status. The `wax_filling`
 * status stays in place for its run-gating role (storage guard, goBack rewind),
 * but display/marker logic derives from the run so there is no transient
 * cartridge state that can get stuck if a run never finalizes.
 *
 * Caller is expected to have already called connectDB().
 */
export const ACTIVE_FILL_STATUSES = WAX_PAGE_OWNED;

/** Cartridge IDs currently in the wax-filling step (deduped across runs). */
export async function cartridgesInFilling(): Promise<string[]> {
	const runs = await WaxFillingRun.find({ status: { $in: ACTIVE_FILL_STATUSES } })
		.select('cartridgeIds')
		.lean();
	const ids = new Set<string>();
	for (const r of runs as Array<{ cartridgeIds?: string[] }>) {
		for (const id of r.cartridgeIds ?? []) ids.add(id);
	}
	return [...ids];
}

/** Count of cartridges currently in the wax-filling step. */
export async function countCartridgesInFilling(): Promise<number> {
	return (await cartridgesInFilling()).length;
}
