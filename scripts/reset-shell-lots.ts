/**
 * Shell (PT-CT-104) lot reset for a new shipment (Jacob, 2026-10-05):
 * "we have depleted all and just got a new shipment".
 *
 *   1. Every PT-CT-104 lot that still shows stock is closed out: its received
 *      quantity is corrected down to what the ledger says was used, so
 *      remaining = 0 and it drops out of the bucket board's lot picker
 *      (lot-remaining.ts: remaining = quantity − Σ consumption+scrap).
 *      The lot documents are NOT deleted — cartridges (backing.cartridgeBlankLot),
 *      bucket passes (sourceLots) and the inventory ledger all point at them.
 *   2. The part count is zeroed with an `adjustment` row (the old stock is gone).
 *   3. One new accepted lot is created with --qty shells (receipt row, part +qty).
 *
 * Dry-run by default; --apply to write. Refuses to create a second lot the same day.
 *
 *   npx tsx scripts/reset-shell-lots.ts [--qty 5000] [--apply]
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { nanoid, customAlphabet } from 'nanoid';
dotenv.config();

const APPLY = process.argv.includes('--apply');
const qi = process.argv.indexOf('--qty');
const QTY = qi > -1 ? Number(process.argv[qi + 1]) : 5000;
const PART = 'PT-CT-104';
const ACTOR = { _id: 'script', username: 'claude (req: alejandrov)' };
const MARK = 'shell-lot-reset-2026-10-05';

async function main() {
	if (!Number.isInteger(QTY) || QTY <= 0) throw new Error('--qty must be a positive integer');
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	console.log(`db: ${db.databaseName}   ${new Date().toISOString()}   ${APPLY ? '*** APPLY ***' : '(dry run)'}`);
	const lots = db.collection('receiving_lots');
	const txs = db.collection('inventory_transactions');
	const parts = db.collection('part_definitions');
	const audit = db.collection('audit_log');

	const part = await parts.findOne({ partNumber: PART }) as any;
	if (!part) throw new Error(`${PART} not found`);
	console.log(`${PART} "${part.name}"  inventoryCount ${part.inventoryCount}`);

	const used = async (lotId: string) => {
		const a = await txs.aggregate([{ $match: { lotId, transactionType: { $in: ['consumption', 'scrap'] } } }, { $group: { _id: null, t: { $sum: '$quantity' } } }]).toArray() as any[];
		return Math.abs(Number(a[0]?.t ?? 0));
	};
	const all = await lots.find({ 'part.partNumber': PART, status: { $nin: ['rejected', 'returned'] } }).sort({ createdAt: 1 }).toArray() as any[];
	const rows = [];
	for (const l of all) { const u = await used(l.lotId); rows.push({ l, used: u, remaining: Number(l.quantity ?? 0) - u }); }
	console.log('\nexisting lots:');
	for (const r of rows) console.log(`  ${String(r.l.lotId).padEnd(40)} qty ${String(r.l.quantity).padStart(5)}  used ${String(r.used).padStart(5)}  remaining ${String(r.remaining).padStart(5)}  ${r.remaining > 0 ? '<-- in the picker, will be closed out' : '(already out of the picker)'}`);
	const toClose = rows.filter(r => r.remaining > 0);
	if (rows.some(r => String(r.l.notes ?? '').includes(MARK) && r.l.createdAt?.toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10) && r.l.operator?._id === 'script' && r.remaining > 0 && Number(r.l.quantity) === QTY)) {
		throw new Error('A lot created by this script today already exists — not creating another.');
	}

	const d = new Date();
	const newLotId = `LOT-${d.toISOString().slice(0, 10).replace(/-/g, '')}-${customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 4)()}`;
	console.log(`\nplan: close out ${toClose.length} lot(s) (${toClose.reduce((s, r) => s + r.remaining, 0)} shells written off the lot quantities), zero the part count (${part.inventoryCount} → 0), create ${newLotId} with ${QTY} → part count ${QTY}`);
	if (!APPLY) { console.log('\nDry run only — re-run with --apply to write.'); await mongoose.disconnect(); return; }

	const now = new Date();
	// 1. close out the old lots
	for (const r of toClose) {
		const u = await used(r.l.lotId); // re-read: scan-ins may have landed since the listing
		await lots.updateOne({ _id: r.l._id }, { $set: { quantity: u, updatedAt: now, notes: `${r.l.notes ? r.l.notes + '\n' : ''}[${MARK}] Closed out: physical stock depleted. Received quantity corrected ${r.l.quantity} → ${u} (what the ledger shows used).` } });
		await audit.insertOne({ _id: nanoid() as any, tableName: 'receiving_lots', recordId: r.l._id, action: 'UPDATE', oldData: { quantity: r.l.quantity }, newData: { quantity: u, remaining: 0 }, reason: `Shell lot ${r.l.lotId} closed out — stock depleted, new shipment received (${MARK})`, changedAt: now, changedBy: ACTOR.username });
		console.log(`  closed ${r.l.lotId}: quantity ${r.l.quantity} → ${u}`);
	}

	// 2. zero the part count ($inc so a concurrent scan-in is not lost)
	const before = await parts.findOne({ _id: part._id }) as any;
	const delta = -Number(before.inventoryCount ?? 0);
	if (delta !== 0) {
		const after = await parts.findOneAndUpdate({ _id: part._id }, { $inc: { inventoryCount: delta } }, { returnDocument: 'after' }) as any;
		const newQ = Number((after?.value ?? after)?.inventoryCount ?? 0);
		await txs.insertOne({ _id: nanoid() as any, transactionType: 'adjustment', partDefinitionId: part._id, quantity: delta, previousQuantity: newQ - delta, newQuantity: newQ, operatorId: ACTOR._id, operatorUsername: ACTOR.username, performedBy: ACTOR.username, performedAt: now, notes: `Physical count: all prior ${PART} shell stock depleted before the new shipment (${MARK})`, reason: `Old shell stock depleted (${MARK})`, createdAt: now, updatedAt: now });
		console.log(`  part count adjusted ${newQ - delta} → ${newQ}`);
	}

	// 3. the new lot
	const lotDocId = nanoid();
	await lots.insertOne({
		_id: lotDocId as any, lotId: newLotId, lotNumber: newLotId,
		part: { _id: part._id, partNumber: PART, name: part.name },
		quantity: QTY, consumedUl: 0, operator: ACTOR, inspectionPathway: 'coc',
		status: 'accepted', dispositionType: 'accepted', disposedAt: now, disposedBy: ACTOR,
		notes: `[${MARK}] New shell shipment, ${QTY} shells. Created by script at Jacob's request — no receiving inspection recorded.`,
		photos: [], additionalDocuments: [], cocPhotos: [], firstArticleInspection: false,
		storageConditionsRequired: false, esdHandlingRequired: false, overrideApplied: false,
		createdAt: now, updatedAt: now
	});
	const after = await parts.findOneAndUpdate({ _id: part._id }, { $inc: { inventoryCount: QTY } }, { returnDocument: 'after' }) as any;
	const newQ = Number((after?.value ?? after)?.inventoryCount ?? 0);
	await txs.insertOne({ _id: nanoid() as any, transactionType: 'receipt', partDefinitionId: part._id, lotId: newLotId, quantity: QTY, previousQuantity: newQ - QTY, newQuantity: newQ, operatorId: ACTOR._id, operatorUsername: ACTOR.username, performedBy: ACTOR.username, performedAt: now, notes: `Manual lot creation ${newLotId}: ${QTY}x ${part.name} — new shell shipment (${MARK})`, reason: `Manual lot creation ${newLotId} (${MARK})`, createdAt: now, updatedAt: now });
	await audit.insertOne({ _id: nanoid() as any, tableName: 'receiving_lots', recordId: lotDocId, action: 'INSERT', newData: { lotId: newLotId, partNumber: PART, quantity: QTY, status: 'accepted' }, reason: `New shell shipment lot (${MARK})`, changedAt: now, changedBy: ACTOR.username });
	console.log(`  created ${newLotId} (${QTY}); part count now ${newQ}`);

	console.log('\nAPPLIED. Lots now in the picker:');
	for (const l of await lots.find({ 'part.partNumber': PART, status: { $nin: ['rejected', 'returned'] } }).toArray() as any[]) {
		const rem = Number(l.quantity ?? 0) - await used(l.lotId);
		if (rem > 0) console.log(`  ${l.lotId}  remaining ${rem}`);
	}
	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
