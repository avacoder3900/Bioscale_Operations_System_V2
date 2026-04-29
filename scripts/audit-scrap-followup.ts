/**
 * Follow-up diagnostics for two flags raised by audit-scrap-tracking.ts:
 *  1. Why does backing-step consumption sum exceed (quantityProduced+scrap)?
 *     PT-CT-104 off by 4, PT-CT-112 off by 2, PT-CT-106 off by 2.
 *  2. When/how were the 90 cleanup-scrap cartridges written? Check audit_logs.
 *  3. Any *production* reject paths (wax/reagent/top-seal) actually used yet?
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	console.log('='.repeat(72));
	console.log(' FOLLOW-UP: Backing-step consumption drift');
	console.log('='.repeat(72));

	const parts = db.collection('part_definitions');
	const txns = db.collection('inventory_transactions');
	const lots = db.collection('lot_records');
	const carts = db.collection('cartridge_records');

	const targetPns = ['PT-CT-104', 'PT-CT-112', 'PT-CT-106'];
	const pidByNum: Record<string, string | null> = {};
	for (const pn of targetPns) {
		const p = await parts.findOne({ partNumber: pn });
		pidByNum[pn] = p?._id ?? null;
		console.log(`  ${pn} -> partDefinitionId ${p?._id}`);
	}

	// All backing consumption txns per part
	for (const pn of targetPns) {
		const pid = pidByNum[pn];
		const all = await txns.find({ transactionType: 'consumption', manufacturingStep: 'backing', partDefinitionId: pid })
			.project({ manufacturingRunId: 1, quantity: 1, performedAt: 1, notes: 1 })
			.sort({ performedAt: 1 })
			.toArray();
		console.log(`\n  [${pn}] ${all.length} backing consumption txns`);
		// Group by run and check against lot
		const byRun: Record<string, number[]> = {};
		for (const t of all as any[]) {
			if (!t.manufacturingRunId) continue;
			(byRun[t.manufacturingRunId] ??= []).push(t.quantity);
		}
		for (const [runId, qs] of Object.entries(byRun)) {
			const lot = await lots.findOne({ _id: runId });
			const scrap = (lot as any)?.scrapDetail ?? {};
			const field = pn === 'PT-CT-104' ? 'cartridge' : pn === 'PT-CT-112' ? 'thermoseal' : 'barcode';
			const expected = ((lot as any)?.quantityProduced ?? 0) + (scrap[field] ?? 0);
			const actual = qs.reduce((a, b) => a + b, 0);
			const mark = actual === expected ? 'OK' : `DIFF (+${actual - expected})`;
			if (actual !== expected || qs.length > 1) {
				console.log(`    run=${runId}  txns=${qs.length} qs=[${qs.join(',')}]  expected=${expected}  ${mark}  lot.status=${(lot as any)?.status}`);
			}
		}
		// Consumption txns with no manufacturingRunId
		const noRun = all.filter((t: any) => !t.manufacturingRunId);
		if (noRun.length) {
			console.log(`    ${noRun.length} consumption txns without manufacturingRunId`);
			for (const t of noRun) console.log(`      txn ${(t as any)._id}  qty=${(t as any).quantity}  at=${(t as any).performedAt}`);
		}
	}

	console.log('\n' + '='.repeat(72));
	console.log(' FOLLOW-UP: 90 cleanup-scrap cartridges — audit trail');
	console.log('='.repeat(72));
	const cleanupCarts = await carts.find({
		status: 'scrapped',
		voidReason: { $in: [
			'Orphan backing cleanup — no active oven lot for this cartridge (abandoned/test data)',
			'Scrapped post-fill queue cleanup — operator request 2026-04-22'
		] }
	}).toArray();
	console.log(`\nTotal cleanup-scrap cartridges: ${cleanupCarts.length}`);
	// voidedAt distribution
	const byDay: Record<string, number> = {};
	for (const c of cleanupCarts as any[]) {
		const day = c.voidedAt ? new Date(c.voidedAt).toISOString().slice(0, 10) : 'null';
		byDay[day] = (byDay[day] ?? 0) + 1;
	}
	console.log('  voidedAt by day:');
	for (const [d, n] of Object.entries(byDay)) console.log(`    ${d}: ${n}`);

	// Audit log entries for these cartridges
	const auditHits = await db.collection('audit_logs').aggregate([
		{ $match: { tableName: 'cartridge_records', recordId: { $in: cleanupCarts.map((c: any) => c._id) } } },
		{ $group: { _id: '$changedBy', n: { $sum: 1 } } }
	]).toArray();
	console.log(`\n  audit_log entries by changedBy:`);
	for (const h of auditHits) console.log(`    ${h._id}: ${h.n}`);
	const totalAudits = auditHits.reduce((a, b: any) => a + b.n, 0);
	console.log(`  total audit entries for these carts: ${totalAudits}  (cartridges: ${cleanupCarts.length})`);

	console.log('\n' + '='.repeat(72));
	console.log(' FOLLOW-UP: production reject paths — any real usage?');
	console.log('='.repeat(72));

	// Any cartridge whose voidReason begins with "Wax QC rejection" or "Reagent inspection rejection" or "Rejected at top sealing"
	const prodRejects = await carts.find({
		status: 'scrapped',
		$or: [
			{ voidReason: /^Wax QC rejection/ },
			{ voidReason: /^Reagent inspection rejection/ },
			{ voidReason: /^Rejected at top sealing/ }
		]
	}).toArray();
	console.log(`  production-path scrapped cartridges: ${prodRejects.length}`);
	for (const c of prodRejects as any[]) {
		const scrapT = await txns.findOne({ transactionType: 'scrap', cartridgeRecordId: c._id });
		console.log(`    ${c._id}  reason="${c.voidReason}"  txn=${scrapT ? '✓' : '✗'}`);
	}

	// rejectAtSeal path — confirmed to not emit txn in code. Check if any of these exist in ReagentBatchRecord
	const reagentRejects = await db.collection('reagent_batch_records').aggregate([
		{ $match: { 'cartridgesFilled.inspectionStatus': 'Rejected' } },
		{ $project: { _id: 1, rejected: {
			$filter: { input: '$cartridgesFilled', as: 'c', cond: { $eq: ['$$c.inspectionStatus', 'Rejected'] } }
		} } }
	]).toArray();
	let totalRejectsInBatches = 0;
	for (const r of reagentRejects as any[]) totalRejectsInBatches += (r.rejected?.length ?? 0);
	console.log(`\n  ReagentBatchRecord cartridgesFilled[].inspectionStatus='Rejected': ${totalRejectsInBatches} across ${reagentRejects.length} batches`);
	for (const r of reagentRejects as any[]) {
		for (const rc of r.rejected ?? []) {
			const scrapT = await txns.findOne({ transactionType: 'scrap', cartridgeRecordId: rc.cartridgeId });
			console.log(`    batch=${r._id}  cartridge=${rc.cartridgeId}  reason="${rc.inspectionReason ?? '?'}"  txn=${scrapT ? '✓' : '✗'}`);
		}
	}

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
