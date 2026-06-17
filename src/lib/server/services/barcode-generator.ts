import { randomUUID } from 'node:crypto';
import { connectDB } from '$lib/server/db/connection';
import { GeneratedBarcode, CartridgeRecord, BarcodeSheetBatch } from '$lib/server/db/models';
import { generateId } from '$lib/server/db/utils';

/**
 * Generate a sequential barcode for a given prefix.
 * Uses atomic findOneAndUpdate on a per-prefix counter doc to guarantee
 * monotonically increasing sequences. Returns the formatted barcode string.
 *
 * Earlier versions of this function also wrote `barcode` onto the counter
 * doc, which collided with the unique `barcode_1` index whenever the
 * collection also held per-barcode tracking docs (validation routes write
 * those; CART had 399 stale ones from a prior import). The barcode-write
 * step is now removed — per-barcode tracking is the caller's responsibility
 * if they need it (see validation/thermocouple/+page.server.ts).
 *
 * `sort: { sequence: -1 }` ensures we always increment the doc with the
 * highest sequence (the counter), even when stale per-barcode docs exist
 * for the same prefix.
 */
export async function generateBarcode(prefix: string, type: string): Promise<string> {
	await connectDB();
	const doc = await GeneratedBarcode.findOneAndUpdate(
		{ prefix },
		{ $inc: { sequence: 1 }, $setOnInsert: { type } },
		{ upsert: true, new: true, setDefaultsOnInsert: true, sort: { sequence: -1 } }
	) as any;
	const seq = doc.sequence ?? 1;
	return `${prefix}-${String(seq).padStart(6, '0')}`;
}

/**
 * Generate a part barcode: PART-000001, PART-000002, etc.
 */
export async function generatePartBarcode(): Promise<string> {
	return generateBarcode('PART', 'part');
}

/**
 * Generate a cartridge barcode: CART-000001, CART-000002, etc.
 */
export async function generateCartridgeBarcode(): Promise<string> {
	return generateBarcode('CART', 'cartridge');
}

/**
 * Mint a fresh batch of unique cartridge barcodes for printing.
 *
 * Format: UUID v4 (e.g. "5da7b3c5-4cba-4fe4-93b1-c17ad61efbbf"), matching
 * the reference barcode sheet design. UUIDs avoid the counter-doc fragility
 * of sequential ids: no shared state, no race conditions, and the v4
 * collision probability across the entire device lifetime is negligible.
 *
 * Defense-in-depth checks (any one firing means something is very wrong):
 *   1. Within-batch dedup: the minted set is checked against itself. UUID v4
 *      has 122 bits of entropy so this should never trigger, but the
 *      assertion is cheap and catches a broken random source immediately.
 *   2. CartridgeRecord scan against `_id` — printed UUIDs end up as the
 *      cartridge `_id` (see api/cv/induct-cartridge), so this is the field
 *      that must not collide.
 *   3. BarcodeSheetBatch scan against `barcodeIds` — catches any UUID
 *      already minted for a prior print job, even if it never made it onto
 *      a cartridge yet.
 */
export async function mintCartridgeBarcodes(count: number): Promise<string[]> {
	if (!Number.isInteger(count) || count < 1 || count > 800) {
		throw new Error(`mintCartridgeBarcodes: count must be 1-800, got ${count}`);
	}
	await connectDB();
	const minted: string[] = Array.from({ length: count }, () => randomUUID());

	if (new Set(minted).size !== minted.length) {
		throw new Error('Refusing to print: minted batch contains duplicate UUIDs (random source compromised)');
	}

	const cartridgeCollisions = await CartridgeRecord.find({ _id: { $in: minted } })
		.select('_id')
		.lean();
	if (cartridgeCollisions.length > 0) {
		const dupes = (cartridgeCollisions as Array<{ _id: string }>).map((c) => c._id).join(', ');
		throw new Error(`Refusing to print: minted barcodes already exist on cartridges: ${dupes}`);
	}

	const priorBatchCollisions = await BarcodeSheetBatch.find({ barcodeIds: { $in: minted } })
		.select('barcodeIds')
		.lean();
	if (priorBatchCollisions.length > 0) {
		const all = (priorBatchCollisions as Array<{ barcodeIds: string[] }>).flatMap((b) => b.barcodeIds);
		const dupes = minted.filter((m) => all.includes(m)).join(', ');
		throw new Error(`Refusing to print: minted barcodes were already printed in a prior batch: ${dupes}`);
	}

	return minted;
}
