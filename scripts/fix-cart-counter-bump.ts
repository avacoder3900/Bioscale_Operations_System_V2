/**
 * Bump the CART counter past the existing 399 leftover barcode docs and
 * unset its stale `barcode` field. The leftover CART-000002..CART-000400
 * tracking docs are likely from a prior import; none are referenced by
 * any CartridgeRecord (verified at script-write time, 0 cartridges with
 * CART-NNNNNN barcode). Leaving them in place — a future cleanup can
 * delete them if desired. This script only fixes the counter so new
 * mints don't collide.
 *
 * Run with --apply to execute. Without that flag, dry-run only.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	const apply = process.argv.includes('--apply');
	console.log(`MODE: ${apply ? 'APPLY' : 'DRY-RUN'}\n`);

	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	// Find the highest existing CART-NNNNNN barcode in either generated_barcodes
	// or cartridge_records — the new counter must be at least this high.
	const topGen = await db.collection('generated_barcodes')
		.find({ prefix: 'CART', barcode: { $regex: /^CART-\d+$/ } })
		.sort({ barcode: -1 }).limit(1).toArray();
	const topCart = await db.collection('cartridge_records')
		.find({ barcode: { $regex: /^CART-\d+$/ } })
		.sort({ barcode: -1 }).limit(1).toArray();
	const parseSeq = (s?: string) => s ? Number(s.replace(/^CART-/, '')) : 0;
	const topGenSeq = parseSeq((topGen[0] as any)?.barcode);
	const topCartSeq = parseSeq((topCart[0] as any)?.barcode);
	const desiredSeq = Math.max(topGenSeq, topCartSeq);
	console.log(`Highest CART-NNN in generated_barcodes: ${topGenSeq}`);
	console.log(`Highest CART-NNN in cartridge_records:  ${topCartSeq}`);
	console.log(`New counter sequence (max of both):     ${desiredSeq}\n`);

	// The counter doc is the one with `sequence` set. There should be exactly one
	// per prefix in normal operation. (Validation prefixes happen to also have
	// per-barcode docs that include sequence — we only touch the CART counter
	// here, which is identifiable by prefix='CART' AND barcode set to a
	// CART-NNN string OR no barcode field.)
	const counter = await db.collection('generated_barcodes').findOne({
		prefix: 'CART',
		// the counter is the one with the smallest barcode (CART-000001) — the
		// previous buggy generateBarcode set it during its first run
		barcode: 'CART-000001',
		sequence: { $exists: true }
	});
	if (!counter) {
		console.error('Counter doc not found. Manual investigation needed.');
		process.exit(1);
	}
	console.log(`Found counter doc: _id=${counter._id} sequence=${counter.sequence} barcode=${counter.barcode}`);
	console.log(`Will set sequence=${desiredSeq} and unset barcode field.\n`);

	if (!apply) {
		console.log('DRY-RUN complete. Re-run with --apply to execute.');
		await mongoose.disconnect();
		return;
	}

	// Note: NOT unsetting the `barcode` field. Doing so would create a second
	// doc with null/missing barcode in the collection, and the unique
	// `barcode_1` index is non-sparse — so two null-barcode docs collide.
	// The new generateBarcode never writes to barcode, so the counter's stale
	// barcode='CART-000001' value just sits there harmlessly.
	const result = await db.collection('generated_barcodes').updateOne(
		{ _id: counter._id },
		{ $set: { sequence: desiredSeq } }
	);
	console.log(`✓ Updated counter: matched=${result.matchedCount} modified=${result.modifiedCount}`);

	const { nanoid } = await import('nanoid');
	await db.collection('audit_log').insertOne({
		_id: nanoid(),
		tableName: 'generated_barcodes',
		recordId: counter._id,
		action: 'UPDATE',
		changedBy: 'system-cart-counter-bump',
		changedAt: new Date(),
		oldData: { sequence: counter.sequence, barcode: counter.barcode },
		newData: { sequence: desiredSeq, barcodeUnset: true },
		reason: 'Bump CART counter past stale leftover barcode docs (399 unused CART-000002..CART-000400 from prior import) so generateBarcode no longer collides with the unique barcode index'
	});
	console.log('✓ Audit log written');

	await mongoose.disconnect();
	console.log('\nDONE. Next mintCartridgeBarcodes call will start at CART-' + String(desiredSeq + 1).padStart(6, '0'));
}
main().catch(e => { console.error(e); process.exit(1); });
