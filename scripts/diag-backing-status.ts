import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
const URI = process.env.MONGODB_URI!;

async function main() {
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;

	console.log('=== All cartridges with status=backing — grouped by backing.lotId ===');
	const byLot = await db.collection('cartridge_records').aggregate([
		{ $match: { status: 'backing' } },
		{ $group: { _id: '$backing.lotId', n: { $sum: 1 }, sampleIds: { $push: '$_id' } } },
		{ $sort: { n: -1 } }
	]).toArray();
	for (const g of byLot) {
		console.log(`  lotId=${g._id ?? '(null)'}  count=${g.n}`);
	}

	console.log('\n=== LotRecord documents (WI-01 lots) matching those lotIds ===');
	for (const g of byLot as any[]) {
		if (!g._id) continue;
		const lot = await db.collection('lot_records').findOne({ _id: g._id });
		if (lot) {
			console.log(`  LotRecord ${lot._id}: bucketBarcode=${lot.bucketBarcode}  status=${lot.status}  quantityProduced=${lot.quantityProduced}  ovenEntry=${lot.ovenEntryTime?.toISOString?.()}`);
		} else {
			console.log(`  LotRecord ${g._id}: NOT FOUND`);
		}
	}

	console.log('\n=== If we summed CartridgeRecord.status=backing per oven using BackingLot lookup via bucketBarcode ===');
	// For each BackingLot in oven, find the LotRecord whose bucketBarcode matches BackingLot._id, then count its cartridges that are still 'backing'
	const backingLots = await db.collection('backing_lots').find({
		status: { $in: ['in_oven', 'ready'] },
		ovenLocationId: { $exists: true, $ne: null }
	}).toArray();
	for (const bl of backingLots as any[]) {
		// Find LotRecord whose bucketBarcode = this BackingLot._id
		const lotRec = await db.collection('lot_records').findOne({ bucketBarcode: bl._id });
		let stillBacking = 0;
		let lotLotId: string | null = null;
		if (lotRec) {
			lotLotId = lotRec._id;
			stillBacking = await db.collection('cartridge_records').countDocuments({
				'backing.lotId': lotRec._id,
				status: 'backing'
			});
		}
		// Also fall back to BackingLot._id as backing.lotId (for cartridges already pulled into wax)
		const byBackingLotId = await db.collection('cartridge_records').countDocuments({
			'backing.lotId': bl._id,
			status: 'backing'
		});
		console.log(`  BackingLot=${bl._id}  LotRecord.lotId=${lotLotId}  stillBackingByLotId=${stillBacking}  stillBackingByBucketId=${byBackingLotId}  cartridgeCountField=${bl.cartridgeCount}`);
	}

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
