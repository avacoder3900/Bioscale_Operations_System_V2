/**
 * Cross-check each stale BackingLot against the cartridge_records collection.
 * For each lot in status in_oven/ready/created, report:
 *   - cartridgeCount on the lot doc
 *   - actual count of CartridgeRecords whose backing.lotId === lot._id
 *   - status breakdown of those cartridges
 * This tells us which lots are pure fixtures (no carts), orphans (carts have
 * moved on), or genuinely awaiting consumption.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	const lots = await db.collection('backing_lots').find({
		status: { $in: ['in_oven', 'ready', 'created'] }
	}).toArray() as any[];

	console.log(`Found ${lots.length} stale backing lots\n`);

	for (const lot of lots) {
		const carts = await db.collection('cartridge_records').find({
			'backing.lotId': lot._id
		}).project({ _id: 1, status: 1 }).toArray() as any[];

		const statusBreakdown: Record<string, number> = {};
		for (const c of carts) {
			const s = c.status ?? 'null';
			statusBreakdown[s] = (statusBreakdown[s] ?? 0) + 1;
		}

		const stillInBacking = carts.filter(c => c.status === 'backing').length;
		const movedOn = carts.length - stillInBacking;

		console.log(`Lot ${lot._id}`);
		console.log(`  lot.status=${lot.status}  lot.cartridgeCount=${lot.cartridgeCount}`);
		console.log(`  actual carts attached: ${carts.length}  (stillBacking=${stillInBacking}  movedOn=${movedOn})`);
		console.log(`  status breakdown: ${JSON.stringify(statusBreakdown)}`);
		console.log('');
	}

	await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
