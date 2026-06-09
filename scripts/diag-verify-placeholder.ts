import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
const URI = process.env.MONGODB_URI!;

async function main() {
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;

	for (const pn of ['PT-CT-104', 'PT-CT-106']) {
		const p = await db.collection('part_definitions').findOne({ partNumber: pn });
		console.log(`${pn} inventoryCount=${(p as any)?.inventoryCount}`);
	}
	const lots = await db.collection('receiving_lots').find({ lotId: /^PLACEHOLDER/ }).toArray();
	for (const l of lots as any[]) {
		console.log(`  lot ${l.lotId}  partNumber=${l.part?.partNumber}  qty=${l.quantity}  lotNumber=${l.lotNumber}  status=${l.status}`);
	}
	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
