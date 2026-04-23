import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	const lotId = 'KnvhBjHKSC0jStX1rQw4s';
	const lot = await db.collection('lot_records').findOne({ _id: lotId });
	console.log('Lot doc:');
	console.log(JSON.stringify({
		_id: lot?._id, status: (lot as any)?.status, quantityProduced: (lot as any)?.quantityProduced,
		scrapCount: (lot as any)?.scrapCount, scrapDetail: (lot as any)?.scrapDetail,
		scrapReason: (lot as any)?.scrapReason,
		updatedAt: (lot as any)?.updatedAt, createdAt: (lot as any)?.createdAt,
		bucketBarcode: (lot as any)?.bucketBarcode, supersededBy: (lot as any)?.supersededBy,
		finishTime: (lot as any)?.finishTime
	}, null, 2));

	const allTxns = await db.collection('inventory_transactions').find({ manufacturingRunId: lotId }).sort({ performedAt: 1 }).toArray();
	console.log(`\n${allTxns.length} txns for this run:`);
	for (const t of allTxns as any[]) {
		console.log(`  ${t.performedAt?.toISOString?.()}  type=${t.transactionType}  step=${t.manufacturingStep}  part=${t.partDefinitionId}  qty=${t.quantity}  notes="${t.notes ?? ''}"`);
	}

	// All audit logs for this lot
	const audits = await db.collection('audit_logs').find({ tableName: 'lot_records', recordId: lotId }).sort({ changedAt: 1 }).toArray();
	console.log(`\n${audits.length} audit_log entries for this lot:`);
	for (const a of audits as any[]) {
		console.log(`  ${a.changedAt?.toISOString?.()}  ${a.action}  by=${a.changedBy}  newData=${JSON.stringify(a.newData)?.slice(0, 120)}`);
	}

	// All other Superseded lots in general
	const sup = await db.collection('lot_records').countDocuments({ status: 'Superseded' });
	console.log(`\nTotal Superseded lots in DB: ${sup}`);

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
