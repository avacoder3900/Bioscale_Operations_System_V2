/**
 * Deep dig: why is parentLotRecordId missing on cartridges that went through
 * today's wax runs? activeLotId presence check.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	const cartridges = db.collection('cartridge_records');
	const waxRuns = db.collection('wax_filling_runs');
	const lotRecords = db.collection('lot_records');

	// Today's runs
	console.log('== Today\'s wax runs — activeLotId presence ==');
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const todayRuns = await waxRuns.find({ createdAt: { $gte: today } }).sort({ createdAt: -1 }).toArray();
	for (const r of todayRuns) {
		const ra = r as any;
		console.log(`  runId=${r._id} status=${ra.status} plannedCartridgeCount=${ra.plannedCartridgeCount} cartridgeIds.length=${ra.cartridgeIds?.length} activeLotId=${ra.activeLotId ?? '(none)'}`);
	}

	// Check the most recent cartridge in detail
	console.log('\n== Most recent wax-filled cartridge — full backing subdoc ==');
	const c = await cartridges.findOne({ 'waxFilling.recordedAt': { $exists: true } }, { sort: { 'waxFilling.recordedAt': -1 } });
	if (c) {
		const ca = c as any;
		console.log(`_id=${c._id}`);
		console.log('  status:', ca.status);
		console.log('  backing:', JSON.stringify(ca.backing, null, 2));
		console.log('  waxFilling.runId:', ca.waxFilling?.runId);
		// Lookup the run
		const run = await waxRuns.findOne({ _id: ca.waxFilling?.runId });
		console.log('  run.activeLotId:', (run as any)?.activeLotId);
	}

	// How many runs ever had activeLotId set?
	const withAlid = await waxRuns.countDocuments({ activeLotId: { $exists: true, $ne: null } });
	const withoutAlid = await waxRuns.countDocuments({ activeLotId: { $exists: false } });
	console.log(`\n== All-time wax runs: ${withAlid} with activeLotId, ${withoutAlid} without ==`);

	// How about today's activeLotId values and whether that barcode resolves to a BackingLot / LotRecord?
	console.log('\n== Today\'s runs: activeLotId resolution ==');
	for (const r of todayRuns) {
		const ra = r as any;
		if (!ra.activeLotId) { console.log(`  runId=${r._id} activeLotId=(none)`); continue; }
		const bl = await db.collection('backing_lots').findOne({ _id: ra.activeLotId });
		const lr = await lotRecords.findOne({ bucketBarcode: ra.activeLotId });
		console.log(`  runId=${r._id} activeLotId=${ra.activeLotId} bl=${bl ? `found status=${(bl as any).status}` : 'NOT FOUND'} parentLot=${lr ? `found _id=${lr._id} inputLots.length=${(lr as any).inputLots?.length ?? 0}` : 'NOT FOUND'}`);
	}

	// Traceability samples — most recent run's cartridges with their backing data
	if (todayRuns.length > 0) {
		const latest = todayRuns[0] as any;
		console.log(`\n== Backing subdocs for cartridges in latest run ${latest._id} ==`);
		const carts = await cartridges.find({ 'waxFilling.runId': latest._id }).limit(3).toArray();
		for (const c of carts) {
			const ca = c as any;
			console.log(`  _id=${c._id}`);
			console.log('    backing:', JSON.stringify(ca.backing));
		}
	}

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
