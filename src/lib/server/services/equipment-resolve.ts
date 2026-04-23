import { Equipment } from '$lib/server/db/models/index.js';

/**
 * Resolve a scanned value (Equipment._id, barcode, or display name) to the
 * canonical Equipment._id for a given equipment type. Introduced by PRD
 * Equipment Connectivity S1a so fridge-storage references stop drifting
 * when a fridge gets renamed or re-barcoded.
 *
 * Consumers pass the raw value the operator scanned/selected; callers store
 * the returned _id in the authoritative field (e.g. `storage.fridgeId`) and
 * keep the original string in a denormalized display field (e.g.
 * `storage.fridgeName`). Never join on the denormalized field.
 *
 * Returns null if no match — callers MUST handle this rather than silently
 * writing the raw string back.
 *
 * Cache: in-process Map, capped at 500 entries. Scoped per server process,
 * invalidated on process restart. Equipment metadata changes infrequently,
 * so staleness risk is low and the performance win per hot-path write is
 * meaningful.
 */

type EquipmentType = 'fridge' | 'oven' | 'deck' | 'tray' | 'robot' | 'cooling-tray';

const CACHE_LIMIT = 500;
const cache = new Map<string, string | null>();

function cacheKey(type: EquipmentType, value: string): string {
	return `${type}::${value}`;
}

async function resolveByType(type: EquipmentType, raw: string | null | undefined): Promise<string | null> {
	if (!raw || typeof raw !== 'string') return null;
	const value = raw.trim();
	if (!value) return null;

	const key = cacheKey(type, value);
	if (cache.has(key)) return cache.get(key) ?? null;

	const doc = await Equipment.findOne({
		equipmentType: type,
		$or: [{ _id: value }, { barcode: value }, { name: value }]
	}).select('_id').lean() as { _id?: string } | null;

	const resolved = doc?._id ? String(doc._id) : null;

	if (cache.size >= CACHE_LIMIT) {
		const firstKey = cache.keys().next().value;
		if (firstKey !== undefined) cache.delete(firstKey);
	}
	cache.set(key, resolved);

	return resolved;
}

/** Resolve a fridge reference (scanned barcode, name, or _id) to Equipment._id. */
export function resolveFridgeId(barcodeOrName: string | null | undefined): Promise<string | null> {
	return resolveByType('fridge', barcodeOrName);
}

/** Resolve an oven reference to Equipment._id. Used by S2. */
export function resolveOvenId(barcodeOrName: string | null | undefined): Promise<string | null> {
	return resolveByType('oven', barcodeOrName);
}

/** Test-only: clear the cache between test cases. */
export function __clearEquipmentResolveCacheForTests(): void {
	cache.clear();
}
