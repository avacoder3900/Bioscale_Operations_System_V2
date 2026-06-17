import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
const URI = process.env.MONGODB_URI!;

async function main() {
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;

	console.log('=== BackingLots in Oven 1 — full picture ===\n');
	const lots = await db.collection('backing_lots').find({
		ovenLocationId: 'IWSsrS9Q4zSkkFS0xdMob'
	}).toArray();
	for (const l of lots as any[]) {
		console.log(`  _id=${l._id}  status=${l.status}  cartridgeCount=${l.cartridgeCount}  entry=${l.ovenEntryTime?.toISOString?.() ?? l.ovenEntryTime}`);
	}

	console.log('\n=== Cartridges linked to each lot (by backing.lotId) ===');
	for (const l of lots as any[]) {
		const byStatus = await db.collection('cartridge_records').aggregate([
			{ $match: { 'backing.lotId': l._id } },
			{ $group: { _id: '$status', n: { $sum: 1 } } },
			{ $sort: { n: -1 } }
		]).toArray();
		console.log(`  lot=${l._id} (cartridgeCount=${l.cartridgeCount}):`);
		let linked = 0;
		for (const s of byStatus) { console.log(`    status=${s._id}  n=${s.n}`); linked += s.n; }
		console.log(`    TOTAL cartridges linked: ${linked}`);
	}

	console.log('\n=== "Still in oven" cartridges = CartridgeRecord.status=backing per lot ===');
	for (const l of lots as any[]) {
		const stillBacking = await db.collection('cartridge_records').countDocuments({
			'backing.lotId': l._id,
			status: 'backing'
		});
		console.log(`  lot=${l._id}  stillBacking=${stillBacking}  (dashboard would show ${l.cartridgeCount})`);
	}

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
