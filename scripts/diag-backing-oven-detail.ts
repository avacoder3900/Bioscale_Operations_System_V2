import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	const activeBuckets = await db.collection('backing_lots').find({
		status: { $in: ['in_oven', 'ready'] }
	}).toArray();

	console.log(`Active BackingLots: ${activeBuckets.length}\n`);
	for (const b of activeBuckets as any[]) {
		console.log(`_id: ${b._id}`);
		console.log(`  status: ${b.status}`);
		console.log(`  cartridgeCount: ${b.cartridgeCount}`);
		console.log(`  bucketBarcode: ${b.bucketBarcode}`);
		console.log(`  oven-relevant fields:`);
		for (const k of Object.keys(b)) {
			if (/oven|location|equipment/i.test(k)) console.log(`    ${k}: ${JSON.stringify(b[k])}`);
		}
		console.log(`  ovenEntryTime: ${b.ovenEntryTime}`);
		console.log(`  createdAt: ${b.createdAt}`);
		console.log('');
	}
	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
