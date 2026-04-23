/**
 * Confirm the hypothesis: new backing fields are in $setOnInsert but the
 * cartridges pre-existed (legacy inserts done by WI-01 before the refactor,
 * or by the reagent-filling page's bare upsert, or by the dev seed). So on
 * today's wax runs the upsert path is an UPDATE, not an INSERT, and
 * $setOnInsert is a no-op → parentLotRecordId etc never get written.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	const cartridges = db.collection('cartridge_records');
	const waxRuns = db.collection('wax_filling_runs');

	// Check the latest run's cartridges: what was createdAt vs updatedAt vs waxFilling.recordedAt?
	const runId = '4Z6AldZWCJ8EC_QG0pe2N';
	const run = await waxRuns.findOne({ _id: runId });
	console.log(`run createdAt: ${(run as any).createdAt}`);
	console.log(`run waxFilling happened: after ${(run as any).createdAt}`);
	console.log('');

	const carts = await cartridges.find({ 'waxFilling.runId': runId }).limit(5).toArray();
	for (const c of carts) {
		const ca = c as any;
		console.log(`cart=${c._id}`);
		console.log(`  createdAt=${ca.createdAt}`);
		console.log(`  updatedAt=${ca.updatedAt}`);
		console.log(`  waxFilling.recordedAt=${ca.waxFilling?.recordedAt}`);
		console.log(`  backing.recordedAt=${ca.backing?.recordedAt}`);
		console.log(`  existed before run? ${new Date(ca.createdAt).getTime() < new Date((run as any).createdAt).getTime()}`);
	}

	// Explicitly check: how many carts from today's runs pre-existed?
	console.log('\n== All today\'s run cartridges: pre-existing vs newly created ==');
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const todayRuns = await waxRuns.find({ createdAt: { $gte: today } }).toArray();
	for (const r of todayRuns) {
		const ra = r as any;
		if (!ra.cartridgeIds?.length) continue;
		const matching = await cartridges.find({ _id: { $in: ra.cartridgeIds } }).toArray();
		let preexisting = 0, freshlyInserted = 0;
		for (const c of matching) {
			const ca = c as any;
			const createdBefore = new Date(ca.createdAt).getTime() < new Date(ra.createdAt).getTime() - 1000;
			if (createdBefore) preexisting++;
			else freshlyInserted++;
		}
		console.log(`  run ${r._id} (${ra.cartridgeIds.length} carts): preexisting=${preexisting} freshlyInserted=${freshlyInserted}`);
	}

	// For a pre-existing cartridge, where did it originally come from?
	// Check: does it have storage.fridgeName suggesting stored state pre-scan?
	const sample = carts[0] as any;
	if (sample) {
		console.log('\n== Sample preexisting cart detail ==');
		console.log(`_id=${sample._id}`);
		console.log(`  status=${sample.status}`);
		console.log(`  waxStorage.location=${sample.waxStorage?.location}`);
		console.log(`  created=${sample.createdAt}`);
		// Look for audit log entries
		const audits = await db.collection('audit_logs').find({ recordId: sample._id }).sort({ changedAt: 1 }).limit(5).toArray();
		console.log(`  audit_logs: ${audits.length} entries`);
		for (const a of audits) {
			const aa = a as any;
			console.log(`    ${aa.changedAt} ${aa.action} by=${aa.changedBy}`);
		}
	}

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
