import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const partDef = await db.collection('part_definitions').findOne({ partNumber: 'PT-CT-112' });
	const id = String(partDef?._id);
	console.log(`PT-CT-112 partDef._id=${id}, current inventoryCount=${partDef?.inventoryCount}`);
	console.log(`updatedAt=${(partDef as any)?.updatedAt?.toISOString?.()}\n`);

	// All audit_logs mentioning this id anywhere
	const audits = await db.collection('audit_logs').find({
		$or: [
			{ recordId: id },
			{ 'newData.partNumber': 'PT-CT-112' },
			{ 'newData._id': id }
		]
	}).sort({ changedAt: -1 }).limit(20).toArray();
	console.log(`audit_logs mentioning PT-CT-112 or its id (last 20):`);
	for (const a of audits as any[]) {
		console.log(`  ${a.changedAt?.toISOString?.()} ${a.action} ${a.tableName}/${a.recordId} by=${a.changedBy}`);
		if (a.newData) console.log(`    newData=${JSON.stringify(a.newData).slice(0, 300)}`);
		if (a.oldData) console.log(`    oldData=${JSON.stringify(a.oldData).slice(0, 200)}`);
	}
	console.log('');

	// All ReceivingLots since today midnight
	const todayStart = new Date();
	todayStart.setHours(0, 0, 0, 0);
	const todayLots = await db.collection('receiving_lots').find({ createdAt: { $gte: todayStart } }).toArray();
	console.log(`ReceivingLots created TODAY (across all parts): ${todayLots.length}`);
	for (const l of todayLots as any[]) {
		console.log(`  ${l._id} part=${l.part?.partNumber} qty=${l.quantity} lotId=${l.lotId} createdAt=${l.createdAt?.toISOString?.()}`);
	}
	console.log('');

	// All inventory_transactions with timestamp since today
	const todayTxs = await db.collection('inventory_transactions').find({ createdAt: { $gte: todayStart } }).sort({ createdAt: -1 }).limit(20).toArray();
	console.log(`inventory_transactions created TODAY (last 20):`);
	for (const t of todayTxs as any[]) {
		console.log(`  ${t.createdAt?.toISOString?.()} ${t.transactionType} part=${t.partNumber ?? t.partDefinitionId} qty=${t.quantity} by=${t.operatorUsername} step=${t.manufacturingStep}`);
	}

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
