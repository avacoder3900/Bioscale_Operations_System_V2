import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	// Prefix search — screenshot may have truncated / I may have misread a char
	const prefix = '56cef900';
	const matches = await db.collection('cartridge_records').find({ _id: { $regex: `^${prefix}` } as any }).toArray();
	console.log(`=== PREFIX MATCHES for "${prefix}" ===`);
	for (const c of matches as any[]) {
		console.log(`  _id=${c._id}`);
		console.log(`    status=${c.status}  createdAt=${c.createdAt}`);
		console.log(`    waxStorage: ${JSON.stringify(c.waxStorage)?.slice(0, 140)}`);
		console.log(`    storage:    ${JSON.stringify(c.storage)?.slice(0, 140)}`);
		console.log(`    reagentFilling: present=${!!c.reagentFilling} runId=${c.reagentFilling?.runId}`);
	}

	console.log('\n=== STATUS HISTOGRAM ===');
	const statusHist = await db.collection('cartridge_records').aggregate([
		{ $group: { _id: '$status', n: { $sum: 1 } } },
		{ $sort: { n: -1 } }
	]).toArray();
	for (const row of statusHist as any[]) console.log(`  ${row._id}: ${row.n}`);

	console.log('\n=== SAMPLE "stored" CARTRIDGES (for lifecycle context) ===');
	const samples = await db.collection('cartridge_records').find({ status: 'stored' })
		.project({ _id: 1, 'storage.fridgeName': 1, 'storage.recordedAt': 1, 'waxStorage.location': 1, 'waxStorage.recordedAt': 1, 'reagentFilling.recordedAt': 1 })
		.limit(5).toArray();
	for (const s of samples as any[]) {
		console.log(`  ${s._id}`);
		console.log(`    waxStorage.recordedAt: ${s.waxStorage?.recordedAt}  location=${s.waxStorage?.location}`);
		console.log(`    reagentFilling.recordedAt: ${s.reagentFilling?.recordedAt}`);
		console.log(`    storage.recordedAt: ${s.storage?.recordedAt}  fridge=${s.storage?.fridgeName}`);
	}

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
