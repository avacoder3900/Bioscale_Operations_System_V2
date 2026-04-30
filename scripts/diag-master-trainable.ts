/**
 * Confirm the master project exists and how many labeled images would feed
 * its training run. Run: npx tsx scripts/diag-master-trainable.ts
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	const master = await db.collection('cv_projects').findOne({ isMasterModel: true });
	console.log('--- Master project ---');
	if (master) {
		console.log(`  _id:               ${master._id}`);
		console.log(`  name:              ${master.name}`);
		console.log(`  modelStatus:       ${master.modelStatus}`);
		console.log(`  confidenceThreshold: ${master.confidenceThreshold}`);
		console.log(`  purpose:           ${(master.purpose ?? '').slice(0, 80)}`);
	} else {
		console.log('  not yet created — visit /cv/master in browser to auto-create');
	}

	console.log('\n--- Labeled image counts (fleet-wide) ---');
	const counts = await db.collection('cv_images').aggregate([
		{ $match: { label: { $ne: null } } },
		{ $group: { _id: '$label', count: { $sum: 1 } } }
	]).toArray();
	let total = 0;
	for (const c of counts) { console.log(`  ${c._id}: ${c.count}`); total += c.count; }
	console.log(`  TOTAL labeled: ${total}`);
	console.log(`  trainable: ${total >= 5 ? 'YES' : `NO — need ${5 - total} more labeled images`}`);

	await mongoose.disconnect();
	process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
