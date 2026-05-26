import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	console.log('=== BackingLot status breakdown (all) ===');
	const byStatus = await db.collection('backing_lots').aggregate([
		{ $group: { _id: '$status', count: { $sum: 1 }, totalCartridges: { $sum: '$cartridgeCount' } } },
		{ $sort: { count: -1 } }
	]).toArray();
	for (const g of byStatus) console.log(`  status=${JSON.stringify(g._id)}  lots=${g.count}  cartridges=${g.totalCartridges}`);

	console.log('\n=== BackingLots in dashboard query (in_oven/ready/created) ===');
	const lots = await db.collection('backing_lots').find({
		status: { $in: ['in_oven', 'ready', 'created'] }
	}).toArray() as any[];
	console.log(`  total lots: ${lots.length}`);
	console.log(`  total cartridgeCount sum: ${lots.reduce((s,l) => s + (l.cartridgeCount ?? 0), 0)}`);

	const minOvenTimeMin = 60;
	const now = Date.now();
	const ready = lots.filter(l => {
		if (!l.ovenEntryTime) return false;
		return (now - new Date(l.ovenEntryTime).getTime()) / 60000 >= minOvenTimeMin;
	});
	console.log(`  ready lots (>60 min in oven): ${ready.length}`);
	console.log(`  ready totalReadyCartridges: ${ready.reduce((s,l) => s + (l.cartridgeCount ?? 0), 0)}`);

	console.log('\n=== Lot detail ===');
	for (const l of lots) {
		const entryMs = l.ovenEntryTime ? new Date(l.ovenEntryTime).getTime() : 0;
		const elapsedMin = entryMs ? Math.floor((now - entryMs) / 60000) : null;
		console.log(`  _id=${l._id}  status=${l.status}  cartridgeCount=${l.cartridgeCount}  elapsedMin=${elapsedMin}`);
	}

	await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
