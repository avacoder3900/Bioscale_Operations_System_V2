import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
const URI = process.env.MONGODB_URI;
if (!URI) { console.error('MONGODB_URI missing'); process.exit(1); }

async function main() {
	await mongoose.connect(URI!);
	const db = mongoose.connection.db!;
	const now = new Date();

	const TERMINAL_WAX = ['completed', 'aborted', 'cancelled', 'voided', 'Completed', 'Aborted', 'Cancelled', 'Voided'];
	const TERMINAL_REAGENT = ['completed', 'aborted', 'cancelled', 'voided', 'Completed', 'Aborted', 'Cancelled'];

	// Abort all non-terminal wax runs
	const waxRuns = await db.collection('wax_filling_runs').find({
		status: { $nin: TERMINAL_WAX }
	}).project({ _id: 1, 'robot.name': 1, status: 1 }).toArray();

	for (const r of waxRuns) {
		await db.collection('wax_filling_runs').updateOne(
			{ _id: r._id },
			{ $set: { status: 'aborted', abortReason: 'Stale test run — cleaned up during Opentron Control development', runEndTime: now, updatedAt: now } }
		);
		console.log(`Aborted wax run ${r._id} (${r.robot?.name}, was ${r.status})`);
	}

	// Abort all non-terminal reagent runs
	const reagentRuns = await db.collection('reagent_batch_records').find({
		status: { $nin: TERMINAL_REAGENT }
	}).project({ _id: 1, 'robot.name': 1, status: 1 }).toArray();

	for (const r of reagentRuns) {
		await db.collection('reagent_batch_records').updateOne(
			{ _id: r._id },
			{ $set: { status: 'Aborted', abortReason: 'Stale test run — cleaned up during Opentron Control development', runEndTime: now, updatedAt: now } }
		);
		console.log(`Aborted reagent run ${r._id} (${r.robot?.name}, was ${r.status})`);
	}

	// Revert any cartridges stuck in wax_filling back to backing
	const waxCartResult = await db.collection('cartridge_records').updateMany(
		{ status: 'wax_filling' },
		{ $set: { status: 'backing' }, $unset: { waxFilling: '' } }
	);
	if (waxCartResult.modifiedCount) console.log(`Reverted ${waxCartResult.modifiedCount} cartridges from wax_filling → backing`);

	// Revert any cartridges stuck in reagent_filling back to wax_filled
	const reagentCartResult = await db.collection('cartridge_records').updateMany(
		{ status: 'reagent_filling' },
		{ $set: { status: 'wax_filled' }, $unset: { reagentFilling: '' } }
	);
	if (reagentCartResult.modifiedCount) console.log(`Reverted ${reagentCartResult.modifiedCount} cartridges from reagent_filling → wax_filled`);

	console.log('\nDone. All robots should be free now.');
	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
