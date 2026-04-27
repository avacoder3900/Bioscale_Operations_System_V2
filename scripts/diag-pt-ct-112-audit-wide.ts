/**
 * Wider sweep — find ANY audit_log, inventory_transaction, receiving_lot,
 * or manufacturing_material_transaction touched today that could account
 * for the +256 bump on PT-CT-112.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	const partDef = await db.collection('part_definitions').findOne({ partNumber: 'PT-CT-112' });
	const partId = String(partDef?._id);
	console.log(`PT-CT-112 partDef._id=${partId}, current=${partDef?.inventoryCount}, updatedAt=${(partDef as any)?.updatedAt?.toISOString?.()}\n`);

	const todayStart = new Date();
	todayStart.setHours(0, 0, 0, 0);

	// 1. ALL audit_logs from today (any table)
	const audits = await db.collection('audit_logs').find({ changedAt: { $gte: todayStart } }).sort({ changedAt: -1 }).toArray();
	console.log(`=== ALL audit_logs from today (${audits.length}) ===`);
	for (const a of audits as any[]) {
		const json = JSON.stringify(a);
		const mentionsPart = json.includes('PT-CT-112') || json.includes(partId);
		console.log(`  ${a.changedAt?.toISOString?.()} ${a.action} ${a.tableName}/${a.recordId} by=${a.changedBy} ${mentionsPart ? '<-- MENTIONS PT-CT-112' : ''}`);
		if (mentionsPart) console.log(`    full: ${json.slice(0, 400)}`);
	}
	console.log('');

	// 2. ALL inventory_transactions from today
	const txs = await db.collection('inventory_transactions').find({ createdAt: { $gte: todayStart } }).sort({ createdAt: -1 }).toArray();
	console.log(`=== ALL inventory_transactions from today (${txs.length}) ===`);
	for (const t of txs as any[]) {
		console.log(`  ${t.createdAt?.toISOString?.()} ${t.transactionType} part=${t.partNumber ?? t.partDefinitionId} qty=${t.quantity}`);
	}
	console.log('');

	// 3. ALL receiving_lots from today
	const lots = await db.collection('receiving_lots').find({
		$or: [
			{ createdAt: { $gte: todayStart } },
			{ updatedAt: { $gte: todayStart } }
		]
	}).toArray();
	console.log(`=== ALL receiving_lots created OR updated today (${lots.length}) ===`);
	for (const l of lots as any[]) {
		console.log(`  ${l._id} part=${l.part?.partNumber} qty=${l.quantity} created=${l.createdAt?.toISOString?.()} updated=${l.updatedAt?.toISOString?.()}`);
	}
	console.log('');

	// 4. manufacturing_material_transactions today
	const mmtxs = await db.collection('manufacturing_material_transactions').find({ createdAt: { $gte: todayStart } }).toArray();
	console.log(`=== manufacturing_material_transactions today (${mmtxs.length}) ===`);
	for (const t of mmtxs as any[]) {
		console.log(`  ${t.createdAt?.toISOString?.()} ${t.transactionType} mat=${t.materialId} qty=${t.quantityChanged} by=${t.operatorId}`);
	}
	console.log('');

	// 5. Look for ANY collection with a doc updated/created today that mentions PT-CT-112
	console.log(`=== Sanity-check: PartDefinition itself ===`);
	const fullPart = partDef as any;
	console.log(`  inventoryCount=${fullPart?.inventoryCount}`);
	console.log(`  createdAt=${fullPart?.createdAt?.toISOString?.()}`);
	console.log(`  updatedAt=${fullPart?.updatedAt?.toISOString?.()}`);

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
