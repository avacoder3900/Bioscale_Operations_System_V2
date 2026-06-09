import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
const URI = process.env.MONGODB_URI!;

async function main() {
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;

	console.log('=== All CartridgeRecords with status=wax_stored ===');
	const all = await db.collection('cartridge_records').find({ status: 'wax_stored' })
		.project({ _id: 1, status: 1, waxStorage: 1, storage: 1, 'reagentFilling.runId': 1, 'waxFilling.runId': 1, 'backing.lotId': 1 })
		.toArray();
	console.log(`Count: ${all.length}`);
	for (const c of all as any[]) {
		console.log(`  ${c._id}  waxStorage.location=${c.waxStorage?.location}  coolingTrayId=${c.waxStorage?.coolingTrayId}  operator=${c.waxStorage?.operator?.username}  ts=${c.waxStorage?.timestamp?.toISOString?.()}  storage.fridgeName=${c.storage?.fridgeName}  backing.lotId=${c.backing?.lotId}`);
	}

	console.log('\n=== Group by waxStorage.location ===');
	const byLoc = new Map<string, number>();
	for (const c of all as any[]) {
		const k = c.waxStorage?.location ?? '(null)';
		byLoc.set(k, (byLoc.get(k) ?? 0) + 1);
	}
	for (const [k, n] of byLoc) console.log(`  location="${k}"  n=${n}`);

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
