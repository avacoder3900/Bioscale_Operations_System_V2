/**
 * Diagnose oven cartridge count discrepancy.
 * Operator reports 37 cartridges physically in oven; system shows fewer.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	console.log('=== 1. Cartridges by status (whole table) ===\n');
	const allByStatus = await db
		.collection('cartridge_records')
		.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }, { $sort: { n: -1 } }])
		.toArray();
	for (const r of allByStatus) console.log(`  ${r._id ?? '(no status)'}: ${r.n}`);
	console.log('');

	console.log('=== 2. Cartridges with NO waxFilling.runId, by status ===\n');
	const noWaxByStatus = await db
		.collection('cartridge_records')
		.aggregate([
			{ $match: { 'waxFilling.runId': { $exists: false } } },
			{ $group: { _id: '$status', n: { $sum: 1 } } },
			{ $sort: { n: -1 } }
		])
		.toArray();
	for (const r of noWaxByStatus) console.log(`  ${r._id ?? '(no status)'}: ${r.n}`);
	console.log('');

	console.log('=== 3. Cartridges with waxFilling.runId set, grouped by run.status ===\n');
	const cartsWaxLinked = await db
		.collection('cartridge_records')
		.find({ 'waxFilling.runId': { $exists: true } })
		.project({ _id: 1, status: 1, 'waxFilling.runId': 1, 'backing.ovenEntryTime': 1 })
		.toArray();

	const runIds = Array.from(new Set((cartsWaxLinked as any[]).map((c) => String(c.waxFilling.runId))));
	const runs = await db
		.collection('wax_filling_runs')
		.find({ _id: { $in: runIds } })
		.project({ _id: 1, status: 1, runStartTime: 1, runEndTime: 1 })
		.toArray();
	const runStatusById = new Map((runs as any[]).map((r) => [String(r._id), r.status]));

	const grouping = new Map<string, number>();
	for (const c of cartsWaxLinked as any[]) {
		const rs = runStatusById.get(String(c.waxFilling.runId)) ?? '(run not found)';
		const cs = c.status ?? '(no status)';
		const key = `runStatus=${rs} | cartStatus=${cs}`;
		grouping.set(key, (grouping.get(key) ?? 0) + 1);
	}
	for (const [k, n] of [...grouping.entries()].sort((a, b) => b[1] - a[1])) {
		console.log(`  ${k}: ${n}`);
	}
	console.log('');

	console.log('=== 4. ACTIVE wax runs (status not "completed") and their cartridges ===\n');
	const activeRuns = await db
		.collection('wax_filling_runs')
		.find({ status: { $nin: ['completed'] } })
		.toArray();
	for (const r of activeRuns as any[]) {
		const carts = await db
			.collection('cartridge_records')
			.find({ 'waxFilling.runId': String(r._id) })
			.project({ _id: 1, status: 1, 'backing.lotId': 1, 'backing.ovenEntryTime': 1, 'ovenCure.entryTime': 1, 'ovenCure.exitTime': 1 })
			.toArray();
		console.log(`  run=${r._id}  status=${r.status}  start=${r.runStartTime}  end=${r.runEndTime}  cartridges_linked=${carts.length}`);
		const byCartStatus = new Map<string, number>();
		for (const c of carts as any[]) {
			byCartStatus.set(c.status, (byCartStatus.get(c.status) ?? 0) + 1);
		}
		for (const [s, n] of byCartStatus) console.log(`    cart.status=${s}: ${n}`);
	}
	console.log('');

	console.log('=== 5. ALL BackingLots, grouped by status ===\n');
	const lotsByStatus = await db
		.collection('backing_lots')
		.aggregate([{ $group: { _id: '$status', n: { $sum: 1 }, qty: { $sum: '$cartridgeCount' } } }])
		.toArray();
	for (const r of lotsByStatus) console.log(`  status=${r._id}: ${r.n} lots, total cartridgeCount=${r.qty}`);
	console.log('');

	console.log('=== 6. BackingLots in 1-week window with detailed state ===\n');
	const recentLots = await db
		.collection('backing_lots')
		.find({ ovenEntryTime: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } })
		.sort({ ovenEntryTime: -1 })
		.toArray();
	for (const l of recentLots as any[]) {
		const refs = await db
			.collection('cartridge_records')
			.countDocuments({ 'backing.lotId': String(l._id) });
		const refsNoWax = await db
			.collection('cartridge_records')
			.countDocuments({ 'backing.lotId': String(l._id), 'waxFilling.runId': { $exists: false } });
		const exitedOven = await db
			.collection('cartridge_records')
			.countDocuments({ 'backing.lotId': String(l._id), 'ovenCure.exitTime': { $exists: true } });
		console.log(
			`  ${l._id}  status=${l.status}  lot.cartridgeCount=${l.cartridgeCount}  refs=${refs}  refs_no_wax=${refsNoWax}  exited_oven=${exitedOven}  entry=${l.ovenEntryTime?.toISOString?.()}`
		);
	}
	console.log('');

	console.log('=== 7. Likely-in-oven heuristic (refined): ===\n');
	console.log('Definition: cartridge has backing.ovenEntryTime AND no ovenCure.exitTime AND status not in (scrapped,voided,completed,wax_stored,stored)');
	const inOven = await db
		.collection('cartridge_records')
		.find({
			'backing.ovenEntryTime': { $exists: true },
			'ovenCure.exitTime': { $exists: false },
			status: { $nin: ['scrapped', 'voided', 'completed', 'wax_stored', 'stored'] }
		})
		.project({ _id: 1, status: 1, 'backing.lotId': 1, 'waxFilling.runId': 1 })
		.toArray();
	console.log(`Total still-in-oven (refined): ${inOven.length}\n`);

	const byLot = new Map<string, { ids: string[]; statuses: Map<string, number> }>();
	for (const c of inOven as any[]) {
		const lid = c.backing?.lotId ?? '(no lot)';
		if (!byLot.has(lid)) byLot.set(lid, { ids: [], statuses: new Map() });
		const entry = byLot.get(lid)!;
		entry.ids.push(c._id);
		entry.statuses.set(c.status, (entry.statuses.get(c.status) ?? 0) + 1);
	}
	for (const [lid, info] of byLot) {
		const lot = await db.collection('backing_lots').findOne({ _id: lid });
		console.log(`  lot=${lid}  lot.status=${(lot as any)?.status}  count=${info.ids.length}`);
		for (const [s, n] of info.statuses) console.log(`    cart.status=${s}: ${n}`);
	}

	await mongoose.disconnect();
}
main().catch((e) => {
	console.error(e);
	process.exit(1);
});
