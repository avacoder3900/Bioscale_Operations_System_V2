import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
const URI = process.env.MONGODB_URI!;

async function main() {
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;

	console.log('=== Most recent WaxFillingRun docs (any status) ===\n');
	const recent = await db.collection('wax_filling_runs').find({})
		.sort({ createdAt: -1 })
		.limit(15)
		.toArray();
	for (const r of recent as any[]) {
		console.log(`  _id=${r._id}`);
		console.log(`    status=${r.status}`);
		console.log(`    robot=${r.robot?.name ?? r.robot?._id ?? '(none)'}`);
		console.log(`    deckId=${r.deckId ?? '(none)'}`);
		console.log(`    plannedCartridgeCount=${r.plannedCartridgeCount ?? '(none)'}`);
		console.log(`    cartridgeIds.length=${(r.cartridgeIds ?? []).length}`);
		console.log(`    createdAt=${r.createdAt?.toISOString?.() ?? r.createdAt}`);
		console.log(`    runStartTime=${r.runStartTime?.toISOString?.() ?? r.runStartTime}`);
		console.log(`    runEndTime=${r.runEndTime?.toISOString?.() ?? r.runEndTime}`);
		console.log(`    activeLotId=${r.activeLotId ?? '(none)'}`);
		console.log(`    ovenLocationId=${r.ovenLocationId ?? '(none)'}`);
		console.log(`    coolingTrayId=${r.coolingTrayId ?? '(none)'}`);
		console.log(`    robotReleasedAt=${r.robotReleasedAt?.toISOString?.() ?? r.robotReleasedAt ?? '(none)'}`);
		console.log('');
	}

	console.log('=== Most recent CartridgeRecord docs by updatedAt ===\n');
	const latestCart = await db.collection('cartridge_records').find({})
		.sort({ updatedAt: -1 })
		.limit(20)
		.project({ _id: 1, status: 1, updatedAt: 1, 'waxFilling.runId': 1, 'waxFilling.runEndTime': 1, 'waxQc.status': 1, 'waxQc.timestamp': 1, 'waxStorage.location': 1, 'waxStorage.timestamp': 1 })
		.toArray();
	for (const c of latestCart as any[]) {
		console.log(`  ${c._id}  status=${c.status}  waxRunId=${c.waxFilling?.runId ?? '—'}  qc=${c.waxQc?.status ?? '—'}  stored=${c.waxStorage?.location ?? '—'}  updated=${c.updatedAt?.toISOString?.()}`);
	}

	console.log('\n=== Cartridges per recent run (top 5 runs) ===');
	const topRuns = (recent as any[]).slice(0, 5);
	for (const r of topRuns) {
		const cartCount = await db.collection('cartridge_records').countDocuments({ 'waxFilling.runId': r._id });
		const byStatus = await db.collection('cartridge_records').aggregate([
			{ $match: { 'waxFilling.runId': r._id } },
			{ $group: { _id: '$status', n: { $sum: 1 } } }
		]).toArray();
		console.log(`  run=${r._id}  robot=${r.robot?.name ?? '(?)'}  planned=${r.plannedCartridgeCount ?? '?'}  actualLinked=${cartCount}  byStatus=${JSON.stringify(byStatus)}`);
	}

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
