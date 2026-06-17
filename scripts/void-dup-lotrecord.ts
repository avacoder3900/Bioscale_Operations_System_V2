import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
(async () => {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	// For every consumed BackingLot, find ALL LotRecords (not just one) whose bucketBarcode matches.
	const consumed = await db.collection('backing_lots').find({ status: 'consumed' }).project({ _id: 1 }).toArray();
	const consumedIds = (consumed as any[]).map(b => b._id);
	const allLotRecs = await db.collection('lot_records').find({ bucketBarcode: { $in: consumedIds } }).project({ _id: 1 }).toArray();
	const lotIds = (allLotRecs as any[]).map(l => l._id);
	console.log('LotRecord._ids tied to consumed BackingLots:', lotIds);
	const r = await db.collection('cartridge_records').updateMany(
		{ status: 'backing', 'backing.lotId': { $in: lotIds } },
		{
			$set: {
				status: 'voided',
				voidedAt: new Date(),
				voidReason: 'Backing lot consumed via wax filling — WI-01 placeholder record superseded by scanned deck barcodes'
			}
		}
	);
	console.log('Voided:', r.modifiedCount);
	await mongoose.disconnect();
})();
