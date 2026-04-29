/**
 * Post-refactor audit. Verifies the invariants described in the
 * refactor spec by running live queries against Atlas.
 *
 * Sections A-J correspond to the audit checklist.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

function section(title: string) {
	console.log('\n' + '='.repeat(80));
	console.log(title);
	console.log('='.repeat(80));
}

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	const cartridges = db.collection('cartridge_records');
	const backingLots = db.collection('backing_lots');
	const lotRecords = db.collection('lot_records');
	const matTxn = db.collection('material_transactions');
	const invTxn = db.collection('inventory_transactions');
	const auditLogs = db.collection('audit_logs');
	const waxRuns = db.collection('wax_filling_runs');

	// ============================================================
	section('Global counts');
	const totalCarts = await cartridges.countDocuments({});
	const totalLots = await lotRecords.countDocuments({});
	const totalBackingLots = await backingLots.countDocuments({});
	console.log(`cartridge_records: ${totalCarts}`);
	console.log(`lot_records:       ${totalLots}`);
	console.log(`backing_lots:      ${totalBackingLots}`);

	const statusAgg = await cartridges.aggregate([
		{ $group: { _id: '$status', count: { $sum: 1 } } },
		{ $sort: { count: -1 } }
	]).toArray();
	console.log('\ncartridge_records by status:');
	for (const r of statusAgg) console.log(`  ${r._id ?? '(null)'}: ${r.count}`);

	const blStatusAgg = await backingLots.aggregate([
		{ $group: { _id: '$status', count: { $sum: 1 } } }
	]).toArray();
	console.log('\nbacking_lots by status:');
	for (const r of blStatusAgg) console.log(`  ${r._id ?? '(null)'}: ${r.count}`);

	// ============================================================
	section('A. Lineage chain integrity (post-refactor cartridges only)');
	// Post-refactor cartridges: those with backing.parentLotRecordId set.
	const postRefactorCount = await cartridges.countDocuments({ 'backing.parentLotRecordId': { $exists: true, $ne: null } });
	console.log(`Post-refactor cartridges (have backing.parentLotRecordId): ${postRefactorCount}`);

	// Sample the post-refactor cartridges and validate
	const samples = await cartridges.find({ 'backing.parentLotRecordId': { $exists: true, $ne: null } })
		.limit(500).toArray();

	let missingBackingLot = 0;
	let missingLotRecord = 0;
	let bucketMismatch = 0;
	let blankLotMismatch = 0;
	let thermoLotMismatch = 0;
	let barcodeLotMismatch = 0;
	const offenders: any[] = [];

	for (const c of samples) {
		const blId = (c.backing as any)?.lotId;
		const lrId = (c.backing as any)?.parentLotRecordId;
		const bl = blId ? await backingLots.findOne({ _id: blId }) : null;
		const lr = lrId ? await lotRecords.findOne({ _id: lrId }) : null;
		if (!bl) { missingBackingLot++; offenders.push({ _id: c._id, reason: `backing.lotId=${blId} not in backing_lots` }); continue; }
		if (!lr) { missingLotRecord++; offenders.push({ _id: c._id, reason: `backing.parentLotRecordId=${lrId} not in lot_records` }); continue; }
		if ((lr as any).bucketBarcode !== bl._id) { bucketMismatch++; offenders.push({ _id: c._id, reason: `bucketBarcode=${(lr as any).bucketBarcode} != BackingLot._id=${bl._id}` }); continue; }

		// Verify lineage fields against LotRecord.inputLots
		const inputLots: any[] = (lr as any).inputLots ?? [];
		const blank = inputLots.find((l) => l.materialName === 'Cartridge')?.barcode ?? null;
		const thermo = inputLots.find((l) => l.materialName === 'Thermoseal Laser Cut Sheet')?.barcode ?? null;
		const barcode = inputLots.find((l) => l.materialName === 'Barcode')?.barcode ?? null;

		if ((c.backing as any).cartridgeBlankLot !== blank) { blankLotMismatch++; if (offenders.length < 20) offenders.push({ _id: c._id, field: 'cartridgeBlankLot', cart: (c.backing as any).cartridgeBlankLot, lot: blank }); }
		if ((c.backing as any).thermosealLot !== thermo) { thermoLotMismatch++; if (offenders.length < 20) offenders.push({ _id: c._id, field: 'thermosealLot', cart: (c.backing as any).thermosealLot, lot: thermo }); }
		if ((c.backing as any).barcodeLabelLot !== barcode) { barcodeLotMismatch++; if (offenders.length < 20) offenders.push({ _id: c._id, field: 'barcodeLabelLot', cart: (c.backing as any).barcodeLabelLot, lot: barcode }); }
	}

	console.log(`Sampled ${samples.length}:`);
	console.log(`  missing backing_lots:             ${missingBackingLot}`);
	console.log(`  missing lot_records (parent):     ${missingLotRecord}`);
	console.log(`  bucketBarcode != BackingLot._id:  ${bucketMismatch}`);
	console.log(`  cartridgeBlankLot mismatch:       ${blankLotMismatch}`);
	console.log(`  thermosealLot mismatch:           ${thermoLotMismatch}`);
	console.log(`  barcodeLabelLot mismatch:         ${barcodeLotMismatch}`);
	if (offenders.length) {
		console.log('\nFirst few offenders:');
		for (const o of offenders.slice(0, 10)) console.log('  ', JSON.stringify(o));
	}

	// Pre-refactor cartridges: no parentLotRecordId but have backing data
	const preRefactor = await cartridges.countDocuments({
		'backing.lotId': { $exists: true },
		'backing.parentLotRecordId': { $exists: false }
	});
	console.log(`Pre-refactor cartridges (backing.lotId but no parentLotRecordId): ${preRefactor}`);

	// ============================================================
	section('B. BackingLot.cartridgeCount conservation');
	const allBackingLots = await backingLots.find().toArray();
	let invariantViolations = 0;
	const violators: any[] = [];

	for (const bl of allBackingLots) {
		const lrs = await lotRecords.find({ bucketBarcode: bl._id }).toArray();
		if (lrs.length === 0) { continue; }
		const initial = lrs.reduce((s, lr) => s + ((lr as any).quantityProduced ?? 0), 0);

		// pulled = cartridges pointing at this BackingLot (via bucket ID string)
		// that are still non-voided
		const pulled = await cartridges.countDocuments({
			'backing.lotId': String(bl._id),
			status: { $ne: 'voided' }
		});

		const cc = (bl as any).cartridgeCount ?? 0;
		const status = (bl as any).status;
		let ok = false;
		let violation = '';

		if (status === 'consumed') {
			// For consumed: pulled >= initial AND cartridgeCount=0
			ok = (pulled >= initial) && (cc === 0);
			if (!ok) violation = `consumed but cartridgeCount=${cc}, pulled=${pulled}, initial=${initial}`;
		} else if (status === 'in_oven' || status === 'ready') {
			// Running lot: cartridgeCount + pulled should equal initial
			ok = (cc + pulled === initial);
			if (!ok) violation = `${status}: cartridgeCount(${cc}) + pulled(${pulled}) = ${cc + pulled} != initial(${initial})`;
		} else if (status === 'created') {
			// Just created — no individuation yet expected
			ok = (cc === initial && pulled === 0);
			if (!ok) violation = `created: cc=${cc}, pulled=${pulled}, initial=${initial}`;
		}

		if (!ok) {
			invariantViolations++;
			violators.push({ _id: bl._id, status, cartridgeCount: cc, pulled, initial, violation });
		}
	}

	console.log(`BackingLots checked: ${allBackingLots.length}`);
	console.log(`Invariant violations: ${invariantViolations}`);
	if (violators.length) {
		console.log('\nViolators:');
		for (const v of violators.slice(0, 30)) console.log('  ', JSON.stringify(v));
	}

	// ============================================================
	section('F. waxQc.status write on happy path');
	// Count wax_filled/wax_stored cartridges WITHOUT waxQc.status Accepted or Rejected
	const waxQcMissing = await cartridges.countDocuments({
		status: { $in: ['wax_filled', 'wax_stored', 'reagent_filled', 'stored', 'sealed', 'inspected', 'cured', 'released', 'shipped', 'linked', 'completed'] },
		$or: [
			{ 'waxQc.status': { $exists: false } },
			{ 'waxQc.status': { $nin: ['Accepted', 'Rejected'] } }
		]
	});
	console.log(`Advanced cartridges missing waxQc.status in {Accepted,Rejected}: ${waxQcMissing}`);

	// How many have Accepted via the backfill (system-backfill operator)?
	const backfilled = await cartridges.countDocuments({
		'waxQc.operator.username': 'system-backfill'
	});
	console.log(`Cartridges with waxQc.operator.username='system-backfill': ${backfilled}`);

	// Summary of waxQc.status values
	const waxQcAgg = await cartridges.aggregate([
		{ $group: { _id: '$waxQc.status', count: { $sum: 1 } } }
	]).toArray();
	console.log('\nwaxQc.status distribution:');
	for (const r of waxQcAgg) console.log(`  ${r._id ?? '(none)'}: ${r.count}`);

	// ============================================================
	section('D. WI-01 removal side effects');
	// backing.lotId pointing at a LotRecord._id (instead of BackingLot._id)?
	const lotRecIdSet = new Set((await lotRecords.find({}, { projection: { _id: 1 } }).toArray()).map(l => String(l._id)));
	const blIdSet = new Set((await backingLots.find({}, { projection: { _id: 1 } }).toArray()).map(l => String(l._id)));

	const distinctBackingIds = await cartridges.distinct('backing.lotId', { 'backing.lotId': { $exists: true, $ne: null } });
	console.log(`Distinct backing.lotId values on cartridges: ${distinctBackingIds.length}`);
	let pointsToLotRec = 0, pointsToBackingLot = 0, pointsToNothing = 0;
	const orphanBackingLotIds: string[] = [];
	for (const id of distinctBackingIds) {
		if (blIdSet.has(String(id))) pointsToBackingLot++;
		else if (lotRecIdSet.has(String(id))) pointsToLotRec++;
		else { pointsToNothing++; orphanBackingLotIds.push(String(id)); }
	}
	console.log(`  -> BackingLot._id:   ${pointsToBackingLot}`);
	console.log(`  -> LotRecord._id:    ${pointsToLotRec} (legacy — expected 0 post-refactor)`);
	console.log(`  -> Not found:        ${pointsToNothing}`);
	if (orphanBackingLotIds.length) {
		console.log(`  Sample orphan backing.lotId values: ${orphanBackingLotIds.slice(0, 5).join(', ')}`);
	}

	// Material transactions for recent WI-01 runs
	console.log('\nMaterial consumption transactions for last 5 WI-01 lots:');
	const recentWi01 = await lotRecords.find({ 'processConfig.processType': 'backing' }).sort({ createdAt: -1 }).limit(5).toArray();
	for (const lot of recentWi01) {
		const txns = await invTxn.countDocuments({ manufacturingStep: 'backing', manufacturingRunId: lot._id });
		const matTxns = await matTxn.countDocuments({ manufacturingRunId: lot._id }).catch(() => 0);
		console.log(`  lot=${lot._id} produced=${(lot as any).quantityProduced ?? '?'} → inventory_txns=${txns}, material_txns=${matTxns}`);
	}

	// ============================================================
	section('E. Reagent-filling orphan path');
	// Cartridges with no status at all (bare _id from reagent upsert path)
	const statusless = await cartridges.countDocuments({ status: { $exists: false } });
	console.log(`Cartridges with NO status field at all: ${statusless}`);

	const nullStatus = await cartridges.countDocuments({ status: null });
	console.log(`Cartridges with status=null: ${nullStatus}`);

	// Cartridges that went through reagent-filling but have no waxFilling phase
	const reagentWithoutWax = await cartridges.countDocuments({
		'reagentFilling.recordedAt': { $exists: true },
		'waxFilling.recordedAt': { $exists: false }
	});
	console.log(`Cartridges with reagentFilling but no waxFilling phase: ${reagentWithoutWax}`);

	// ============================================================
	section('H. Dangling references to deleted nanoid stubs');
	// A cartridgeRecord was deleted — check for dangling references
	const distinctTxnCartIds = await invTxn.distinct('cartridgeRecordId', { cartridgeRecordId: { $exists: true, $ne: null } });
	const existingIds = new Set((await cartridges.find({}, { projection: { _id: 1 } }).toArray()).map(c => String(c._id)));
	const dangling: string[] = [];
	for (const id of distinctTxnCartIds) {
		if (id && !existingIds.has(String(id))) dangling.push(String(id));
	}
	console.log(`inventory_transactions.cartridgeRecordId referencing non-existent cart: ${dangling.length}`);
	if (dangling.length) console.log(`  Sample: ${dangling.slice(0, 10).join(', ')}`);

	const auditRefs = await auditLogs.distinct('recordId', { tableName: 'cartridge_records' });
	const auditDangling: string[] = [];
	for (const id of auditRefs) {
		if (id && !existingIds.has(String(id)) && String(id) !== 'batch') auditDangling.push(String(id));
	}
	console.log(`audit_logs.recordId (cartridge_records) referencing non-existent cart: ${auditDangling.length}`);
	if (auditDangling.length) console.log(`  Sample: ${auditDangling.slice(0, 10).join(', ')}`);

	// CV inspections / photos
	const cvInspCount = await db.collection('cv_inspections').countDocuments({}).catch(() => 0);
	const cvImgCount = await db.collection('cv_images').countDocuments({}).catch(() => 0);
	console.log(`cv_inspections total: ${cvInspCount}, cv_images total: ${cvImgCount}`);
	if (cvInspCount > 0) {
		const cvRefs = await db.collection('cv_inspections').distinct('cartridgeRecordId', { cartridgeRecordId: { $exists: true } });
		const cvDangling = cvRefs.filter((id: any) => id && !existingIds.has(String(id)));
		console.log(`cv_inspections.cartridgeRecordId dangling: ${cvDangling.length}`);
	}
	if (cvImgCount > 0) {
		const cvImgRefs = await db.collection('cv_images').distinct('cartridgeTag.cartridgeRecordId', { 'cartridgeTag.cartridgeRecordId': { $exists: true } });
		const cvImgDangling = cvImgRefs.filter((id: any) => id && !existingIds.has(String(id)));
		console.log(`cv_images.cartridgeTag.cartridgeRecordId dangling: ${cvImgDangling.length}`);
	}

	// ============================================================
	section('I. Schema safety — sample doc');
	// Find the most recent cartridge with parentLotRecordId
	const recent = await cartridges.findOne(
		{ 'backing.parentLotRecordId': { $exists: true, $ne: null } },
		{ sort: { createdAt: -1 } }
	);
	if (recent) {
		console.log('Most recent post-refactor cartridge:');
		console.log(`  _id: ${recent._id}`);
		console.log(`  createdAt: ${(recent as any).createdAt}`);
		console.log(`  status: ${(recent as any).status}`);
		const bk = (recent as any).backing;
		console.log(`  backing.parentLotRecordId: ${bk?.parentLotRecordId}`);
		console.log(`  backing.lotId: ${bk?.lotId}`);
		console.log(`  backing.lotQrCode: ${bk?.lotQrCode}`);
		console.log(`  backing.cartridgeBlankLot: ${bk?.cartridgeBlankLot}`);
		console.log(`  backing.thermosealLot: ${bk?.thermosealLot}`);
		console.log(`  backing.barcodeLabelLot: ${bk?.barcodeLabelLot}`);
		console.log(`  backing.ovenEntryTime: ${bk?.ovenEntryTime}`);
		console.log(`  backing.ovenExitTime: ${bk?.ovenExitTime}`);
	} else {
		console.log('NO post-refactor cartridges found yet — the refactor has not exercised the new flow in production.');
	}

	// ============================================================
	section('J. Adversarial — places still assuming backing-as-status');
	const stillBacking = await cartridges.countDocuments({ status: 'backing' });
	console.log(`Cartridges with status='backing' remaining: ${stillBacking}`);

	// Partial inconsistencies: ovenExitTime set but waxFilling.recordedAt not set
	const ovenExitNoFill = await cartridges.countDocuments({
		'backing.ovenExitTime': { $exists: true },
		'waxFilling.recordedAt': { $exists: false },
		status: { $nin: ['wax_filling', 'voided', 'scrapped'] }
	});
	console.log(`Carts with backing.ovenExitTime but no waxFilling.recordedAt & not in wax_filling/voided: ${ovenExitNoFill}`);

	// Duplicate LotRecord rows for the same bucketBarcode
	const dupBuckets = await lotRecords.aggregate([
		{ $match: { bucketBarcode: { $exists: true, $ne: null } } },
		{ $group: { _id: '$bucketBarcode', count: { $sum: 1 }, lots: { $push: '$_id' } } },
		{ $match: { count: { $gt: 1 } } }
	]).toArray();
	console.log(`Duplicate bucketBarcode → LotRecord count: ${dupBuckets.length}`);
	if (dupBuckets.length) {
		for (const d of dupBuckets.slice(0, 5)) console.log(`  bucket=${d._id} → ${d.count} LotRecords (${d.lots.join(', ')})`);
	}

	// Nanoid-shaped _ids in cartridge_records (the delete was supposed to remove them)
	// Shape: 21-char nanoid string, vs UUID shape 36-char with dashes
	const allIds = await cartridges.find({}, { projection: { _id: 1 } }).limit(100000).toArray();
	const nanoShaped = allIds.filter(d => typeof d._id === 'string' && (d._id as string).length < 30 && !(d._id as string).includes('-'));
	console.log(`cartridge_records with nanoid-shaped _id: ${nanoShaped.length}`);
	if (nanoShaped.length) console.log(`  Sample: ${nanoShaped.slice(0, 5).map(d => d._id).join(', ')}`);

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
