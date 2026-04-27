import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	const waxStored = await db.collection('cartridge_records').countDocuments({ status: 'wax_stored' });

	const bucketSum = await db.collection('backing_lots').aggregate([
		{ $match: { status: { $in: ['in_oven', 'ready'] } } },
		{ $group: { _id: '$status', totalInBuckets: { $sum: '$cartridgeCount' }, lotCount: { $sum: 1 } } }
	]).toArray();

	const bucketsByOven = await db.collection('backing_lots').aggregate([
		{ $match: { status: { $in: ['in_oven', 'ready'] } } },
		{ $group: { _id: { oven: '$ovenId', ovenName: '$ovenName', status: '$status' }, cartridgeCount: { $sum: '$cartridgeCount' }, bucketCount: { $sum: 1 } } },
		{ $sort: { '_id.oven': 1 } }
	]).toArray();

	const byWaxLocation = await db.collection('cartridge_records').aggregate([
		{ $match: { status: 'wax_stored' } },
		{ $group: { _id: '$waxStorage.location', n: { $sum: 1 } } },
		{ $sort: { n: -1 } }
	]).toArray();

	console.log('=== WAX STORED ===');
	console.log(`Total wax_stored cartridges: ${waxStored}`);
	console.log('By location:');
	for (const row of byWaxLocation as any[]) console.log(`  ${row._id ?? '<null>'}: ${row.n}`);

	console.log('\n=== BACKING (in oven) ===');
	console.log('Summary by BackingLot status:');
	for (const row of bucketSum as any[]) console.log(`  ${row._id}: ${row.totalInBuckets} cartridges across ${row.lotCount} lot(s)`);

	console.log('\nBy oven:');
	for (const row of bucketsByOven as any[]) {
		const k = row._id;
		console.log(`  ${k.ovenName ?? k.oven ?? '<null>'}  [${k.status}]  → ${row.cartridgeCount} cartridges in ${row.bucketCount} bucket(s)`);
	}

	const statusHist = await db.collection('cartridge_records').aggregate([
		{ $group: { _id: '$status', n: { $sum: 1 } } },
		{ $sort: { n: -1 } }
	]).toArray();
	console.log('\n=== FULL STATUS HISTOGRAM (all cartridges, for context) ===');
	for (const row of statusHist as any[]) console.log(`  ${row._id}: ${row.n}`);

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
