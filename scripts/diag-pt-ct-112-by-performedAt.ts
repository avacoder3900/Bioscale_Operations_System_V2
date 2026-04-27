/**
 * Re-query PT-CT-112 transactions using performedAt (the explicit timestamp
 * recordTransaction() writes) instead of createdAt. The recordTransaction
 * service explicitly sets performedAt:now but doesn't set createdAt — so
 * any transactions written via that service are invisible to a createdAt
 * filter.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	const partDef = await db.collection('part_definitions').findOne({ partNumber: 'PT-CT-112' });
	const partId = String(partDef?._id);
	const todayStart = new Date();
	todayStart.setHours(0, 0, 0, 0);

	console.log(`PT-CT-112 partId=${partId}, current=${partDef?.inventoryCount}\n`);

	// All transactions touching PT-CT-112 today, by performedAt
	const txs = await db.collection('inventory_transactions').find({
		partDefinitionId: partId,
		performedAt: { $gte: todayStart }
	}).sort({ performedAt: 1 }).toArray();

	console.log(`PT-CT-112 transactions today by performedAt (${txs.length}):`);
	for (const t of txs as any[]) {
		console.log(`  ${t.performedAt?.toISOString?.()} ${t.transactionType} qty=${t.quantity} prev=${t.previousQuantity} new=${t.newQuantity} step=${t.manufacturingStep} by=${t.operatorUsername ?? t.performedBy}`);
		console.log(`    notes=${t.notes?.slice(0, 130)}`);
	}
	console.log('');

	// Also: laser_cut step transactions today (any part), to see what laser-cut runs happened
	const laserToday = await db.collection('inventory_transactions').find({
		manufacturingStep: 'laser_cut',
		performedAt: { $gte: todayStart }
	}).sort({ performedAt: 1 }).toArray();
	console.log(`All 'laser_cut' step transactions today (${laserToday.length}):`);
	for (const t of laserToday as any[]) {
		console.log(`  ${t.performedAt?.toISOString?.()} ${t.transactionType} qty=${t.quantity} part=${t.partDefinitionId} step=${t.manufacturingStep} by=${t.operatorUsername} runId=${t.manufacturingRunId}`);
	}
	console.log('');

	// laser_cut_batches collection
	const batches = await db.collection('laser_cut_batches').find({
		$or: [
			{ createdAt: { $gte: todayStart } },
			{ updatedAt: { $gte: todayStart } },
			{ performedAt: { $gte: todayStart } }
		]
	}).toArray();
	console.log(`laser_cut_batches today (${batches.length}):`);
	for (const b of batches as any[]) {
		console.log(`  ${b._id} outputLotId=${b.outputLotId} input=${b.inputSheetCount} output=${b.outputSheetCount} by=${b.operatorId ?? b.operator?.username} createdAt=${b.createdAt?.toISOString?.()}`);
	}
	console.log('');

	// thermoseal_cutting_runs today (the cut-thermoseal step)
	const cuts = await db.collection('thermoseal_cutting_runs').find({
		$or: [
			{ createdAt: { $gte: todayStart } },
			{ updatedAt: { $gte: todayStart } }
		]
	}).toArray();
	console.log(`thermoseal_cutting_runs today (${cuts.length}):`);
	for (const c of cuts as any[]) {
		console.log(`  ${c._id} lotBarcode=${c.lotBarcode} expected=${c.expectedSheets} accepted=${c.acceptedCount} createdAt=${c.createdAt?.toISOString?.()} by=${c.operator?.username}`);
	}
	console.log('');

	// audit_logs today re-checked
	const audits = await db.collection('audit_logs').find({
		changedAt: { $gte: todayStart },
		$or: [
			{ tableName: 'laser_cut_batches' },
			{ tableName: 'thermoseal_cutting_runs' }
		]
	}).sort({ changedAt: 1 }).toArray();
	console.log(`audit_logs for laser/cut tables today (${audits.length}):`);
	for (const a of audits as any[]) {
		console.log(`  ${a.changedAt?.toISOString?.()} ${a.action} ${a.tableName}/${a.recordId} by=${a.changedBy}`);
	}

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
