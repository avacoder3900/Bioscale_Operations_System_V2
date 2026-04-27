import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const partDef = await db.collection('part_definitions').findOne({ partNumber: 'PT-CT-112' });
	console.log(`Current PT-CT-112 inventoryCount=${partDef?.inventoryCount}\n`);

	const lots = await db.collection('receiving_lots').find({ 'part._id': partDef?._id }).sort({ createdAt: -1 }).limit(10).toArray();
	console.log(`Recent receiving_lots for PT-CT-112 (top 10):`);
	for (const l of lots as any[]) {
		console.log(`  ${l._id} qty=${l.quantity} lotId=${l.lotId} createdAt=${l.createdAt?.toISOString?.()} updatedAt=${l.updatedAt?.toISOString?.()}`);
	}
	console.log('');

	const txs = await db.collection('inventory_transactions').find({ partDefinitionId: partDef?._id }).sort({ createdAt: -1 }).limit(30).toArray();
	console.log(`Last 30 inventory_transactions for PT-CT-112:`);
	for (const t of txs as any[]) {
		console.log(`  ${t.createdAt?.toISOString?.()}  ${t.transactionType}  qty=${t.quantity}  by=${t.operatorUsername}  step=${t.manufacturingStep}`);
	}
	console.log('');

	const auditLogs = await db.collection('audit_logs').find({
		$or: [
			{ tableName: 'part_definitions', recordId: partDef?._id },
			{ tableName: 'receiving_lots', 'newData.part._id': partDef?._id }
		]
	}).sort({ changedAt: -1 }).limit(10).toArray();
	console.log(`Recent audit_logs touching PT-CT-112:`);
	for (const a of auditLogs as any[]) {
		console.log(`  ${a.changedAt?.toISOString?.()} ${a.action} ${a.tableName}/${a.recordId} by=${a.changedBy}`);
		if (a.newData) console.log(`    newData=${JSON.stringify(a.newData).slice(0, 200)}`);
	}

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
