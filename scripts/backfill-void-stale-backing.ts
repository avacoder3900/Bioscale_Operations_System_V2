/**
 * Void WI-01 placeholder CartridgeRecords whose BackingLot has already been
 * consumed. These are the stubs that never got advanced past status='backing'
 * because wax filling scans fresh barcodes rather than the WI-01 Avery labels.
 *
 * Run after backfill-wax-qc-and-backing.ts (which sets BackingLot.status='consumed'
 * on the fully-drained lots). Idempotent.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
const URI = process.env.MONGODB_URI!;

async function main() {
	const dry = process.argv.includes('--dry');
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;
	const now = new Date();

	// Consumed-lot placeholders: LotRecord.bucketBarcode -> BackingLot._id where status='consumed'
	const consumed = await db.collection('backing_lots').find({ status: 'consumed' }).toArray();
	const consumedLotRecordIds: string[] = [];
	for (const bl of consumed as any[]) {
		const lotRec = await db.collection('lot_records').findOne({ bucketBarcode: bl._id });
		if (lotRec) consumedLotRecordIds.push(lotRec._id);
	}

	const voidableFromConsumed = await db.collection('cartridge_records').countDocuments({
		'backing.lotId': { $in: consumedLotRecordIds },
		status: 'backing'
	});

	// Orphan placeholders: status='backing' with a backing.lotId that doesn't match
	// ANY BackingLot (via bucketBarcode). Safe to void — no oven to live in.
	const allBackingLots = await db.collection('backing_lots').find({}).toArray();
	const allLotRecords = await db.collection('lot_records').find({
		bucketBarcode: { $in: (allBackingLots as any[]).map((bl: any) => bl._id) }
	}).toArray();
	const knownLotIds = new Set((allLotRecords as any[]).map((l: any) => l._id));

	const allBackingStubs = await db.collection('cartridge_records').find({
		status: 'backing',
		'backing.lotId': { $exists: true, $ne: null }
	}).project({ _id: 1, 'backing.lotId': 1 }).toArray();
	const orphanIds = (allBackingStubs as any[])
		.filter((c: any) => !knownLotIds.has(c.backing.lotId))
		.map((c: any) => c._id);

	console.log(`=== Void plan ===`);
	console.log(`  Placeholders on consumed lots: ${voidableFromConsumed}`);
	console.log(`  Orphan placeholders (lotId unmapped to any BackingLot): ${orphanIds.length}`);
	console.log(`  Placeholders kept (lots still in_oven/ready): will remain as status='backing'`);

	if (dry) {
		console.log('\n(dry run — no writes)');
		await mongoose.disconnect();
		return;
	}

	const res1 = await db.collection('cartridge_records').updateMany(
		{ 'backing.lotId': { $in: consumedLotRecordIds }, status: 'backing' },
		{
			$set: {
				status: 'voided',
				voidedAt: now,
				voidReason: 'Backing lot consumed via wax filling — WI-01 placeholder record superseded by scanned deck barcodes'
			}
		}
	);
	console.log(`\n  consumed-lot placeholders: matched=${res1.matchedCount}  modified=${res1.modifiedCount}`);

	if (orphanIds.length > 0) {
		const res2 = await db.collection('cartridge_records').updateMany(
			{ _id: { $in: orphanIds } },
			{
				$set: {
					status: 'voided',
					voidedAt: now,
					voidReason: 'Orphan WI-01 placeholder — backing.lotId does not resolve to any BackingLot'
				}
			}
		);
		console.log(`  orphan placeholders: matched=${res2.matchedCount}  modified=${res2.modifiedCount}`);
	}

	await mongoose.disconnect();
	console.log('\nDone.');
}
main().catch(e => { console.error(e); process.exit(1); });
