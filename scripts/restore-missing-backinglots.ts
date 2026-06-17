/**
 * Two LotRecords from Apr 21 (dMNfZ8QkXRwkDE17Xr_i6, f5-lOyNLCw82bSzVyzp82) have
 * bucketBarcodes that don't exist in backing_lots. Their 48 cartridges are live
 * (status=wax_stored) but their lineage chain is broken. Backfill the missing
 * BackingLots as status='consumed' so joins resolve.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
(async () => {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const now = new Date();

	const lrs = await db.collection('lot_records').find({
		bucketBarcode: { $in: ['fde9a2aa-75d6-4c91-9d3f-8be8bb7b5675', 'ffda9702-33fb-423c-ad76-b6d2d7f1c916'] }
	}).toArray();

	for (const lr of lrs as any[]) {
		const existing = await db.collection('backing_lots').findOne({ _id: lr.bucketBarcode });
		if (existing) {
			console.log(`  BackingLot ${lr.bucketBarcode} already exists — skipping`);
			continue;
		}
		// Infer the oven from ovenPlacement if present, else leave null
		const ovenLocationId = lr.ovenPlacement?.ovenId ?? null;
		const ovenLocationName = lr.ovenPlacement?.ovenBarcode ?? null;
		await db.collection('backing_lots').insertOne({
			_id: lr.bucketBarcode,
			lotType: 'backing',
			ovenEntryTime: lr.ovenEntryTime ?? lr.finishTime ?? now,
			ovenLocationId,
			ovenLocationName,
			operator: lr.operator ?? { _id: 'system', username: 'system-backfill' },
			cartridgeCount: 0,
			status: 'consumed',
			createdAt: lr.finishTime ?? now,
			updatedAt: now
		});
		console.log(`  Created BackingLot ${lr.bucketBarcode} (status=consumed, ovenLoc=${ovenLocationId ?? 'none'}) for LotRecord ${lr._id}`);
	}
	await mongoose.disconnect();
})();
