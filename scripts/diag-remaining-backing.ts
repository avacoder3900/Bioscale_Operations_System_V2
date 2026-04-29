import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
(async () => {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	const total = await db.collection('cartridge_records').countDocuments({ status: 'backing' });
	console.log(`Total status=backing: ${total}`);

	const byLot = await db.collection('cartridge_records').aggregate([
		{ $match: { status: 'backing' } },
		{ $group: { _id: '$backing.lotId', n: { $sum: 1 }, sample: { $first: '$_id' } } }
	]).toArray();
	console.log('By backing.lotId:');
	for (const g of byLot as any[]) console.log(`  lotId=${g._id ?? 'NULL/MISSING'}  count=${g.n}  sampleId=${g.sample}`);

	// For each lotId, find the LotRecord
	for (const g of byLot as any[]) {
		if (!g._id) continue;
		const lr = await db.collection('lot_records').findOne({ _id: g._id });
		if (!lr) {
			console.log(`  LotRecord ${g._id} NOT FOUND`);
			continue;
		}
		console.log(`  LotRecord ${g._id}: bucketBarcode=${(lr as any).bucketBarcode}  status=${(lr as any).status}`);
		// Does this bucketBarcode match a BackingLot?
		const bl = await db.collection('backing_lots').findOne({ _id: (lr as any).bucketBarcode });
		if (bl) console.log(`    matching BackingLot status=${(bl as any).status}`);
		else console.log(`    NO BackingLot with _id='${(lr as any).bucketBarcode}'`);
	}

	await mongoose.disconnect();
})();
