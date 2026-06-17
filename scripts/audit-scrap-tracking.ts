/**
 * Audit of the scrapped-tracking system.
 *
 * Verifies:
 *  A. CartridgeRecord.status='scrapped' — contract: must have voidedAt + voidReason
 *     and (if wax/reagent/top-seal) a matching InventoryTransaction of
 *     type='scrap' with quantity=1.
 *  B. LotRecord scrap fields — scrapCount = scrapDetail.cartridge + thermoseal + barcode.
 *     If scrapCount > 0, scrapReason must exist.
 *  C. WI-01 double-entry — for each LotRecord with scrapDetail>0, every part with
 *     scrap must have BOTH a 'consumption' txn (total=good+scrap) AND a 'scrap'
 *     txn (scrap-only) on manufacturingStep='backing' with manufacturingRunId=lot._id.
 *  D. PartDefinition inventory deduction sanity — sum(consumption.quantity) in
 *     'backing' step equals sum(quantityProduced + scrapDetail[part]) across lots.
 *  E. Orphan scrap txns — InventoryTransaction(type='scrap', cartridgeRecordId) must
 *     point to an existing CartridgeRecord whose status='scrapped'.
 *  F. Duplicate scrap — no >1 scrap txn per (cartridgeRecordId, manufacturingStep).
 *  G. Scrap sources by manufacturingStep.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

type Issue = { severity: 'ERROR' | 'WARN' | 'INFO'; area: string; detail: string };
const issues: Issue[] = [];
function flag(severity: Issue['severity'], area: string, detail: string) {
	issues.push({ severity, area, detail });
}

async function main() {
	const URI = process.env.MONGODB_URI;
	if (!URI) throw new Error('MONGODB_URI not set');
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;
	const carts = db.collection('cartridge_records');
	const lots = db.collection('lot_records');
	const txns = db.collection('inventory_transactions');
	const parts = db.collection('part_definitions');

	console.log('='.repeat(72));
	console.log(' SCRAP TRACKING AUDIT');
	console.log('='.repeat(72));

	// -- (G) Scrap sources ----------------------------------------------------
	console.log('\n[G] Scrap sources — InventoryTransaction(type="scrap") by manufacturingStep');
	const scrapByStep = await txns.aggregate([
		{ $match: { transactionType: 'scrap' } },
		{ $group: { _id: '$manufacturingStep', n: { $sum: 1 }, qty: { $sum: '$quantity' } } },
		{ $sort: { n: -1 } }
	]).toArray();
	if (scrapByStep.length === 0) {
		console.log('  (no scrap transactions found)');
	} else {
		for (const g of scrapByStep) {
			console.log(`  step=${g._id ?? '(none)'}  txns=${g.n}  total_qty=${g.qty}`);
		}
	}
	const totalScrapTxns = scrapByStep.reduce((a, b: any) => a + b.n, 0);
	const totalScrapQty = scrapByStep.reduce((a, b: any) => a + b.qty, 0);
	console.log(`  -- total scrap txns: ${totalScrapTxns}  total scrap qty: ${totalScrapQty}`);

	// -- (A) CartridgeRecord scrapped contract --------------------------------
	console.log('\n[A] CartridgeRecord.status="scrapped" contract (voidedAt + voidReason + txn)');
	const scrappedCarts = await carts.find({ status: 'scrapped' }).toArray();
	console.log(`  scrapped cartridges: ${scrappedCarts.length}`);

	let missingVoidedAt = 0, missingReason = 0, missingTxn = 0;
	const scrapTxnCartIds = new Set<string>(
		(await txns.find({ transactionType: 'scrap', cartridgeRecordId: { $exists: true, $ne: null } })
			.project({ cartridgeRecordId: 1 }).toArray()).map((t: any) => t.cartridgeRecordId)
	);
	for (const c of scrappedCarts as any[]) {
		if (!c.voidedAt) { missingVoidedAt++; flag('ERROR', 'A', `cartridge ${c._id}: status=scrapped but no voidedAt`); }
		if (!c.voidReason) { missingReason++; flag('ERROR', 'A', `cartridge ${c._id}: status=scrapped but no voidReason`); }
		if (!scrapTxnCartIds.has(c._id)) { missingTxn++; flag('ERROR', 'A', `cartridge ${c._id} (${c.voidReason ?? '?'}): no InventoryTransaction of type=scrap`); }
	}
	console.log(`  missing voidedAt:   ${missingVoidedAt}`);
	console.log(`  missing voidReason: ${missingReason}`);
	console.log(`  missing scrap txn:  ${missingTxn}`);

	// Also: inspect voidReason values to separate source of scrap
	const byReason = await carts.aggregate([
		{ $match: { status: 'scrapped' } },
		{ $group: { _id: { $arrayElemAt: [{ $split: ['$voidReason', ':'] }, 0] }, n: { $sum: 1 } } },
		{ $sort: { n: -1 } }
	]).toArray();
	console.log('  breakdown by voidReason prefix:');
	for (const r of byReason) console.log(`    ${r._id ?? '(null)'}: ${r.n}`);

	// -- (B) LotRecord scrap-field integrity ----------------------------------
	console.log('\n[B] LotRecord scrap fields — scrapCount=sum(scrapDetail) && reason when >0');
	const scrappedLots = await lots.find({ $or: [{ scrapCount: { $gt: 0 } }, { 'scrapDetail.cartridge': { $gt: 0 } }, { 'scrapDetail.thermoseal': { $gt: 0 } }, { 'scrapDetail.barcode': { $gt: 0 } }] }).toArray();
	console.log(`  lots with any scrap: ${scrappedLots.length}`);
	let lotSumMismatch = 0, lotMissingReason = 0;
	for (const l of scrappedLots as any[]) {
		const d = l.scrapDetail ?? {};
		const sum = (d.cartridge ?? 0) + (d.thermoseal ?? 0) + (d.barcode ?? 0);
		if ((l.scrapCount ?? 0) !== sum) { lotSumMismatch++; flag('ERROR', 'B', `lot ${l._id}: scrapCount=${l.scrapCount} ≠ scrapDetail sum=${sum} (c=${d.cartridge} t=${d.thermoseal} b=${d.barcode})`); }
		if ((l.scrapCount ?? 0) > 0 && !l.scrapReason) { lotMissingReason++; flag('ERROR', 'B', `lot ${l._id}: scrapCount=${l.scrapCount} but no scrapReason`); }
	}
	console.log(`  scrapCount ≠ scrapDetail sum: ${lotSumMismatch}`);
	console.log(`  missing scrapReason:          ${lotMissingReason}`);

	// -- (C) WI-01 double-entry -----------------------------------------------
	console.log('\n[C] WI-01 double-entry — consumption + scrap per part for every scrapped lot');
	const partMap: Record<string, string> = { cartridge: 'PT-CT-104', thermoseal: 'PT-CT-112', barcode: 'PT-CT-106' };
	const partIdByNumber: Record<string, string | null> = {};
	for (const pn of Object.values(partMap)) {
		const p = await parts.findOne({ partNumber: pn });
		partIdByNumber[pn] = p?._id ?? null;
	}
	let lotsMissingConsumption = 0, lotsMissingScrapTxn = 0, lotsQtyMismatch = 0;
	for (const l of scrappedLots as any[]) {
		const d = l.scrapDetail ?? {};
		for (const [fieldName, pn] of Object.entries(partMap)) {
			const scrapQty = d[fieldName] ?? 0;
			if (scrapQty <= 0) continue;
			const pid = partIdByNumber[pn];
			const cons = await txns.findOne({ transactionType: 'consumption', manufacturingRunId: l._id, manufacturingStep: 'backing', partDefinitionId: pid });
			const scrapT = await txns.findOne({ transactionType: 'scrap', manufacturingRunId: l._id, manufacturingStep: 'backing', partDefinitionId: pid });
			if (!cons) { lotsMissingConsumption++; flag('ERROR', 'C', `lot ${l._id} ${pn}: no consumption txn`); }
			if (!scrapT) { lotsMissingScrapTxn++; flag('ERROR', 'C', `lot ${l._id} ${pn}: no scrap txn (expected qty=${scrapQty})`); continue; }
			if (scrapT.quantity !== scrapQty) { lotsQtyMismatch++; flag('ERROR', 'C', `lot ${l._id} ${pn}: scrap txn qty=${scrapT.quantity} but scrapDetail=${scrapQty}`); }
			const expectedCons = (l.quantityProduced ?? 0) + scrapQty;
			if (cons && cons.quantity !== expectedCons) { flag('WARN', 'C', `lot ${l._id} ${pn}: consumption qty=${cons.quantity} expected (produced+scrap)=${expectedCons}`); }
		}
	}
	console.log(`  missing consumption txn: ${lotsMissingConsumption}`);
	console.log(`  missing scrap txn:       ${lotsMissingScrapTxn}`);
	console.log(`  scrap qty mismatch:      ${lotsQtyMismatch}`);

	// -- (D) Aggregate sanity on backing consumption --------------------------
	// Superseded lots count too: their first-submission consumption is real
	// physical material waste from an aborted attempt. Retracted txns (marked
	// after duplicate-submission cleanup) don't count — they've been reversed.
	console.log('\n[D] Backing-step consumption totals (Completed + Superseded lots, retracted txns excluded)');
	const accountedLots = await lots.find({ status: { $in: ['Completed', 'Superseded'] } }).project({ _id: 1, quantityProduced: 1, scrapDetail: 1 }).toArray();
	const lotTotals: Record<string, number> = { 'PT-CT-104': 0, 'PT-CT-112': 0, 'PT-CT-106': 0 };
	for (const l of accountedLots as any[]) {
		const d = l.scrapDetail ?? {};
		lotTotals['PT-CT-104'] += (l.quantityProduced ?? 0) + (d.cartridge ?? 0);
		lotTotals['PT-CT-112'] += (l.quantityProduced ?? 0) + (d.thermoseal ?? 0);
		lotTotals['PT-CT-106'] += (l.quantityProduced ?? 0) + (d.barcode ?? 0);
	}
	for (const [pn, expected] of Object.entries(lotTotals)) {
		const pid = partIdByNumber[pn];
		const agg = await txns.aggregate([
			{ $match: { transactionType: 'consumption', manufacturingStep: 'backing', partDefinitionId: pid, retractedAt: { $exists: false } } },
			{ $group: { _id: null, q: { $sum: '$quantity' } } }
		]).toArray();
		const actual = (agg[0] as any)?.q ?? 0;
		const ok = actual === expected ? 'OK' : 'MISMATCH';
		console.log(`  ${pn}: expected_sum=${expected}  txn_sum=${actual}  ${ok}`);
		if (actual !== expected) flag('ERROR', 'D', `${pn}: backing consumption txns sum=${actual} ≠ expected (produced+scrap)=${expected}`);
	}

	// -- (E) Orphan scrap transactions ----------------------------------------
	// Retracted txns are excluded — they represent reversed/corrected writes
	// (see scripts/fix-retract-superseded-lot-txns.ts and
	// scripts/fix-revert-incorrect-checkout-scrap.ts).
	console.log('\n[E] Orphan scrap txns — cartridgeRecordId not found or status≠scrapped (retracted excluded)');
	const cartScrapTxns = await txns.find({ transactionType: 'scrap', cartridgeRecordId: { $exists: true, $ne: null }, retractedAt: { $exists: false } }).toArray();
	let orphan = 0, wrongStatus = 0;
	for (const t of cartScrapTxns as any[]) {
		const c = await carts.findOne({ _id: t.cartridgeRecordId });
		if (!c) { orphan++; flag('ERROR', 'E', `scrap txn ${t._id} references missing cartridge ${t.cartridgeRecordId}`); }
		else if (c.status !== 'scrapped') { wrongStatus++; flag('WARN', 'E', `scrap txn ${t._id}: cartridge ${t.cartridgeRecordId} status=${c.status} (not scrapped)`); }
	}
	console.log(`  orphan scrap txns:           ${orphan}`);
	console.log(`  cartridge not in scrapped:   ${wrongStatus}`);

	// -- (F) Duplicate scrap txns per cartridge+step --------------------------
	console.log('\n[F] Duplicate scrap txns per (cartridgeRecordId, manufacturingStep)');
	const dups = await txns.aggregate([
		{ $match: { transactionType: 'scrap', cartridgeRecordId: { $exists: true, $ne: null } } },
		{ $group: { _id: { c: '$cartridgeRecordId', s: '$manufacturingStep' }, n: { $sum: 1 } } },
		{ $match: { n: { $gt: 1 } } }
	]).toArray();
	console.log(`  duplicates found: ${dups.length}`);
	for (const d of dups) {
		flag('WARN', 'F', `cartridge ${(d._id as any).c} step=${(d._id as any).s} has ${d.n} scrap txns`);
	}

	// -- Summary -----------------------------------------------------------
	console.log('\n' + '='.repeat(72));
	console.log(' SUMMARY');
	console.log('='.repeat(72));
	const errCount = issues.filter(i => i.severity === 'ERROR').length;
	const warnCount = issues.filter(i => i.severity === 'WARN').length;
	console.log(`ERRORS: ${errCount}`);
	console.log(`WARNINGS: ${warnCount}`);
	if (issues.length === 0) console.log('\nAll checks passed.');
	else {
		console.log('\nFirst 40 issues:');
		for (const i of issues.slice(0, 40)) console.log(`  [${i.severity}] ${i.area}: ${i.detail}`);
		if (issues.length > 40) console.log(`  ...and ${issues.length - 40} more`);
	}

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
