import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	// ─── 12-cart compliance gate on bucket 2941bb67 ───────────────────────────
	const docBucket = '2941bb67-effd-4f87-b5d5-73f9ff840ee3';
	const knownRuns = ['kcLzRTjSHP7cj6Eb94QGj', '6o29m5Jre1aqGTXJ-fZdL', 'LVWw0lsgOOyDuZuP6tKrW', '4Z6AldZWCJ8EC_QG0pe2N'];
	const allBucketCarts = await db.collection('cartridge_records').countDocuments({ 'backing.lotId': docBucket });
	const bucketByStatus = await db.collection('cartridge_records').aggregate([
		{ $match: { 'backing.lotId': docBucket } },
		{ $group: { _id: '$status', n: { $sum: 1 } } }
	]).toArray();
	const shippingPath = await db.collection('cartridge_records').find({
		'backing.lotId': docBucket,
		status: { $in: ['released', 'linked', 'shipped', 'completed', 'underway'] }
	}).project({ _id: 1, status: 1, 'waxFilling.runId': 1 }).toArray();
	const excessCandidates = shippingPath.filter((c: any) => !knownRuns.includes(c.waxFilling?.runId));

	console.log('=== 12-CART COMPLIANCE GATE (bucket 2941bb67) ===');
	console.log(`All cartridges linking to bucket: ${allBucketCarts}`);
	console.log('By status:');
	for (const s of bucketByStatus as any[]) console.log(`  ${s._id}: ${s.n}`);
	console.log(`In shipping-path statuses: ${shippingPath.length}`);
	console.log(`Of those, NOT tied to the 4 documented runs: ${excessCandidates.length}`);
	if (excessCandidates.length > 0) {
		console.log('  excess candidates (need human QA):');
		for (const c of excessCandidates.slice(0, 20) as any[]) console.log(`    ${c._id}  status=${c.status}  runId=${c.waxFilling?.runId}`);
	}

	// Verify LotRecord corrections[] + audit log for V1BSHFzMXsNAxYiP59o6b
	const lotV1 = await db.collection('lot_records').findOne({ _id: 'V1BSHFzMXsNAxYiP59o6b' } as any);
	console.log(`\nLotRecord V1BSHFzMXsNAxYiP59o6b present: ${!!lotV1}`);
	if (lotV1) {
		console.log(`  actualConsumedCount: ${(lotV1 as any).actualConsumedCount}`);
		console.log(`  corrections[] entries: ${((lotV1 as any).corrections || []).length}`);
		console.log(`  status: ${(lotV1 as any).status}`);
	}
	const reconcileAudit = await db.collection('audit_logs').countDocuments({ recordId: 'V1BSHFzMXsNAxYiP59o6b', action: 'RECONCILE' });
	console.log(`  audit_logs RECONCILE rows: ${reconcileAudit}`);

	// ─── Backfill counts vs docs ──────────────────────────────────────────────
	console.log('\n=== BACKFILL COUNT VERIFICATION ===');

	// 9,641 waxQc.status=Accepted by system-backfill
	const acceptedBackfill = await db.collection('cartridge_records').countDocuments({ 'waxQc.status': 'Accepted', 'waxQc.operator': 'system-backfill' });
	const acceptedBackfillAlt = await db.collection('cartridge_records').countDocuments({ 'waxQc.operator': 'system-backfill' });
	console.log(`waxQc Accepted by system-backfill: ${acceptedBackfill}  (all ops w/ that operator: ${acceptedBackfillAlt})`);
	const waxBackfillAudit = await db.collection('audit_logs').findOne({ _id: 'aiUsESm2QKWzO7JIuSaiN' } as any);
	console.log(`  audit row aiUsESm2QKWzO7JIuSaiN present: ${!!waxBackfillAudit}`);

	// 4 retracted txns on superseded lot KnvhBjHKSC0jStX1rQw4s
	const retracted = await db.collection('inventory_transactions').countDocuments({ manufacturingRunId: 'KnvhBjHKSC0jStX1rQw4s', retractedAt: { $exists: true } });
	const adjustments = await db.collection('inventory_transactions').countDocuments({ manufacturingRunId: 'KnvhBjHKSC0jStX1rQw4s', transactionType: 'adjustment' });
	const retractAudit = await db.collection('audit_logs').countDocuments({ recordId: 'KnvhBjHKSC0jStX1rQw4s', action: 'RETRACT' });
	console.log(`Superseded lot KnvhBjHKSC0jStX1rQw4s:`);
	console.log(`  retracted txns:  ${retracted}  (doc says 4)`);
	console.log(`  adjustment txns: ${adjustments}  (doc says 4)`);
	console.log(`  audit RETRACT rows: ${retractAudit}  (doc says 1)`);

	// 90 backfilled scrap txns + 90 audit logs
	const scrapBackfill = await db.collection('inventory_transactions').countDocuments({ transactionType: 'scrap', operatorUsername: 'system-audit-backfill-2026-04-23' });
	const scrapBackfillAudit = await db.collection('audit_logs').countDocuments({ changedBy: 'system-audit-backfill-2026-04-23' });
	console.log(`Cleanup backfill:`);
	console.log(`  scrap txns by system-audit-backfill-2026-04-23: ${scrapBackfill}  (doc says 90)`);
	console.log(`  audit rows by same: ${scrapBackfillAudit}  (doc says 90)`);

	// 90 scrapped cartridges with those two voidReasons
	const cleanup1 = await db.collection('cartridge_records').countDocuments({ status: 'scrapped', voidReason: /^Orphan backing cleanup/ });
	const cleanup2 = await db.collection('cartridge_records').countDocuments({ status: 'scrapped', voidReason: /^Scrapped post-fill queue cleanup/ });
	console.log(`Scrapped w/ "Orphan backing cleanup": ${cleanup1}  (doc says 83)`);
	console.log(`Scrapped w/ "Scrapped post-fill queue cleanup": ${cleanup2}  (doc says 7)`);

	// ─── Refactor invariants (Doc 3 §2.1-2.5) ─────────────────────────────────
	console.log('\n=== REFACTOR INVARIANTS ===');

	// §2.1 No cartridges with status=backing (placeholder-free invariant)
	const backingStatus = await db.collection('cartridge_records').countDocuments({ status: 'backing' });
	console.log(`Cartridges with status='backing': ${backingStatus}  (expect 0)`);

	// §2.2 Nanoid-shaped _id in active states
	const nanoidActive = await db.collection('cartridge_records').countDocuments({
		_id: { $not: /^[0-9a-f-]{36}$/i } as any,
		status: { $nin: ['voided', 'scrapped', 'completed', 'cancelled', 'shipped'] }
	});
	console.log(`Nanoid-ID carts in active state: ${nanoidActive}  (expect near-zero)`);

	// §2.4 waxQc complete on advanced-status cartridges
	const advStatuses = ['wax_filled', 'wax_stored', 'reagent_filling', 'reagent_filled', 'inspected', 'sealed', 'cured', 'stored', 'released', 'shipped', 'linked', 'underway', 'completed'];
	const waxQcGaps = await db.collection('cartridge_records').countDocuments({
		status: { $in: advStatuses },
		$or: [{ 'waxQc.status': { $exists: false } }, { 'waxQc.status': { $nin: ['Accepted', 'Rejected'] } }]
	});
	console.log(`Advanced-status carts missing waxQc.status: ${waxQcGaps}  (expect 0)`);

	// §2.5 Post-refactor lineage completeness (post 2026-04-23)
	const postDeployLineageGaps = await db.collection('cartridge_records').countDocuments({
		'backing.lotId': { $exists: true, $ne: null },
		createdAt: { $gte: new Date('2026-04-23') },
		$or: [
			{ 'backing.parentLotRecordId': { $exists: false } },
			{ 'backing.cartridgeBlankLot': { $exists: false } }
		]
	});
	console.log(`Post-deploy carts missing lineage: ${postDeployLineageGaps}  (expect 0)`);

	// ─── Research-run signal (should be 0 exercised) ─────────────────────────
	console.log('\n=== RESEARCH RUN (not yet exercised) ===');
	const researchCarts = await db.collection('cartridge_records').countDocuments({ 'reagentFilling.isResearch': true });
	const researchBatches = await db.collection('reagent_batch_records').countDocuments({ isResearch: true });
	console.log(`CartridgeRecord reagentFilling.isResearch=true: ${researchCarts}`);
	console.log(`ReagentBatchRecord isResearch=true: ${researchBatches}`);

	// Linked cartridges with null assayType (proves feature tolerance)
	const linkedNullAssay = await db.collection('cartridge_records').countDocuments({ status: 'linked', 'reagentFilling.assayType': null });
	console.log(`Linked carts with reagentFilling.assayType=null (tolerance proof): ${linkedNullAssay}`);

	// ─── Manual cartridge removal usage ───────────────────────────────────────
	console.log('\n=== MANUAL REMOVAL COLLECTION ===');
	const removals = await db.collection('manual_cartridge_removals').countDocuments({});
	console.log(`manual_cartridge_removals documents: ${removals}`);

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
