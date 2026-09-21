/**
 * Shared reference resolvers for inventory flows.
 *
 * Operators and agents refer to an SPU as a full UDI, a barcode, a nanoid, or
 * just the last few digits ("SPU 203"); they refer to a part as a part number,
 * a name, or a scanned barcode. Both the agent reassembly endpoint and the
 * SPU-kit withdrawal button resolve those references, so the rules live here
 * once — a divergence between the two would silently deduct against the wrong
 * unit or the wrong part.
 */

import { PartDefinition, Spu } from '$lib/server/db/models/index.js';

export function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface AmbiguousSpu {
	ambiguous: any[];
}

/**
 * Resolve an SPU reference to a single unit.
 *
 * Returns the SPU, `{ ambiguous }` when a suffix match hits more than one unit,
 * or null when nothing matches. Callers must handle all three.
 */
export async function resolveSpuRef(ref: string): Promise<any | AmbiguousSpu | null> {
	const exact = await Spu.findOne({ $or: [{ _id: ref }, { udi: ref }, { barcode: ref }] })
		.select('_id udi barcode status')
		.lean();
	if (exact) return exact;

	// Suffix match so operators can say "SPU 203" or the last-5 of a barcode
	const suffix = new RegExp(`${escapeRegex(ref)}$`, 'i');
	const matches = await Spu.find({ $or: [{ udi: suffix }, { barcode: suffix }] })
		.select('_id udi barcode status')
		.limit(5)
		.lean();
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) return { ambiguous: matches };
	return null;
}

/** Resolve a part reference (barcode, part number, or name) to a PartDefinition. */
export async function resolvePartRef(ref: string): Promise<any | null> {
	// Stored barcodes are lowercase; scanners typically emit uppercase.
	const lc = ref.toLowerCase();
	const byBarcode = await PartDefinition.findOne({
		$or: [{ barcode: lc }, { altBarcodes: lc }],
		isActive: { $ne: false }
	}).lean();
	if (byBarcode) return byBarcode;
	const exact = new RegExp(`^${escapeRegex(ref)}$`, 'i');
	return (
		(await PartDefinition.findOne({ partNumber: exact, isActive: { $ne: false } }).lean()) ||
		(await PartDefinition.findOne({ name: exact, isActive: { $ne: false } }).lean())
	);
}
