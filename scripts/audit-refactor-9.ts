import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const bl = await db.collection('backing_lots').findOne({ _id: '2941bb67-effd-4f87-b5d5-73f9ff840ee3' });
	console.log('BackingLot 2941bb67:', JSON.stringify(bl, null, 2));

	const bl2 = await db.collection('backing_lots').findOne({ _id: '5b867012-5207-4c53-9d28-a1a69ce34924' });
	console.log('\nBackingLot 5b867012:', JSON.stringify(bl2, null, 2));

	// How many total cartridges link to 2941bb67?
	const total = await db.collection('cartridge_records').countDocuments({ 'backing.lotId': '2941bb67-effd-4f87-b5d5-73f9ff840ee3' });
	console.log(`\n2941bb67 backing.lotId cart count (all statuses): ${total}`);
	const byStatus = await db.collection('cartridge_records').aggregate([
		{ $match: { 'backing.lotId': '2941bb67-effd-4f87-b5d5-73f9ff840ee3' } },
		{ $group: { _id: '$status', count: { $sum: 1 } } }
	]).toArray();
	for (const s of byStatus) console.log(`  ${s._id}: ${s.count}`);

	// What's the associated LotRecord produced?
	const lr = await db.collection('lot_records').findOne({ bucketBarcode: '2941bb67-effd-4f87-b5d5-73f9ff840ee3' });
	console.log(`\nLotRecord V1BSHFzMXsNAxYiP59o6b produced=${(lr as any)?.quantityProduced}`);

	// What runs pulled from this lot today?
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const runs = await db.collection('wax_filling_runs').find({
		activeLotId: '2941bb67-effd-4f87-b5d5-73f9ff840ee3',
		createdAt: { $gte: today }
	}).toArray();
	console.log(`\nToday's runs pulling from 2941bb67: ${runs.length}`);
	let totalPulled = 0;
	for (const r of runs) {
		const ra = r as any;
		console.log(`  ${r._id} carts=${ra.cartridgeIds?.length} created=${ra.createdAt}`);
		totalPulled += ra.cartridgeIds?.length ?? 0;
	}
	console.log(`  TOTAL PULLED FROM LOT TODAY: ${totalPulled}`);
	console.log(`  LOT QUANTITY PRODUCED: ${(lr as any)?.quantityProduced}`);
	console.log(`  OVER-PULL? ${totalPulled > ((lr as any)?.quantityProduced ?? 0) ? 'YES' : 'NO'}`);

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
