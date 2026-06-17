import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	// ─── 1. Single-cartridge research reagent runs with short OT-2 cycle ────
	console.log('=== SIGNAL 1: Single-cartridge research reagent runs ===');
	console.log('(research=true, cartridgesFilled.length == 1, OT-2 cycle < 3min)');
	const researchRuns = await db.collection('reagent_batch_records').find({
		isResearch: true
	}).toArray();
	console.log(`All research runs: ${researchRuns.length}`);
	for (const r of researchRuns as any[]) {
		const filled = r.cartridgesFilled?.length ?? 0;
		const start = r.runStartTime ? new Date(r.runStartTime).getTime() : null;
		const released = r.robotReleasedAt ? new Date(r.robotReleasedAt).getTime() : null;
		const ot2SecRaw = start && released ? Math.round((released - start) / 1000) : null;
		const flag = (filled === 1 && ot2SecRaw !== null && ot2SecRaw < 180) ? '⚠️' : '  ';
		console.log(`  ${flag} ${r._id}  filled=${filled}  OT-2=${ot2SecRaw}s  status=${r.status}  assay=${r.assayType?.name ?? 'null'}  operator=${r.operator?.username}  end=${r.runEndTime}`);
	}

	// ─── 2. Reagent batch records with ZERO AuditLog coverage ───────────────
	console.log('\n=== SIGNAL 2: Reagent runs with zero AuditLog entries ===');
	const allReagent = await db.collection('reagent_batch_records').find({}).project({ _id: 1, status: 1, isResearch: 1, runEndTime: 1, 'cartridgesFilled': 1, 'operator.username': 1, setupTimestamp: 1 }).toArray();
	const auditedIds = new Set<string>();
	const auditRows = await db.collection('audit_log').find({ tableName: 'reagent_batch_records' }).project({ recordId: 1 }).toArray();
	for (const a of auditRows as any[]) auditedIds.add(String(a.recordId));
	const ghostRuns = (allReagent as any[]).filter((r) => !auditedIds.has(String(r._id)));
	console.log(`Total reagent runs: ${allReagent.length}`);
	console.log(`With at least one audit row: ${allReagent.length - ghostRuns.length}`);
	console.log(`With ZERO audit rows: ${ghostRuns.length}`);
	for (const r of ghostRuns.slice(0, 25) as any[]) {
		const filled = r.cartridgesFilled?.length ?? 0;
		console.log(`  ${r._id}  status=${r.status}  filled=${filled}  research=${r.isResearch}  op=${r.operator?.username}  setup=${r.setupTimestamp}  end=${r.runEndTime}`);
	}
	if (ghostRuns.length > 25) console.log(`  ... and ${ghostRuns.length - 25} more`);

	// ─── 3. Phantom FRIDGE-001 wax-storage txns — per-cartridge detail ──────
	console.log('\n=== SIGNAL 3: Cartridges with "Wax storage: FRIDGE-001" txns ===');
	console.log('(these are suspicious — wax storage normally goes to FRIDGE-002)');
	const phantomCids = await db.collection('inventory_transactions').aggregate([
		{ $match: { notes: { $regex: '^Wax storage: FRIDGE-001' } } },
		{ $group: { _id: '$cartridgeRecordId', n: { $sum: 1 }, times: { $push: '$performedAt' } } },
		{ $sort: { n: -1 } }
	]).toArray();
	console.log(`distinct cartridges: ${phantomCids.length}`);
	console.log(`with >=2 txns (double-scan): ${(phantomCids as any[]).filter(p => p.n >= 2).length}`);

	// Check whether each phantom-cart's waxStorage.location actually says FRIDGE-001 or FRIDGE-002
	const phantomIdList = (phantomCids as any[]).map(p => p._id).filter(Boolean);
	const phantomCarts = await db.collection('cartridge_records').find({ _id: { $in: phantomIdList } })
		.project({ _id: 1, status: 1, 'waxStorage.location': 1, 'waxStorage.recordedAt': 1, 'storage.fridgeName': 1, 'reagentFilling.runId': 1, 'reagentFilling.isResearch': 1 })
		.toArray();
	const byId = new Map<string, any>();
	for (const c of phantomCarts as any[]) byId.set(String(c._id), c);

	const bucketMatch: Record<string, number> = {};
	const bucketMismatch: Record<string, number> = {};
	for (const p of phantomCids as any[]) {
		const c = byId.get(String(p._id));
		if (!c) continue;
		const loc = c.waxStorage?.location ?? '(null)';
		if (loc === 'FRIDGE-001') bucketMatch[loc] = (bucketMatch[loc] ?? 0) + 1;
		else bucketMismatch[loc] = (bucketMismatch[loc] ?? 0) + 1;
	}
	console.log('waxStorage.location on cartridges with phantom FRIDGE-001 txns:');
	console.log(`  FRIDGE-001 (matches txn): ${bucketMatch['FRIDGE-001'] ?? 0}  ← likely legitimate`);
	console.log(`  other / mismatch:         ${Object.values(bucketMismatch).reduce((a, b) => a + b, 0)}  ← suspicious`);
	for (const [loc, n] of Object.entries(bucketMismatch)) console.log(`    waxStorage.location=${loc}: ${n}`);

	// Samples of suspicious (mismatched) ones
	const suspiciousPhantom = (phantomCids as any[]).filter(p => {
		const c = byId.get(String(p._id));
		return c && c.waxStorage?.location && c.waxStorage.location !== 'FRIDGE-001';
	}).slice(0, 15);
	console.log('\nSample suspicious cartridges:');
	for (const p of suspiciousPhantom as any[]) {
		const c = byId.get(String(p._id));
		console.log(`  ${p._id}  phantomTxns=${p.n}  waxLoc=${c.waxStorage?.location}  status=${c.status}  reagentRun=${c.reagentFilling?.runId}  research=${c.reagentFilling?.isResearch}`);
	}

	// ─── 4. Cartridges appearing in multiple wax runs ────────────────────────
	console.log('\n=== SIGNAL 4: Cartridges appearing in multiple wax_filling_runs.cartridgeIds ===');
	const waxMulti = await db.collection('wax_filling_runs').aggregate([
		{ $unwind: '$cartridgeIds' },
		{ $group: { _id: '$cartridgeIds', runs: { $addToSet: '$_id' }, count: { $sum: 1 } } },
		{ $match: { count: { $gt: 1 } } }
	]).toArray();
	console.log(`Cartridges in >1 wax run: ${waxMulti.length}`);
	for (const r of waxMulti.slice(0, 10) as any[]) console.log(`  ${r._id}  runs=${r.runs.join(',')}  count=${r.count}`);

	// ─── 5. Cartridges appearing in multiple reagent runs ────────────────────
	console.log('\n=== SIGNAL 5: Cartridges appearing in multiple reagent batches ===');
	const reagentMulti = await db.collection('reagent_batch_records').aggregate([
		{ $unwind: '$cartridgesFilled' },
		{ $group: { _id: '$cartridgesFilled.cartridgeId', runs: { $addToSet: '$_id' }, count: { $sum: 1 } } },
		{ $match: { count: { $gt: 1 } } }
	]).toArray();
	console.log(`Cartridges in >1 reagent run: ${reagentMulti.length}`);
	for (const r of reagentMulti.slice(0, 10) as any[]) console.log(`  ${r._id}  runs=${r.runs.join(',')}  count=${r.count}`);

	// ─── 6. Cross-run operator/time anomalies (wax+reagent done by different ops, or far apart) ──
	console.log('\n=== SIGNAL 6: Wax-vs-reagent operator mismatch on same cartridge ===');
	const crossMismatch = await db.collection('cartridge_records').find({
		'waxFilling.operator.username': { $exists: true },
		'reagentFilling.operator.username': { $exists: true },
		$expr: { $ne: ['$waxFilling.operator.username', '$reagentFilling.operator.username'] }
	}).project({ _id: 1, 'waxFilling.operator.username': 1, 'reagentFilling.operator.username': 1, 'reagentFilling.isResearch': 1, status: 1 }).limit(20).toArray();
	console.log(`Cartridges where wax operator != reagent operator (sample up to 20): ${crossMismatch.length}`);
	for (const c of crossMismatch as any[]) {
		console.log(`  ${c._id}  wax=${c.waxFilling?.operator?.username}  reagent=${c.reagentFilling?.operator?.username}  research=${c.reagentFilling?.isResearch}  status=${c.status}`);
	}

	// ─── 7. Small reagent-batch summary (not just research) ──────────────────
	console.log('\n=== SIGNAL 7: Reagent batches with <= 3 cartridges filled ===');
	const smallBatches = await db.collection('reagent_batch_records').find({
		status: 'Completed',
		$expr: { $lte: [{ $size: { $ifNull: ['$cartridgesFilled', []] } }, 3] }
	}).project({ _id: 1, status: 1, isResearch: 1, 'operator.username': 1, runEndTime: 1, cartridgesFilled: 1 }).toArray();
	console.log(`Completed reagent runs with ≤3 cartridges: ${smallBatches.length}`);
	for (const r of smallBatches.slice(0, 15) as any[]) {
		console.log(`  ${r._id}  filled=${r.cartridgesFilled?.length}  research=${r.isResearch}  op=${r.operator?.username}  end=${r.runEndTime}`);
	}

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
