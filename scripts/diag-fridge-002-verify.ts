import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const carts = db.collection('cartridge_records');

	const ids30 = Array.from(new Set(
		fs.readFileSync(path.resolve('scripts/data/manual-removal-backfill-2026-04-23.txt'), 'utf8')
			.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
	));
	const set30 = new Set(ids30);

	// The canonical occupancy query used by the fridge-storage page
	// (see src/routes/inventory/fridge-storage/+page.server.ts:66)
	const active = await carts.find({
		'waxStorage.location': 'FRIDGE-002',
		status: 'wax_stored'
	}).project({ _id: 1, 'waxStorage.location': 1, 'waxStorage.coolingTrayId': 1, 'waxStorage.timestamp': 1, status: 1 }).toArray() as any[];
	console.log(`Active FRIDGE-002 occupants (status='wax_stored' AND waxStorage.location='FRIDGE-002'): ${active.length}`);

	const overlap = active.filter((c) => set30.has(c._id));
	console.log(`  of the 30 checked-out cartridges, how many are in this set: ${overlap.length}`);
	if (overlap.length > 0) {
		for (const c of overlap) console.log(`    LEAKED: ${c._id}`);
	}

	// Cross-check: total cartridges that have EVER been in FRIDGE-002 by waxStorage.location,
	// regardless of status
	const everWax = await carts.countDocuments({ 'waxStorage.location': 'FRIDGE-002' });
	console.log(`\nCross-check — total cartridges with waxStorage.location='FRIDGE-002' (any status): ${everWax}`);

	// Status breakdown of everything that has waxStorage.location=FRIDGE-002
	const byStatus = await carts.aggregate([
		{ $match: { 'waxStorage.location': 'FRIDGE-002' } },
		{ $group: { _id: '$status', n: { $sum: 1 } } },
		{ $sort: { n: -1 } }
	]).toArray();
	console.log(`\n  status breakdown among those:`);
	for (const s of byStatus) console.log(`    ${s._id}: ${s.n}`);

	// Tray breakdown of the active 78
	const byTray = await carts.aggregate([
		{ $match: { 'waxStorage.location': 'FRIDGE-002', status: 'wax_stored' } },
		{ $group: { _id: '$waxStorage.coolingTrayId', n: { $sum: 1 } } },
		{ $sort: { n: -1 } }
	]).toArray();
	console.log(`\n  tray breakdown of the active set:`);
	for (const t of byTray) console.log(`    ${t._id ?? '(none)'}: ${t.n}`);

	// Cross-check: what the dashboard uses — it queries the same shape
	// (see src/routes/+page.server.ts:206,257)
	// No additional query needed, but confirm same result:
	console.log(`\n  (Dashboard uses the same query; same result expected.)`);

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
