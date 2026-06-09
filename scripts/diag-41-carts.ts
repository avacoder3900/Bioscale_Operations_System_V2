import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
const URI = process.env.MONGODB_URI!;

async function main() {
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;

	for (const runId of ['4Z6AldZWCJ8EC_QG0pe2N', '6o29m5Jre1aqGTXJ-fZdL']) {
		console.log(`=== Run ${runId} cartridges — sample of backing.lotId values ===`);
		const byBacking = await db.collection('cartridge_records').aggregate([
			{ $match: { 'waxFilling.runId': runId } },
			{ $group: { _id: '$backing.lotId', n: { $sum: 1 } } }
		]).toArray();
		for (const g of byBacking) console.log(`  backing.lotId=${g._id ?? '(null)'}  count=${g.n}`);
		console.log('');
	}

	// Were the 41 cartridges brand-new (not previously existing in status=backing)?
	// Check creation times.
	const sample = await db.collection('cartridge_records').find({
		$or: [{ 'waxFilling.runId': '4Z6AldZWCJ8EC_QG0pe2N' }, { 'waxFilling.runId': '6o29m5Jre1aqGTXJ-fZdL' }]
	}).project({ _id: 1, createdAt: 1, 'backing.lotId': 1, 'backing.recordedAt': 1, 'waxFilling.runStartTime': 1 }).limit(5).toArray();
	console.log('Sample 5 cartridges:');
	for (const c of sample as any[]) {
		console.log(`  ${c._id}  createdAt=${c.createdAt?.toISOString?.()}  backingRecorded=${c.backing?.recordedAt?.toISOString?.() ?? '(none)'}  backingLotId=${c.backing?.lotId ?? '(none)'}`);
	}

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
