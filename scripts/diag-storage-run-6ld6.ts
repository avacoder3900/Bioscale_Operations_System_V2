/**
 * Inspect the active Storage-stage wax run's cartridges.
 * Check whether waxStorage fields are actually written, and what
 * cartridge.status / waxQc / waxStorage / ovenCure shows.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	// Find the active Storage-stage run (or whichever active run the operator is on)
	const runs = await db
		.collection('wax_filling_runs')
		.find({ status: { $in: ['Storage', 'storage'] } })
		.sort({ runStartTime: -1 })
		.toArray();

	if (runs.length === 0) {
		console.log('No active Storage-stage runs found');
		await mongoose.disconnect();
		return;
	}

	for (const run of runs as any[]) {
		console.log(`Run ${run._id}: status=${run.status}, cartridges=${run.cartridgeIds?.length}`);
		console.log(`  runStartTime: ${run.runStartTime}`);
		console.log(`  runEndTime: ${run.runEndTime}`);
		console.log(`  robotReleasedAt: ${run.robotReleasedAt}\n`);

		const carts = await db
			.collection('cartridge_records')
			.find({ _id: { $in: run.cartridgeIds ?? [] } })
			.project({
				_id: 1,
				status: 1,
				'waxQc.status': 1,
				'waxQc.recordedAt': 1,
				'waxStorage.location': 1,
				'waxStorage.locationId': 1,
				'waxStorage.recordedAt': 1,
				'waxStorage.timestamp': 1,
				'waxStorage.operator': 1,
				'ovenCure.exitTime': 1
			})
			.toArray();

		console.log(`Cartridges in run (${carts.length}):`);
		for (const c of carts as any[]) {
			console.log(`  ${c._id}`);
			console.log(`    status=${c.status}`);
			console.log(`    waxQc.status=${c.waxQc?.status}  recordedAt=${c.waxQc?.recordedAt?.toISOString?.() ?? c.waxQc?.recordedAt}`);
			console.log(`    waxStorage.location=${c.waxStorage?.location ?? '(none)'}`);
			console.log(`    waxStorage.locationId=${c.waxStorage?.locationId ?? '(none)'}`);
			console.log(`    waxStorage.recordedAt=${c.waxStorage?.recordedAt?.toISOString?.() ?? c.waxStorage?.recordedAt ?? '(NOT SET)'}`);
			console.log(`    waxStorage.operator=${JSON.stringify(c.waxStorage?.operator) ?? '(none)'}`);
			console.log(`    ovenCure.exitTime=${c.ovenCure?.exitTime?.toISOString?.() ?? c.ovenCure?.exitTime ?? '(NOT SET)'}`);
			console.log('');
		}

		// Summary: how many have waxStorage.recordedAt set?
		const recorded = (carts as any[]).filter((c) => c.waxStorage?.recordedAt).length;
		const notRecorded = carts.length - recorded;
		console.log(`Summary: ${recorded} cartridges have waxStorage.recordedAt set; ${notRecorded} do NOT`);
	}

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
