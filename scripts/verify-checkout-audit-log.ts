import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const URI = process.env.MONGODB_URI;
if (!URI) { console.error('MONGODB_URI missing'); process.exit(1); }

async function main() {
	await mongoose.connect(URI!);
	const db = mongoose.connection.db!;

	// What collections do we have?
	const colls = await db.listCollections().toArray();
	const auditCollNames = colls.map(c => c.name).filter(n => /audit/i.test(n));
	console.log('Audit-related collections:', auditCollNames);

	const recentIds = [
		'7d1d9e18-babb-47d8-ab93-0ca5446599a6',
		'd3b430dc-7293-493f-b212-1d1ee6a47d63',
		'13a0d89a-964d-4159-8248-f59b8f8d78f1',
		'547fd465-09bf-4485-9518-359243188212',
		'b3968df7-f425-46ae-a977-d3881750f294'
	];

	for (const collName of auditCollNames) {
		console.log(`\n=== ${collName} ===`);
		// All entries referencing the 5 carts (any action, any time)
		const all = await db.collection(collName)
			.find({ recordId: { $in: recentIds } })
			.sort({ changedAt: -1 })
			.limit(30)
			.toArray();
		console.log(`Entries referencing the 5 carts (recordId match): ${all.length}`);
		for (const a of all.slice(0, 10)) {
			console.log(`  ${a.changedAt?.toISOString?.() ?? a.changedAt}  action=${a.action}  cart=${a.recordId}  by=${a.changedBy}`);
		}

		// What actions exist in this collection (last 24h)?
		const since = new Date(Date.now() - 24 * 3600 * 1000);
		const recentActions = await db.collection(collName).aggregate([
			{ $match: { changedAt: { $gte: since } } },
			{ $group: { _id: '$action', count: { $sum: 1 } } },
			{ $sort: { count: -1 } }
		]).toArray();
		console.log(`Last-24h actions (count): ${JSON.stringify(recentActions)}`);

		// Specifically find the CHECKOUT case-insensitive
		const checkoutAny = await db.collection(collName)
			.find({ action: { $regex: /checkout/i }, changedAt: { $gte: since } })
			.limit(20)
			.toArray();
		console.log(`Last-24h CHECKOUT-like entries: ${checkoutAny.length}`);
		for (const a of checkoutAny.slice(0, 5)) {
			console.log(`  ${a.changedAt?.toISOString?.() ?? a.changedAt}  action=${a.action}  cart=${a.recordId}  by=${a.changedBy}  newData=${JSON.stringify(a.newData)?.slice(0, 200)}`);
		}
	}

	await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
