import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const CID = '50ce9f00-bff6-42d3-ad14-b8540f4e5d9a';

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	console.log(`=========== FULL TRACE: ${CID} ===========\n`);

	// 1. Full cartridge document
	const c = await db.collection('cartridge_records').findOne({ _id: CID } as any);
	if (!c) {
		console.log('NOT FOUND');
		await mongoose.disconnect();
		return;
	}
	console.log('─── CARTRIDGE_RECORD (full) ───');
	console.log(JSON.stringify(c, null, 2));

	// 2. AuditLog history (chronological)
	console.log('\n─── AUDIT_LOGS (chronological) ───');
	const logs = await db.collection('audit_logs').find({ recordId: CID }).sort({ changedAt: 1 }).toArray();
	console.log(`count: ${logs.length}`);
	for (const l of logs as any[]) {
		const when = l.changedAt instanceof Date ? l.changedAt.toISOString() : l.changedAt;
		console.log(`  ${when}  action=${l.action}  table=${l.tableName}  changedBy=${l.changedBy}`);
		if (l.newData) console.log(`    newData: ${JSON.stringify(l.newData)?.slice(0, 400)}`);
		if (l.oldData) console.log(`    oldData: ${JSON.stringify(l.oldData)?.slice(0, 400)}`);
		if (l.reason) console.log(`    reason: ${l.reason}`);
	}

	// 3. Inventory transactions tied to this cartridge
	console.log('\n─── INVENTORY_TRANSACTIONS ───');
	const txns = await db.collection('inventory_transactions').find({ cartridgeRecordId: CID }).sort({ performedAt: 1 }).toArray();
	console.log(`count: ${txns.length}`);
	for (const t of txns as any[]) {
		const when = t.performedAt instanceof Date ? t.performedAt.toISOString() : t.performedAt;
		console.log(`  ${when}  type=${t.transactionType}  step=${t.manufacturingStep}  qty=${t.quantity}  op=${t.operatorUsername}`);
		console.log(`    part=${t.partDefinitionId}  runId=${t.manufacturingRunId}  retracted=${!!t.retractedAt}`);
		if (t.scrapReason) console.log(`    scrapReason: ${t.scrapReason}`);
		if (t.notes) console.log(`    notes: ${String(t.notes).slice(0, 160)}`);
	}

	// 4. ManualCartridgeRemoval entries containing this cartridge
	console.log('\n─── MANUAL_CARTRIDGE_REMOVALS containing this cartridge ───');
	const removals = await db.collection('manual_cartridge_removals').find({ cartridgeIds: CID }).sort({ removedAt: 1 }).toArray();
	console.log(`count: ${removals.length}`);
	for (const r of removals as any[]) {
		console.log(`  _id=${r._id}  removedAt=${r.removedAt}  operator=${r.operator?.username}`);
		console.log(`    reason: ${r.reason}`);
		console.log(`    groupSize: ${r.cartridgeIds?.length}`);
	}

	// 5. Related wax_filling_run
	const waxRunId = (c as any).waxFilling?.runId;
	if (waxRunId) {
		console.log(`\n─── WAX_FILLING_RUN (${waxRunId}) ───`);
		const wr = await db.collection('wax_filling_runs').findOne({ _id: waxRunId } as any);
		if (wr) {
			const w: any = wr;
			console.log(`  status: ${w.status}`);
			console.log(`  operator: ${w.operator?.username}`);
			console.log(`  robot: ${w.robot?.name} (${w.robot?._id})`);
			console.log(`  activeLotId: ${w.activeLotId}`);
			console.log(`  cartridgeIds count: ${w.cartridgeIds?.length}`);
			console.log(`  runStartTime: ${w.runStartTime}`);
			console.log(`  runEndTime: ${w.runEndTime}`);
			console.log(`  coolingConfirmedAt: ${w.coolingConfirmedAt ?? w.coolingConfirmedTime}`);
			console.log(`  robotReleasedAt: ${w.robotReleasedAt}`);
			console.log(`  abortReason: ${w.abortReason}`);
			console.log(`  voidReason: ${w.voidReason}`);
		}
	}

	// 6. Related reagent_batch_record
	const reagentRunId = (c as any).reagentFilling?.runId;
	if (reagentRunId) {
		console.log(`\n─── REAGENT_BATCH_RECORD (${reagentRunId}) ───`);
		const rr = await db.collection('reagent_batch_records').findOne({ _id: reagentRunId } as any);
		if (rr) {
			const r: any = rr;
			console.log(`  status: ${r.status}`);
			console.log(`  operator: ${r.operator?.username}`);
			console.log(`  robot: ${r.robot?.name} (${r.robot?._id})`);
			console.log(`  assayType: ${JSON.stringify(r.assayType)}`);
			console.log(`  isResearch: ${r.isResearch}`);
			console.log(`  cartridgesFilled count: ${r.cartridgesFilled?.length}`);
			console.log(`  setupTimestamp: ${r.setupTimestamp}`);
			console.log(`  runEndTime: ${r.runEndTime}`);
			console.log(`  robotReleasedAt: ${r.robotReleasedAt}`);
		}
	}

	// 7. BackingLot for parent
	const backingLotId = (c as any).backing?.lotId;
	const backingParent = (c as any).backing?.parentLotRecordId;
	if (backingLotId) {
		console.log(`\n─── BACKING_LOT (${backingLotId}) ───`);
		const bl = await db.collection('backing_lots').findOne({ _id: backingLotId } as any);
		if (bl) console.log(JSON.stringify(bl, null, 2).slice(0, 1200));
		else console.log('  (not found — may be legacy barcode key)');
	}
	if (backingParent) {
		console.log(`\n─── LOT_RECORD parent (${backingParent}) ───`);
		const lr = await db.collection('lot_records').findOne({ _id: backingParent } as any);
		if (lr) {
			const l: any = lr;
			console.log(`  status: ${l.status}`);
			console.log(`  operator: ${l.operator?.username}`);
			console.log(`  quantityProduced: ${l.quantityProduced}`);
			console.log(`  actualConsumedCount: ${l.actualConsumedCount}`);
			console.log(`  createdAt: ${l.createdAt}`);
		}
	}

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
