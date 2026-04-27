/**
 * Show all fridges and their current temperature thresholds.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	const fridges = await db
		.collection('equipment')
		.find({ equipmentType: 'fridge' })
		.toArray();

	console.log(`Fridges total: ${fridges.length}\n`);
	for (const f of fridges as any[]) {
		console.log(`  ${f._id}  name=${f.name ?? '(none)'}  barcode=${f.barcode ?? '(none)'}  status=${f.status}`);
		console.log(`    temperatureMinC=${f.temperatureMinC ?? '(unset)'}  temperatureMaxC=${f.temperatureMaxC ?? '(unset)'}`);
	}

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
