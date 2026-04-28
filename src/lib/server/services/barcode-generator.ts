import { connectDB } from '$lib/server/db/connection';
import { GeneratedBarcode, CartridgeRecord } from '$lib/server/db/models';
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
 * Uniqueness layers (defense-in-depth):
 *   1. Atomic $inc on the prefix counter — guarantees the sequence never repeats.
 *   2. unique index on GeneratedBarcode.barcode — DB-level rejection of duplicates.
 *   3. Post-mint scan against CartridgeRecord.barcode — surfaces any historical
 *      drift (e.g. legacy data created outside this generator).
 *
 * Throws if any minted barcode collides with an existing CartridgeRecord, so the
 * caller can fail the print job before any sticker is produced.
 */
export async function mintCartridgeBarcodes(count: number): Promise<string[]> {
	if (!Number.isInteger(count) || count < 1 || count > 800) {
		throw new Error(`mintCartridgeBarcodes: count must be 1-800, got ${count}`);
	}
	await connectDB();
	const minted: string[] = [];
	for (let i = 0; i < count; i++) {
		minted.push(await generateCartridgeBarcode());
	}
	const collisions = await CartridgeRecord.find({ barcode: { $in: minted } })
		.select('barcode')
		.lean();
	if (collisions.length > 0) {
		const dupes = (collisions as Array<{ barcode: string }>).map((c) => c.barcode).join(', ');
		throw new Error(`Refusing to print: minted barcodes already exist on cartridges: ${dupes}`);
	}
	return minted;
}
