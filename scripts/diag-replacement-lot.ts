import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const REPLACEMENT = '5C7FRF9CX44gpdslMViOr';
	const lot = await db.collection('lot_records').findOne({ _id: REPLACEMENT });
	console.log('Replacement lot:');
	console.log(JSON.stringify({
		_id: lot?._id, status: (lot as any)?.status, quantityProduced: (lot as any)?.quantityProduced,
		scrapCount: (lot as any)?.scrapCount, scrapDetail: (lot as any)?.scrapDetail,
		createdAt: (lot as any)?.createdAt, finishTime: (lot as any)?.finishTime,
		bucketBarcode: (lot as any)?.bucketBarcode
	}, null, 2));
	const txns = await db.collection('inventory_transactions').find({ manufacturingRunId: REPLACEMENT }).sort({ performedAt: 1 }).toArray();
	console.log(`\n${txns.length} txns on replacement lot:`);
	for (const t of txns as any[]) {
		console.log(`  ${t.performedAt?.toISOString?.()}  type=${t.transactionType}  part=${t.partDefinitionId}  qty=${t.quantity}  retracted=${!!t.retractedAt}`);
	}
	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
