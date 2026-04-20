import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
const URI = process.env.MONGODB_URI;
if (!URI) { console.error('MONGODB_URI missing'); process.exit(1); }
async function main() {
	await mongoose.connect(URI!);
	const db = mongoose.connection.db!;

	console.log('=== Consumables (incubator_tube) ===');
	const tubes = await db.collection('consumables').find({ type: 'incubator_tube' }).project({ _id:1, status:1, type:1, remainingVolumeUl:1 }).limit(10).toArray();
	console.log(JSON.stringify(tubes, null, 2));

	console.log('\n=== ReceivingLots (PT-CT-110 or PT-CT-114, qty > 0) ===');
	const waxLots = await db.collection('receivinglots').find({
		'part.partNumber': { $in: ['PT-CT-110', 'PT-CT-114'] },
		quantity: { $gt: 0 }
	}).project({ _id:1, lotId:1, lotNumber:1, bagBarcode:1, quantity:1, 'part.partNumber':1, 'part.name':1, status:1 }).limit(20).toArray();
	console.log(JSON.stringify(waxLots, null, 2));

	console.log('\n=== ReceivingLots (any with "wax" in part name, qty > 0) ===');
	const waxByName = await db.collection('receivinglots').find({
		'part.name': { $regex: /wax/i },
		quantity: { $gt: 0 }
	}).project({ _id:1, lotId:1, lotNumber:1, bagBarcode:1, quantity:1, 'part.partNumber':1, 'part.name':1, status:1 }).limit(20).toArray();
	console.log(JSON.stringify(waxByName, null, 2));

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
