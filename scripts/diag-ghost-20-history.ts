/**
 * For the 20 FRIDGE-002 "ghost" cartridges (Mongo says wax_stored, user
 * couldn't find physically), check whether any of them have any signs of
 * having progressed past wax_stored: downstream fields populated, prior
 * status changes in audit_logs, or presence in downstream collections.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const GHOSTS = [
	'174343e4-a047-4ec3-8bed-2d225f9482e1',
	'19599c7b-3508-42dc-81d3-0779ac1122aa',
	'1de49a74-a5ec-49af-a961-48665d57e95b',
	'264eea4f-04db-4d8a-b9d0-3f16bc3a2d6c',
	'266ca18e-3dd4-458b-8db1-d7bd5c6ae7e6',
	'35161724-4d24-47ab-bdeb-6cb012dd2f50',
	'3cba1b22-aa17-47e9-94ab-0435a63a4664',
	'42d0da85-69bb-4d54-82c8-8820723b678e',
	'59f90127-6d5e-4b68-a98b-bac58bd2a07d',
	'7e84153b-3b6e-4aa7-9a1b-1d310636d68e',
	'8517ae0d-7bc0-4678-ba21-9a73a84717e1',
	'8ce686d5-d696-43c2-8c2b-a43a404aefc3',
	'aac434fd-6e87-4532-923f-8f2e16a20e66',
	'af5e9147-aeab-4305-8075-c1afe20a84f4',
	'b540931b-da51-471d-b0d9-b6e843c42908',
	'd0d0b0f2-7d24-4449-bf64-34e2c936ed83',
	'deff4822-62cb-4963-aff2-76934be4ffdd',
	'e30d86bc-d659-45af-8201-e545a6ab1522',
	'e71b3ced-c6fc-46a9-8084-46dafad00ad2',
	'fba02fa9-d21d-495e-9337-3d62ec682f9b'
];

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const carts = db.collection('cartridge_records');

	console.log(`Checking ${GHOSTS.length} ghost cartridges for any downstream/completed activity`);
	console.log('='.repeat(90));

	// 1. Current status + downstream-phase fingerprint
	const docs = await carts.find({ _id: { $in: GHOSTS } }).toArray() as any[];
	console.log(`\n[1] CartridgeRecord current status + downstream fields:\n`);
	let anyProgressed = 0;
	for (const d of docs) {
		const hasReagentFill = !!d.reagentFilling?.runId;
		const hasReagentInspection = !!d.reagentInspection?.status;
		const hasTopSeal = !!d.topSeal?.batchId;
		const hasOvenCure = !!d.ovenCure?.entryTime;
		const hasStorage = !!(d.storage?.locationId || d.storage?.fridgeName);
		const hasQaqc = !!d.qaqcRelease?.shippingLotId;
		const hasShipping = !!d.shipping?.packageId;
		const hasAssayLoaded = !!d.assayLoaded?.loadedAt;
		const hasTestExec = !!d.testExecution?.executedAt;
		const hasTestResult = !!d.testResult?.status;

		const downstream = [
			hasReagentFill && 'reagentFilling',
			hasReagentInspection && 'reagentInspection',
			hasTopSeal && 'topSeal',
			hasOvenCure && 'ovenCure',
			hasStorage && 'storage',
			hasQaqc && 'qaqcRelease',
			hasShipping && 'shipping',
			hasAssayLoaded && 'assayLoaded',
			hasTestExec && 'testExecution',
			hasTestResult && 'testResult'
		].filter(Boolean);

		if (downstream.length > 0) {
			anyProgressed++;
			console.log(`  ${d._id}  status=${d.status}  DOWNSTREAM FIELDS: ${downstream.join(', ')}`);
		} else {
			console.log(`  ${d._id}  status=${d.status}  (no downstream fields)`);
		}
	}
	console.log(`\n  Summary: ${anyProgressed}/${docs.length} have any downstream fields populated.`);

	// 2. Check audit_logs for any status change history
	console.log(`\n[2] AuditLog history — any status changes?`);
	const audits = await db.collection('audit_logs').find({
		tableName: 'cartridge_records',
		recordId: { $in: GHOSTS }
	}).sort({ changedAt: 1 }).toArray() as any[];
	console.log(`  ${audits.length} audit entries across these 20 cartridges`);
	const byCart: Record<string, any[]> = {};
	for (const a of audits) (byCart[a.recordId] ??= []).push(a);
	for (const [cid, entries] of Object.entries(byCart)) {
		const statuses = entries.map((e) => e.newData?.status).filter(Boolean);
		if (statuses.length > 0) {
			console.log(`  ${cid}: ${entries.length} entries, status path: ${statuses.join(' → ')}`);
		}
	}
	const cartsWithAudit = Object.keys(byCart).length;
	console.log(`  cartridges with any audit entries: ${cartsWithAudit}/${GHOSTS.length}`);

	// 3. Check if any appear in downstream collections
	console.log(`\n[3] References in downstream collections:`);
	const reagentRuns = await db.collection('reagent_batch_records').find({
		'cartridgesFilled.cartridgeId': { $in: GHOSTS }
	}).project({ _id: 1, status: 1 }).toArray() as any[];
	console.log(`  reagent_batch_records mentioning these 20: ${reagentRuns.length}`);
	for (const r of reagentRuns) console.log(`    ${r._id}  status=${r.status}`);

	const shipping = await db.collection('shipping_packages').countDocuments({ cartridgeIds: { $in: GHOSTS } });
	console.log(`  shipping_packages: ${shipping}`);

	const testResults = await db.collection('test_results').countDocuments({ cartridgeId: { $in: GHOSTS } });
	console.log(`  test_results: ${testResults}`);

	const firmwareCarts = await db.collection('firmware_cartridges').countDocuments({ cartridgeRecordId: { $in: GHOSTS } });
	console.log(`  firmware_cartridges: ${firmwareCarts}`);

	const manualRemovals = await db.collection('manual_cartridge_removals').find({ cartridgeIds: { $in: GHOSTS } }).toArray() as any[];
	console.log(`  manual_cartridge_removals: ${manualRemovals.length}`);
	for (const m of manualRemovals) console.log(`    ${m._id}  cartridgeIds=${m.cartridgeIds}  reason="${m.reason}"`);

	// 4. Check wax filling run details — were any of them marked as removed/rejected?
	console.log(`\n[4] Wax filling run membership — check for 'scrapCartridgeIds' or per-cartridge rejection:`);
	const runIds = Array.from(new Set(docs.map((d) => d.waxFilling?.runId).filter(Boolean)));
	for (const rid of runIds) {
		const run = await db.collection('wax_filling_runs').findOne({ _id: rid }) as any;
		if (!run) continue;
		const scraps: string[] = run.scrapCartridgeIds ?? [];
		const mineInRun = docs.filter((d) => d.waxFilling?.runId === rid).map((d) => d._id);
		const intersect = mineInRun.filter((id) => scraps.includes(id));
		console.log(`  run=${rid}  status=${run.status}  scrapCartridgeIds count=${scraps.length}  ghosts in run=${mineInRun.length}  scrapped in-run ghosts=${intersect.length}`);
	}

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
