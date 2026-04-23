import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
(async () => {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	console.log('=== Duplicate LotRecords per bucketBarcode ===');
	const dups = await db.collection('lot_records').aggregate([
		{ $match: { bucketBarcode: { $exists: true, $ne: null } } },
		{ $group: { _id: '$bucketBarcode', rows: { $sum: 1 }, ids: { $push: '$_id' }, qtys: { $push: '$quantityProduced' }, finished: { $push: '$finishTime' } } },
		{ $match: { rows: { $gt: 1 } } }
	]).toArray();
	for (const d of dups as any[]) {
		console.log(`  bucket=${d._id}  count=${d.rows}`);
		for (let i = 0; i < d.ids.length; i++) {
			console.log(`    ${d.ids[i]}  qty=${d.qtys[i]}  finished=${d.finished[i]?.toISOString?.() ?? d.finished[i]}`);
		}
	}

	console.log('\n=== 2941bb67 over-pull details ===');
	const bucket2941 = '2941bb67-effd-4f87-b5d5-73f9ff840ee3';
	const lr = await db.collection('lot_records').findOne({ bucketBarcode: bucket2941 });
	const bl = await db.collection('backing_lots').findOne({ _id: bucket2941 });
	console.log(`LotRecord: _id=${lr?._id}  qProd=${(lr as any)?.quantityProduced}  finished=${(lr as any)?.finishTime?.toISOString?.()}`);
	console.log(`BackingLot: cartridgeCount=${(bl as any)?.cartridgeCount}  status=${(bl as any)?.status}`);
	const pulled = await db.collection('cartridge_records').aggregate([
		{ $match: { 'backing.lotId': bucket2941 } },
		{ $group: { _id: '$status', n: { $sum: 1 } } }
	]).toArray();
	console.log(`Pulled cartridges from 2941bb67:`);
	let total = 0;
	for (const p of pulled as any[]) { console.log(`  status=${p._id}  n=${p.n}`); total += p.n; }
	console.log(`Total pulled: ${total}  (LotRecord claimed ${(lr as any)?.quantityProduced}) → over/under = ${total - ((lr as any)?.quantityProduced ?? 0)}`);

	// Enumerate the 4 runs that pulled from 2941bb67
	console.log('\n=== WaxFillingRuns with activeLotId=2941bb67 ===');
	const runs = await db.collection('wax_filling_runs').find({ activeLotId: bucket2941 }).sort({ createdAt: 1 }).toArray();
	for (const r of runs as any[]) {
		console.log(`  run=${r._id}  status=${r.status}  plannedCartridgeCount=${r.plannedCartridgeCount}  cartridgeIds.length=${(r.cartridgeIds ?? []).length}  createdAt=${r.createdAt?.toISOString?.()}`);
	}

	await mongoose.disconnect();
})();
