import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
(async () => {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const bl = await db.collection('backing_lots').findOne({ _id: 'fde9a2aa-75d6-4c91-9d3f-8be8bb7b5675' });
	console.log('BackingLot fde9a2aa:', bl ?? 'NOT FOUND');
	const lrs = await db.collection('lot_records').find({ bucketBarcode: 'fde9a2aa-75d6-4c91-9d3f-8be8bb7b5675' }).project({_id:1,status:1,quantityProduced:1,finishTime:1}).toArray();
	console.log('LotRecords pointing at fde9a2aa:', lrs);
	const bl2 = await db.collection('backing_lots').findOne({ _id: 'ffda9702-33fb-423c-ad76-b6d2d7f1c916' });
	console.log('\nBackingLot ffda9702:', bl2 ?? 'NOT FOUND');
	const lrs2 = await db.collection('lot_records').find({ bucketBarcode: 'ffda9702-33fb-423c-ad76-b6d2d7f1c916' }).project({_id:1,status:1,quantityProduced:1,finishTime:1}).toArray();
	console.log('LotRecords pointing at ffda9702:', lrs2);
	await mongoose.disconnect();
})();
