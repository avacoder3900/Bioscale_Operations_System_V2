import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
const URI = process.env.MONGODB_URI;
if (!URI) { console.error('MONGODB_URI missing'); process.exit(1); }

async function main() {
	await mongoose.connect(URI!);
	const db = mongoose.connection.db!;

	const TERMINAL_WAX = ['completed', 'aborted', 'cancelled', 'voided', 'Completed', 'Aborted', 'Cancelled', 'Voided'];
	const TERMINAL_REAGENT = ['completed', 'aborted', 'cancelled', 'voided', 'Completed', 'Aborted', 'Cancelled'];

	const waxRuns = await db.collection('wax_filling_runs').find({
		status: { $nin: TERMINAL_WAX }
	}).project({ _id:1, 'robot._id':1, 'robot.name':1, status:1, robotReleasedAt:1, createdAt:1 }).toArray();

	console.log(`=== ${waxRuns.length} non-terminal wax runs ===`);
	for (const r of waxRuns) {
		const released = r.robotReleasedAt ? 'YES' : 'NO';
		const wouldBlock = !r.robotReleasedAt ? 'BLOCKS ROBOT' : 'robot free';
		console.log(`  ${r._id}  robot=${r.robot?.name ?? r.robot?._id}  status=${r.status}  released=${released}  → ${wouldBlock}`);
	}

	const reagentRuns = await db.collection('reagent_batch_records').find({
		status: { $nin: TERMINAL_REAGENT }
	}).project({ _id:1, 'robot._id':1, 'robot.name':1, status:1, robotReleasedAt:1, createdAt:1 }).toArray();

	console.log(`\n=== ${reagentRuns.length} non-terminal reagent runs ===`);
	for (const r of reagentRuns) {
		const released = r.robotReleasedAt ? 'YES' : 'NO';
		const wouldBlock = !r.robotReleasedAt ? 'BLOCKS ROBOT' : 'robot free';
		console.log(`  ${r._id}  robot=${r.robot?.name ?? r.robot?._id}  status=${r.status}  released=${released}  → ${wouldBlock}`);
	}

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
