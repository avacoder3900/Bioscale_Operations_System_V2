/**
 * Check if backing.parentLotRecordId exists (as null) vs is truly absent.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const cartridges = db.collection('cartridge_records');

	// Today's cart — hoist raw
	const c = await cartridges.findOne({ _id: '47512ea2-4fbe-450a-8881-37b16038c49a' });
	console.log('keys in doc.backing:', Object.keys((c as any).backing ?? {}));

	// Count cartridges where backing has parentLotRecordId even as null
	const haveField = await cartridges.countDocuments({ 'backing.parentLotRecordId': { $exists: true } });
	const haveFieldNonNull = await cartridges.countDocuments({ 'backing.parentLotRecordId': { $exists: true, $ne: null } });
	const haveFieldNull = await cartridges.countDocuments({ 'backing.parentLotRecordId': null });
	console.log(`backing.parentLotRecordId exists at all: ${haveField}`);
	console.log(`backing.parentLotRecordId exists & non-null: ${haveFieldNonNull}`);
	console.log(`backing.parentLotRecordId is null: ${haveFieldNull}`);

	// Maybe parentLot was null because findOne({bucketBarcode}).lean() returned null.
	// Let's trace: for the latest run (4Z6AldZWCJ8EC_QG0pe2N), activeLotId = 2941bb67…
	// findOne({bucketBarcode:"2941bb67…"}) → LotRecord V1BSHFzMXsNAxYiP59o6b (exists, inputLots.length=3)
	// So parentLot was NOT null — the $setOnInsert values should have included non-null.
	// Yet we see backing only has: lotId, operator, recordedAt.
	// This means the upsert happened but $setOnInsert dropped the new fields.
	// The only way this happens is if the cart was NOT actually inserted here —
	// it already existed at the time of the update. Let me look at createdAt more carefully.

	// Let me look at what Mongoose adds: check if schema has 'strict' mode
	console.log('\n== Testing strict schema behavior ==');
	// Recent 5 carts with waxFilling, look at backing AND top-level recordedAt
	const carts = await cartridges.find({ 'waxFilling.runId': '4Z6AldZWCJ8EC_QG0pe2N' }).toArray();
	console.log(`Found ${carts.length} carts for run`);
	console.log('Schema-level check: do any of these docs have parentLotRecordId at all?');
	for (const c of carts.slice(0, 3)) {
		const ca = c as any;
		console.log(`  ${c._id}: backing keys=[${Object.keys(ca.backing ?? {}).join(', ')}]`);
	}

	// Look at the backing.parentLotRecordId index
	const indexes = await cartridges.indexes();
	console.log('\nIndexes on cartridge_records:');
	for (const idx of indexes) {
		console.log(`  ${idx.name}: ${JSON.stringify(idx.key)}`);
	}

	// Is the backing sub-schema defined with `strict` mode that silently drops unknown fields?
	// If Mongoose's CartridgeRecord schema was NOT updated (e.g. deploy didn't pick up the new
	// cartridge-record.ts), Mongoose would ignore the unknown fields.
	// But bulkWrite with raw ops usually bypasses schema validation.
	// Hmm.

	// Let me check timing precisely:
	const run = await db.collection('wax_filling_runs').findOne({ _id: '4Z6AldZWCJ8EC_QG0pe2N' });
	console.log(`\nRun cartridgeIds present?`, (run as any)?.cartridgeIds?.length);
	// Check the $addToSet: 'cartridgeIds' list
	console.log(`Run cartridgeIds (first 3): ${(run as any)?.cartridgeIds?.slice(0, 3).join(', ')}`);

	// Also check the backing subdoc insertion timing vs waxFilling.recordedAt timing
	// backing.recordedAt = 2026-04-22 15:58:48 == createdAt
	// waxFilling.recordedAt = 2026-04-22 16:13:50
	// So the run was: loadDeck at 15:58:48 (creates cart with backing, status=wax_filling) →
	// completeQC at 16:13:50 (sets waxFilling.runEndTime, waxFilling.recordedAt, waxQc.status=Accepted)
	// Both happened post-refactor. Yet parentLotRecordId + lotQrCode + cartridgeBlankLot missing.

	// Is it possible the server was running cached/stale code? What does the runtime actually execute?
	// Check by looking at one more recent cartridge — from the most recent run — to confirm pattern.
	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
