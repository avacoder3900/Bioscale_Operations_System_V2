import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	// 1) Find the f4d9 cart (suffix match)
	const f4d9 = await db.collection('cartridge_records').find({ _id: { $regex: 'f4d9$' } as any }).toArray() as any[];
	console.log(`=== SUFFIX f4d9 MATCHES: ${f4d9.length} ===`);
	for (const c of f4d9) {
		console.log(`\n  _id=${c._id}`);
		console.log(`    status=${c.status}`);
		console.log(`    voidedAt=${c.voidedAt}  voidReason=${c.voidReason ?? ''}`);
		console.log(`    waxFilling.runId=${c.waxFilling?.runId}`);
		console.log(`    waxFilling.recordedAt=${c.waxFilling?.recordedAt}`);
		console.log(`    waxQc=${JSON.stringify(c.waxQc)}`);
		console.log(`    waxStorage=${JSON.stringify(c.waxStorage)?.slice(0, 220)}`);
		console.log(`    reagentFilling.runId=${c.reagentFilling?.runId}`);
		console.log(`    reagentFilling.recordedAt=${c.reagentFilling?.recordedAt}`);
		console.log(`    storage=${JSON.stringify(c.storage)?.slice(0, 220)}`);
		console.log(`    linkedSpuRunId=${c.linkedSpuRunId ?? c.spuRunId ?? ''}`);
	}

	// 2) For each f4d9 cart, surface the sibling carts in the same wax run
	for (const c of f4d9) {
		const runId = c.waxFilling?.runId;
		if (!runId) continue;
		console.log(`\n=== SIBLINGS IN waxFilling.runId=${runId} ===`);
		const sibs = await db.collection('cartridge_records').find({ 'waxFilling.runId': runId }).toArray() as any[];
		// status histogram
		const hist: Record<string, number> = {};
		for (const s of sibs) hist[s.status] = (hist[s.status] ?? 0) + 1;
		console.log(`  total=${sibs.length}  statusHistogram=${JSON.stringify(hist)}`);

		// Show every cart with its waxQc/waxStorage gating fields
		console.log('\n  PER-CART (status / waxQc.status / waxStorage.recordedAt / voidedAt):');
		for (const s of sibs.sort((a, b) => String(a._id).localeCompare(String(b._id)))) {
			const qc = s.waxQc?.status ?? '-';
			const stored = s.waxStorage?.recordedAt ? 'YES' : 'no';
			const voided = s.voidedAt ? 'VOIDED' : '';
			const flag = (s.status === 'wax_filling') ? '   ⚠ STILL_FILLING (blocks batch)' : '';
			console.log(`    ${s._id}  status=${s.status.padEnd(14)} qc=${String(qc).padEnd(10)} storedRecordedAt=${stored.padEnd(3)} ${voided} ${flag}`);
		}

		// The exact server-side guard from recordBatchStorage
		const stuck = sibs.filter(s => s.status === 'wax_filling');
		console.log(`\n  GUARD: ${stuck.length} cart(s) still at status='wax_filling' would block recordBatchStorage`);
		const alreadyStored = sibs.filter(s => s.waxStorage?.recordedAt);
		console.log(`  ALREADY STORED: ${alreadyStored.length} cart(s) have waxStorage.recordedAt set (bulk update filter skips these)`);

		// Look up the wax run doc itself
		const run = await db.collection('wax_filling_runs').findOne({ _id: runId } as any) as any;
		if (run) {
			console.log(`\n  WaxFillingRun:`);
			console.log(`    status=${run.status}  cartCount=${(run.cartridgeIds ?? []).length}`);
			console.log(`    createdAt=${run.createdAt}  updatedAt=${run.updatedAt}`);
		}
	}

	await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
