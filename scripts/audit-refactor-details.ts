/**
 * Deeper look at the findings from audit-refactor.ts
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	const cartridges = db.collection('cartridge_records');
	const backingLots = db.collection('backing_lots');
	const lotRecords = db.collection('lot_records');

	// ---- 1. Investigate the 101 nanoid-shaped _ids ----
	console.log('== Nanoid-shaped _id cartridges ==');
	const all = await cartridges.find({}, { projection: { _id: 1, status: 1, createdAt: 1, 'backing.lotId': 1 } }).toArray();
	const nano = all.filter(d => typeof d._id === 'string' && (d._id as string).length < 30 && !(d._id as string).includes('-'));
	console.log(`Found ${nano.length} nanoid-shaped _id rows. Breakdown by status:`);
	const byStatus: Record<string, number> = {};
	for (const d of nano) byStatus[(d as any).status ?? '(none)'] = (byStatus[(d as any).status ?? '(none)'] ?? 0) + 1;
	for (const [k, v] of Object.entries(byStatus)) console.log(`  ${k}: ${v}`);

	// Show a few samples
	console.log('\nSamples (first 20):');
	for (const d of nano.slice(0, 20)) {
		console.log(`  _id=${d._id} status=${(d as any).status} created=${(d as any).createdAt} backing.lotId=${(d as any).backing?.lotId}`);
	}

	// ---- 2. Investigate the 8 backing.lotId values pointing at LotRecord._id ----
	console.log('\n== backing.lotId pointing at LotRecord._id (legacy) ==');
	const distinctBackingIds = await cartridges.distinct('backing.lotId', { 'backing.lotId': { $exists: true, $ne: null } });
	const lotRecIdSet = new Set((await lotRecords.find({}, { projection: { _id: 1 } }).toArray()).map(l => String(l._id)));
	const blIdSet = new Set((await backingLots.find({}, { projection: { _id: 1 } }).toArray()).map(l => String(l._id)));
	const pointsToLotRec: string[] = [];
	const pointsToBackingLot: string[] = [];
	const pointsToNothing: string[] = [];
	for (const id of distinctBackingIds) {
		const s = String(id);
		if (blIdSet.has(s)) pointsToBackingLot.push(s);
		else if (lotRecIdSet.has(s)) pointsToLotRec.push(s);
		else pointsToNothing.push(s);
	}
	console.log('LotRecord._id values in backing.lotId (legacy refs):');
	for (const id of pointsToLotRec) {
		const n = await cartridges.countDocuments({ 'backing.lotId': id });
		const lot = await lotRecords.findOne({ _id: id });
		console.log(`  ${id} — ${n} cartridges — bucket=${(lot as any)?.bucketBarcode} status=${(lot as any)?.status}`);
	}
	console.log('BackingLot._id values in backing.lotId (correct refs):');
	for (const id of pointsToBackingLot) {
		const n = await cartridges.countDocuments({ 'backing.lotId': id });
		console.log(`  ${id} — ${n} cartridges`);
	}
	console.log('Values NOT found (orphans):');
	for (const id of pointsToNothing) {
		const n = await cartridges.countDocuments({ 'backing.lotId': id });
		console.log(`  "${id}" — ${n} cartridges`);
	}

	// ---- 3. The 1109 cartridges with no waxQc.status: what are they? ----
	console.log('\n== Cartridges with NO waxQc.status ==');
	const noQc = await cartridges.aggregate([
		{ $match: { $or: [{ 'waxQc.status': { $exists: false } }, { 'waxQc.status': null }] } },
		{ $group: { _id: '$status', count: { $sum: 1 } } },
		{ $sort: { count: -1 } }
	]).toArray();
	for (const r of noQc) console.log(`  status=${r._id ?? '(none)'}: ${r.count}`);

	// ---- 4. The InventoryTransaction dangling 242 refs — are they pre-refactor or post-refactor? ----
	console.log('\n== Dangling inventory_transactions.cartridgeRecordId ==');
	const invTxn = db.collection('inventory_transactions');
	const existingIds = new Set((await cartridges.find({}, { projection: { _id: 1 } }).toArray()).map(c => String(c._id)));
	const distinctCartIds = await invTxn.distinct('cartridgeRecordId', { cartridgeRecordId: { $exists: true, $ne: null } });
	const dangling = distinctCartIds.filter((id: any) => id && !existingIds.has(String(id)));
	// Classify by shape
	let cartDashShape = 0, uuidShape = 0, nanoShape = 0, otherShape = 0;
	for (const id of dangling) {
		const s = String(id);
		if (s.startsWith('CART-')) cartDashShape++;
		else if (s.includes('-') && s.length === 36) uuidShape++;
		else if (s.length < 30 && !s.includes('-')) nanoShape++;
		else otherShape++;
	}
	console.log(`Total dangling: ${dangling.length}`);
	console.log(`  CART-* shape:  ${cartDashShape} (likely test fixtures / seed)`);
	console.log(`  UUID shape:    ${uuidShape} (most likely deleted WI-01 stubs)`);
	console.log(`  nanoid shape:  ${nanoShape}`);
	console.log(`  other:         ${otherShape}`);

	// ---- 5. Duplicate bucketBarcode: LotRecord duplication for bucket 5b867012 ----
	console.log('\n== Duplicate bucketBarcode=5b867012-5207-4c53-9d28-a1a69ce34924 ==');
	const dupLots = await lotRecords.find({ bucketBarcode: '5b867012-5207-4c53-9d28-a1a69ce34924' }).toArray();
	for (const l of dupLots) {
		console.log(`  _id=${l._id} status=${(l as any).status} quantityProduced=${(l as any).quantityProduced} finishTime=${(l as any).finishTime}`);
	}
	const bl = await backingLots.findOne({ _id: '5b867012-5207-4c53-9d28-a1a69ce34924' });
	console.log(`  BackingLot status=${(bl as any)?.status}, cartridgeCount=${(bl as any)?.cartridgeCount}`);

	// ---- 6. Test the concurrent-loadDeck race scenario symbolically ----
	console.log('\n== BackingLot cartridgeCount state check (current consumed lots) ==');
	const consumed = await backingLots.find({ status: 'consumed' }).toArray();
	for (const c of consumed) {
		const related = await cartridges.countDocuments({ 'backing.lotId': c._id, status: { $ne: 'voided' } });
		console.log(`  ${c._id}: cartridgeCount=${(c as any).cartridgeCount} cartridges linked (non-voided)=${related}`);
	}

	const inOven = await backingLots.find({ status: { $in: ['in_oven', 'ready'] } }).toArray();
	for (const b of inOven) {
		const lr = await lotRecords.findOne({ bucketBarcode: b._id });
		const related = await cartridges.countDocuments({ 'backing.lotId': b._id });
		console.log(`  in_oven/ready: ${b._id}: cc=${(b as any).cartridgeCount} quantityProduced=${(lr as any)?.quantityProduced} cartridges linked=${related}`);
	}

	// ---- 7. Reagent-filling orphan: check what statuses loadDeck sees ----
	// Sample cartridges at reagent_filled + stored: do they have reagentFilling written? waxFilling written?
	console.log('\n== Sample reagent_filled cartridges ==');
	const rfSamples = await cartridges.find({ status: 'reagent_filled' }).limit(3).toArray();
	for (const c of rfSamples) {
		const ca = c as any;
		console.log(`  _id=${c._id} status=${ca.status}`);
		console.log(`    waxFilling.recordedAt: ${ca.waxFilling?.recordedAt}`);
		console.log(`    waxQc.status: ${ca.waxQc?.status}`);
		console.log(`    reagentFilling.recordedAt: ${ca.reagentFilling?.recordedAt}`);
	}

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
