import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const ids = Array.from(new Set(
		fs.readFileSync(path.resolve('scripts/data/manual-removal-backfill-2026-04-23.txt'), 'utf8')
			.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
	));
	console.log(`${ids.length} unique IDs`);

	const byStatus = await db.collection('cartridge_records').aggregate([
		{ $match: { _id: { $in: ids } } },
		{ $group: { _id: '$status', n: { $sum: 1 } } }
	]).toArray();
	console.log('\nCurrent status distribution of target IDs:');
	for (const s of byStatus) console.log(`  ${s._id}: ${s.n}`);

	const retracted = await db.collection('inventory_transactions').countDocuments({
		cartridgeRecordId: { $in: ids },
		transactionType: 'scrap',
		retractedAt: { $exists: true }
	});
	const live = await db.collection('inventory_transactions').countDocuments({
		cartridgeRecordId: { $in: ids },
		transactionType: 'scrap',
		retractedAt: { $exists: false }
	});
	console.log(`\nScrap InventoryTransactions for these 30 cartridges:`);
	console.log(`  retracted: ${retracted}`);
	console.log(`  live:      ${live}`);

	const removals = await db.collection('manual_cartridge_removals').countDocuments({
		cartridgeIds: { $in: ids }
	});
	console.log(`\nManualCartridgeRemoval docs referencing these cartridges: ${removals}`);

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
