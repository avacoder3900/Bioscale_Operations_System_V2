import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
const URI = process.env.MONGODB_URI!;

async function main() {
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;

	console.log('Collections:');
	const cols = await db.listCollections().toArray();
	for (const c of cols) if (/part|inven/i.test(c.name)) console.log(`  ${c.name}`);

	console.log('\nLooking up PT-CT-105 in part_definitions:');
	const a = await db.collection('part_definitions').findOne({ partNumber: 'PT-CT-105' });
	console.log(a);

	console.log('\nSample of part_definitions docs (first 3):');
	const s = await db.collection('part_definitions').find({}).limit(3).toArray();
	for (const p of s as any[]) console.log(`  _id=${p._id}  partNumber=${p.partNumber}  name=${p.name}  inv=${p.inventoryCount}`);

	console.log('\nSample of inventory_transactions for our run:');
	const tx = await db.collection('inventory_transactions').find({
		manufacturingRunId: '2y2fFrx6QdOaxhJMN78kt',
		manufacturingStep: 'wax_filling',
		transactionType: 'consumption'
	}).limit(3).toArray();
	for (const t of tx as any[]) console.log(`  _id=${t._id}  partDefinitionId=${t.partDefinitionId}  cartridgeRecordId=${t.cartridgeRecordId}  qty=${t.quantity}`);

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
