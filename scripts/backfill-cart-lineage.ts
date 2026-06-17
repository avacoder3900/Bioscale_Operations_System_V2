/**
 * Two-part backfill:
 *  1. Remap backing.lotId = LotRecord._id  →  LotRecord.bucketBarcode (= BackingLot._id).
 *     The post-refactor contract is "backing.lotId points at the bucket barcode",
 *     but 133 historical carts still hold LotRecord._id there.
 *  2. Copy material lineage from LotRecord onto every cart that's missing it:
 *     parentLotRecordId, lotQrCode, ovenEntryTime, cartridgeBlankLot,
 *     thermosealLot, barcodeLabelLot.
 *
 * Both steps are idempotent.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	const dry = process.argv.includes('--dry');
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const now = new Date();

	// === Step 1: remap backing.lotId (LotRecord._id → bucketBarcode) ===
	console.log('=== Step 1: remap backing.lotId from LotRecord._id to bucketBarcode ===');
	const allLotRecs = await db.collection('lot_records').find({
		bucketBarcode: { $exists: true, $ne: null }
	}).project({ _id: 1, bucketBarcode: 1 }).toArray();

	let remapTotal = 0;
	for (const lr of allLotRecs as any[]) {
		const matchCount = await db.collection('cartridge_records').countDocuments({
			'backing.lotId': lr._id
		});
		if (matchCount === 0) continue;
		remapTotal += matchCount;
		console.log(`  ${lr._id} → ${lr.bucketBarcode}: ${matchCount} carts`);
		if (!dry) {
			await db.collection('cartridge_records').updateMany(
				{ 'backing.lotId': lr._id },
				{ $set: { 'backing.lotId': lr.bucketBarcode, 'backing.parentLotRecordId': lr._id } }
			);
		}
	}
	console.log(`  TOTAL remapped: ${remapTotal}${dry ? ' (dry)' : ''}`);

	// === Step 2: void test-seed orphans (lotId IN ['test','testtt'] or CART-* _id) ===
	console.log('\n=== Step 2: void test-seed CART-* orphans ===');
	const testSeedFilter = {
		$or: [
			{ 'backing.lotId': { $in: ['test', 'testtt'] } },
			{ _id: { $regex: /^CART-/ } }
		],
		status: { $nin: ['voided', 'completed', 'shipped', 'scrapped', 'cancelled'] }
	};
	const testCount = await db.collection('cartridge_records').countDocuments(testSeedFilter);
	console.log(`  Test-seed active carts to void: ${testCount}`);
	if (!dry && testCount > 0) {
		const res = await db.collection('cartridge_records').updateMany(
			testSeedFilter,
			{
				$set: {
					status: 'voided',
					voidedAt: now,
					voidReason: 'Pre-production test seed (backing.lotId IN [test, testtt] or CART-* barcode)'
				}
			}
		);
		console.log(`  Voided: ${res.modifiedCount}`);
	}

	// === Step 3: backfill lineage from parent LotRecord ===
	console.log('\n=== Step 3: copy material lineage onto carts missing it ===');
	// A cart is "missing lineage" if parentLotRecordId is not set. After step 1
	// every post-refactor cart has backing.lotId = bucketBarcode and
	// parentLotRecordId set; pre-refactor carts whose lotId was always the
	// bucketBarcode still lack the material lot fields.
	const pipeline = [
		{ $match: { 'backing.lotId': { $exists: true, $ne: null }, 'backing.cartridgeBlankLot': { $exists: false } } },
		{ $lookup: {
			from: 'lot_records',
			localField: 'backing.lotId',
			foreignField: 'bucketBarcode',
			as: 'lot'
		} },
		{ $unwind: { path: '$lot', preserveNullAndEmptyArrays: false } },
		{ $project: {
			_id: 1,
			lotId: '$lot._id',
			lotQrCode: '$lot.qrCodeRef',
			ovenEntryTime: '$lot.ovenEntryTime',
			inputLots: '$lot.inputLots'
		} }
	];
	const carts = await db.collection('cartridge_records').aggregate(pipeline).toArray();
	console.log(`  Carts matching lineage backfill: ${carts.length}`);

	let wrote = 0;
	if (!dry && carts.length > 0) {
		const bulkOps: any[] = [];
		for (const c of carts as any[]) {
			const inputLots = (c.inputLots ?? []) as any[];
			const cartridgeBlankLot = inputLots.find((l: any) => l.materialName === 'Cartridge')?.barcode ?? null;
			const thermosealLot = inputLots.find((l: any) => l.materialName === 'Thermoseal Laser Cut Sheet')?.barcode ?? null;
			const barcodeLabelLot = inputLots.find((l: any) => l.materialName === 'Barcode')?.barcode ?? null;
			bulkOps.push({
				updateOne: {
					filter: { _id: c._id },
					update: {
						$set: {
							'backing.parentLotRecordId': c.lotId ?? null,
							'backing.lotQrCode': c.lotQrCode ?? null,
							'backing.ovenEntryTime': c.ovenEntryTime ?? null,
							'backing.cartridgeBlankLot': cartridgeBlankLot,
							'backing.thermosealLot': thermosealLot,
							'backing.barcodeLabelLot': barcodeLabelLot
						}
					}
				}
			});
		}
		// chunked bulk writes
		const CHUNK = 500;
		for (let i = 0; i < bulkOps.length; i += CHUNK) {
			const res = await db.collection('cartridge_records').bulkWrite(bulkOps.slice(i, i + CHUNK), { ordered: false });
			wrote += res.modifiedCount ?? 0;
		}
		console.log(`  Wrote lineage on ${wrote} carts`);
	} else if (dry) {
		console.log('  (dry run — no writes)');
	}

	await mongoose.disconnect();
	console.log('\nDone.');
}
main().catch(e => { console.error(e); process.exit(1); });
