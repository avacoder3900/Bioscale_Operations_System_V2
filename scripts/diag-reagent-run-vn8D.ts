import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const CID = '50ce9f00-bff6-42d3-ad14-b8540f4e5d9a';
const REAGENT_RUN = 'vn8DqR4BpOyrWeo1lZ_xR';
const WAX_RUN = '2y2fFrx6QdOaxhJMN78kt';

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	console.log('=== REAGENT BATCH RECORD (full) ===');
	const rr = await db.collection('reagent_batch_records').findOne({ _id: REAGENT_RUN } as any);
	console.log(JSON.stringify(rr, null, 2));

	// Any OTHER reagent runs that also claim to contain this cartridge?
	console.log('\n=== ANY OTHER REAGENT RUN CLAIMING THIS CARTRIDGE ===');
	const others = await db.collection('reagent_batch_records').find({
		$or: [
			{ 'cartridgesFilled.cartridgeId': CID },
			{ 'cartridgesFilled._id': CID },
			{ cartridgeIds: CID }
		]
	}).project({ _id: 1, status: 1, isResearch: 1, setupTimestamp: 1, runEndTime: 1, cartridgesFilled: 1 }).toArray();
	console.log(`count: ${others.length}`);
	for (const r of others as any[]) console.log(`  ${r._id}  status=${r.status}  isResearch=${r.isResearch}  end=${r.runEndTime}  filledCount=${r.cartridgesFilled?.length}`);

	// Other wax run claims
	console.log('\n=== ANY OTHER WAX RUN CLAIMING THIS CARTRIDGE ===');
	const waxOthers = await db.collection('wax_filling_runs').find({ cartridgeIds: CID }).project({ _id: 1, status: 1, operator: 1, runEndTime: 1 }).toArray();
	console.log(`count: ${waxOthers.length}`);
	for (const r of waxOthers as any[]) console.log(`  ${r._id}  status=${r.status}  operator=${r.operator?.username}  end=${r.runEndTime}`);

	// Wax run 2y2fFrx6 — how many other cartridges are in it and what's their state?
	console.log(`\n=== SIBLING CARTRIDGES IN WAX RUN ${WAX_RUN} ===`);
	const siblings = await db.collection('cartridge_records').find({ 'waxFilling.runId': WAX_RUN })
		.project({ _id: 1, status: 1, 'waxStorage.location': 1, 'reagentFilling.runId': 1, 'reagentFilling.isResearch': 1 })
		.toArray();
	console.log(`total siblings: ${siblings.length}`);
	const statusSummary: Record<string, number> = {};
	const reagentRunSummary: Record<string, number> = {};
	for (const s of siblings as any[]) {
		statusSummary[s.status] = (statusSummary[s.status] || 0) + 1;
		const rid = s.reagentFilling?.runId || '(none)';
		reagentRunSummary[rid] = (reagentRunSummary[rid] || 0) + 1;
	}
	console.log('status breakdown:');
	for (const [s, n] of Object.entries(statusSummary)) console.log(`  ${s}: ${n}`);
	console.log('reagent run breakdown:');
	for (const [r, n] of Object.entries(reagentRunSummary)) console.log(`  ${r}: ${n}`);

	// Look at how reagentFilling was set — is assayType === null a hint of bulk $setOnInsert?
	console.log('\n=== CARTRIDGES MATCHING REAGENT RUN vn8D (all) ===');
	const inReagent = await db.collection('cartridge_records').find({ 'reagentFilling.runId': REAGENT_RUN })
		.project({ _id: 1, status: 1, 'reagentFilling.recordedAt': 1, 'reagentFilling.fillDate': 1, 'reagentFilling.isResearch': 1, 'reagentFilling.assayType': 1 })
		.toArray();
	console.log(`cartridges w/ reagentFilling.runId=${REAGENT_RUN}: ${inReagent.length}`);
	for (const c of inReagent as any[]) {
		console.log(`  ${c._id}  status=${c.status}  recordedAt=${c.reagentFilling?.recordedAt}  isResearch=${c.reagentFilling?.isResearch}  assay=${JSON.stringify(c.reagentFilling?.assayType)}`);
	}

	// Look at all cartridges with duplicate "Wax storage: FRIDGE-001" inv txns to gauge systemic scope
	console.log('\n=== PHANTOM "Wax storage: FRIDGE-001" TXNS (systemic scope) ===');
	const phantoms = await db.collection('inventory_transactions').aggregate([
		{ $match: { notes: { $regex: '^Wax storage: FRIDGE-001' } } },
		{ $group: { _id: '$cartridgeRecordId', n: { $sum: 1 }, ts: { $push: '$performedAt' } } },
		{ $sort: { n: -1 } }
	]).toArray();
	console.log(`distinct cartridges with phantom FRIDGE-001 txns: ${phantoms.length}`);
	const dupes = (phantoms as any[]).filter(p => p.n >= 2);
	console.log(`of those, with ≥2 duplicate txns: ${dupes.length}`);
	for (const p of dupes.slice(0, 15) as any[]) {
		console.log(`  ${p._id}  ${p.n} txns  times=${p.ts.map((t: Date) => new Date(t).toISOString()).join(', ')}`);
	}

	// Finally — AuditLog coverage on this reagent run
	console.log(`\n=== AUDIT LOGS for reagent run ${REAGENT_RUN} ===`);
	const runAudits = await db.collection('audit_logs').find({ recordId: REAGENT_RUN }).sort({ changedAt: 1 }).toArray();
	for (const l of runAudits as any[]) {
		const when = l.changedAt instanceof Date ? l.changedAt.toISOString() : l.changedAt;
		console.log(`  ${when}  action=${l.action}  changedBy=${l.changedBy}`);
	}

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
