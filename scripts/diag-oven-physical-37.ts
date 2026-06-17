/**
 * Find which cartridges might be the 37 physically in the oven.
 * Operator says 37 cartridges sit in the oven now; system shows 3.
 *
 * Strategy: list every cartridge with backing.ovenEntryTime set, broken down
 * by (lot.status, has_waxFilling, cart.status), so we can see where the
 * extra 34 might be hiding.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	const lots = await db.collection('backing_lots').find({}).toArray();
	const lotById = new Map((lots as any[]).map((l) => [String(l._id), l]));

	console.log('=== Per-lot breakdown of cartridges referencing each BackingLot ===\n');
	for (const lot of lots as any[]) {
		const carts = await db
			.collection('cartridge_records')
			.find({ 'backing.lotId': String(lot._id) })
			.project({
				_id: 1,
				status: 1,
				'waxFilling.runId': 1,
				'backing.ovenEntryTime': 1,
				'backing.exitTime': 1,
				voidedAt: 1
			})
			.toArray();
		if (carts.length === 0) continue;

		console.log(
			`Lot ${lot._id}: status=${lot.status}, lot.cartridgeCount=${lot.cartridgeCount}, refs=${carts.length}, ovenEntry=${lot.ovenEntryTime?.toISOString?.()}`
		);

		// Group by (cart.status, has_waxFilling)
		const groups = new Map<string, number>();
		for (const c of carts as any[]) {
			const hasWax = !!c.waxFilling?.runId;
			const key = `cart.status=${c.status}, hasWaxRun=${hasWax}`;
			groups.set(key, (groups.get(key) ?? 0) + 1);
		}
		for (const [k, n] of [...groups.entries()].sort((a, b) => b[1] - a[1])) {
			console.log(`  ${k}: ${n}`);
		}
		console.log('');
	}

	// Strict "physically in oven" definition:
	// 1) Lot status in {in_oven, ready, created} OR
	// 2) Cartridge has backing.ovenEntryTime AND no waxFilling.runId AND
	//    status not in (completed, scrapped, voided, cancelled, stored, wax_stored)
	console.log('=== Strict "physically in oven" candidates ===\n');
	console.log('A) Cartridges in lots with status in {in_oven, ready, created}:');
	const activeLotIds = (lots as any[])
		.filter((l) => ['in_oven', 'ready', 'created'].includes(l.status))
		.map((l) => String(l._id));
	const inActiveLot = await db
		.collection('cartridge_records')
		.find({
			'backing.lotId': { $in: activeLotIds },
			status: { $nin: ['completed', 'scrapped', 'voided', 'cancelled'] }
		})
		.project({ _id: 1, status: 1, 'waxFilling.runId': 1, 'backing.lotId': 1 })
		.toArray();
	console.log(`  Total: ${inActiveLot.length}`);
	const aGroups = new Map<string, number>();
	for (const c of inActiveLot as any[]) {
		const hasWax = !!c.waxFilling?.runId;
		const key = `cart.status=${c.status}, hasWaxRun=${hasWax}`;
		aGroups.set(key, (aGroups.get(key) ?? 0) + 1);
	}
	for (const [k, n] of aGroups) console.log(`    ${k}: ${n}`);
	console.log('');

	console.log('B) Cartridges with backing.ovenEntryTime + no waxFilling.runId + pre-wax status:');
	const orphaned = await db
		.collection('cartridge_records')
		.find({
			'backing.ovenEntryTime': { $exists: true },
			'waxFilling.runId': { $exists: false },
			status: { $nin: ['completed', 'scrapped', 'voided', 'cancelled', 'stored', 'wax_stored'] }
		})
		.project({ _id: 1, status: 1, 'backing.lotId': 1, 'backing.ovenEntryTime': 1 })
		.toArray();
	console.log(`  Total: ${orphaned.length}`);
	const bGroups = new Map<string, number>();
	for (const c of orphaned as any[]) {
		const lid = c.backing?.lotId ?? '(no lot)';
		const lot = lotById.get(String(lid));
		const lotStatus = lot?.status ?? '(missing)';
		const key = `lot=${lid} (lotStatus=${lotStatus}), cart.status=${c.status}`;
		bGroups.set(key, (bGroups.get(key) ?? 0) + 1);
	}
	for (const [k, n] of bGroups) console.log(`    ${k}: ${n}`);
	console.log('');

	// Combine both sets, dedupe
	const allIds = new Set<string>([
		...(inActiveLot as any[]).map((c) => String(c._id)),
		...(orphaned as any[]).map((c) => String(c._id))
	]);
	console.log(`COMBINED unique cartridges in either group: ${allIds.size}\n`);

	// Active wax runs that may still have cartridges physically in oven
	// (e.g. run is in Setup/Loading and operator hasn't pulled them yet)
	console.log('=== Wax runs in pre-OT-2 stages (Setup/Loading/Running) — cartridges may still be in oven ===\n');
	const preOt2Runs = await db
		.collection('wax_filling_runs')
		.find({ status: { $in: ['Setup', 'Loading', 'setup', 'loading'] } })
		.toArray();
	for (const r of preOt2Runs as any[]) {
		const carts = await db
			.collection('cartridge_records')
			.find({ 'waxFilling.runId': String(r._id) })
			.project({ _id: 1, status: 1, 'backing.lotId': 1 })
			.toArray();
		console.log(`  run=${r._id}  status=${r.status}  cartridges=${carts.length}`);
	}

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
