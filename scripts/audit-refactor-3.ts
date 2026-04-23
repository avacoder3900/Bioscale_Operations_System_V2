/**
 * Third pass: clarify the remaining issues.
 * - Are there any wax runs from AFTER the refactor was deployed? When was
 *   the last loadDeck called? Did parentLotRecordId NOT get written?
 * - What are the CART-* dangling refs?
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	const cartridges = db.collection('cartridge_records');
	const waxRuns = db.collection('wax_filling_runs');
	const invTxn = db.collection('inventory_transactions');
	const audit = db.collection('audit_logs');

	// Last few waxFilling.recordedAt dates
	console.log('== Most recent wax runs ==');
	const recentRuns = await waxRuns.find({}).sort({ createdAt: -1 }).limit(10).toArray();
	for (const r of recentRuns) {
		const ra = r as any;
		console.log(`  runId=${r._id} status=${ra.status} created=${ra.createdAt} plannedCartridgeCount=${ra.plannedCartridgeCount} cartridgeIds.length=${ra.cartridgeIds?.length}`);
	}

	// When was the last cartridge individuated via wax scan?
	const latestWaxFilled = await cartridges.find({ 'waxFilling.recordedAt': { $exists: true } })
		.sort({ 'waxFilling.recordedAt': -1 }).limit(3).toArray();
	console.log('\n== Last 3 cartridges with waxFilling.recordedAt ==');
	for (const c of latestWaxFilled) {
		const ca = c as any;
		console.log(`  _id=${c._id} status=${ca.status} waxFilling.recordedAt=${ca.waxFilling?.recordedAt}`);
		console.log(`    backing.parentLotRecordId=${ca.backing?.parentLotRecordId}`);
		console.log(`    backing.lotQrCode=${ca.backing?.lotQrCode}`);
		console.log(`    backing.ovenExitTime=${ca.backing?.ovenExitTime}`);
		console.log(`    backing.cartridgeBlankLot=${ca.backing?.cartridgeBlankLot}`);
	}

	// CART-* dangling sample
	console.log('\n== CART-* inventory_transactions sample ==');
	const cartSample = await invTxn.find({ cartridgeRecordId: { $regex: /^CART-/ } }).limit(5).toArray();
	for (const t of cartSample) {
		const ta = t as any;
		console.log(`  txn=${t._id} cartridge=${ta.cartridgeRecordId} step=${ta.manufacturingStep} type=${ta.transactionType}`);
	}

	// Check a few of the cartridges the CART-* refs supposedly point to
	const someCartIds = [...new Set(cartSample.map(t => (t as any).cartridgeRecordId))];
	for (const id of someCartIds) {
		const exists = await cartridges.findOne({ _id: id }, { projection: { _id: 1, status: 1 } });
		console.log(`  ${id} -> ${exists ? `status=${(exists as any).status}` : 'DELETED'}`);
	}

	// Non-existent CART-* count
	const existingIds = new Set((await cartridges.find({ _id: { $regex: /^CART-/ } }, { projection: { _id: 1 } }).toArray()).map(c => String(c._id)));
	console.log(`  Existing CART-* cartridges: ${existingIds.size}`);
	const allCartDashInTxns = await invTxn.distinct('cartridgeRecordId', { cartridgeRecordId: { $regex: /^CART-/ } });
	console.log(`  Distinct CART-* in inventory_transactions: ${allCartDashInTxns.length}`);
	const missing = allCartDashInTxns.filter((id: any) => !existingIds.has(String(id)));
	console.log(`  Dangling CART-*: ${missing.length} (sample: ${missing.slice(0, 5).join(', ')})`);

	// Inspect one pre-refactor cartridge (should not break traceability) — check data completeness
	console.log('\n== Traceability check: pre-refactor cartridge lineage completeness ==');
	const pre = await cartridges.findOne({ 'backing.lotId': { $exists: true }, 'backing.parentLotRecordId': { $exists: false } });
	if (pre) {
		const ca = pre as any;
		console.log(`  _id=${pre._id} status=${ca.status} waxQc.status=${ca.waxQc?.status}`);
		console.log(`    backing.lotId=${ca.backing?.lotId}`);
		console.log(`    backing.lotQrCode=${ca.backing?.lotQrCode}`);
		console.log(`    backing.cartridgeBlankLot=${ca.backing?.cartridgeBlankLot}`);
		console.log(`    backing.thermosealLot=${ca.backing?.thermosealLot}`);
		console.log(`    backing.barcodeLabelLot=${ca.backing?.barcodeLabelLot}`);
		console.log(`    (new fields non-existent as expected pre-refactor)`);
	}

	// ovens in /equipment/activity — oven count method
	console.log('\n== Oven count agreement check ==');
	const ovens = await db.collection('equipment').find({ equipmentType: 'oven' }).toArray();
	for (const o of ovens) {
		const oa = o as any;
		// dashboard/activity oven count — from BackingLot
		const agg = await db.collection('backing_lots').aggregate([
			{ $match: { ovenLocationId: String(o._id), status: { $in: ['in_oven', 'ready'] } } },
			{ $group: { _id: null, total: { $sum: '$cartridgeCount' } } }
		]).toArray();
		const ovenCount = (agg[0] as any)?.total ?? 0;
		// equipment/location/[id] backing lots count
		const lots = await db.collection('backing_lots').find({
			ovenLocationId: String(o._id),
			status: { $in: ['in_oven', 'ready'] }
		}).toArray();
		const locCount = lots.reduce((s, l) => s + ((l as any).cartridgeCount ?? 0), 0);
		console.log(`  ${oa.name} (${o._id}): dashboard=${ovenCount}, location=${locCount}, match=${ovenCount === locCount}`);
	}

	// dashboard audit — sample a WI-01 lot's inventory_transactions for material consumption
	console.log('\n== WI-01 most recent lot: full inventory_transactions log ==');
	const recentLot = await db.collection('lot_records').findOne(
		{ 'processConfig.processType': 'backing', status: 'Completed' },
		{ sort: { finishTime: -1 } }
	);
	if (recentLot) {
		console.log(`  lot=${recentLot._id} finished=${(recentLot as any).finishTime} produced=${(recentLot as any).quantityProduced}`);
		const txns = await invTxn.find({ manufacturingRunId: recentLot._id }).toArray();
		console.log(`  inventory_transactions: ${txns.length}`);
		for (const t of txns) {
			const ta = t as any;
			console.log(`    type=${ta.transactionType} qty=${ta.quantity} step=${ta.manufacturingStep} partId=${ta.partDefinitionId ?? 'none'} notes=${ta.notes?.slice(0, 80)}`);
		}
	}

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
