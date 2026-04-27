/**
 * Verify the inventory deduction from the 34-cartridge reconciliation.
 * Re-reads part_definitions + the inventory_transactions written by the
 * reconciliation script and checks the math.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const LOT_ID = '7a1cdd32-d86c-40f2-97f7-fc84e0298a04';
const PARTS = [
	{ partNumber: 'PT-CT-104', name: 'Cartridge', expectedAfter: 399 },
	{ partNumber: 'PT-CT-112', name: 'Thermoseal Laser Cut Sheet', expectedAfter: -22 },
	{ partNumber: 'PT-CT-106', name: 'Barcode', expectedAfter: 297 }
];

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	console.log('=== 1. Current part_definitions inventoryCount ===\n');
	for (const p of PARTS) {
		const pd = await db.collection('part_definitions').findOne({ partNumber: p.partNumber });
		const actual = pd?.inventoryCount;
		const ok = actual === p.expectedAfter;
		console.log(`  ${p.partNumber} (${p.name}): inventoryCount=${actual}  expected=${p.expectedAfter}  ${ok ? '✓' : '✗ MISMATCH'}`);
	}
	console.log('');

	console.log('=== 2. Reconciliation transactions written by the fix script ===\n');
	const txs = await db
		.collection('inventory_transactions')
		.find({
			manufacturingRunId: LOT_ID,
			manufacturingStep: 'backing',
			operatorUsername: 'system-reconciliation'
		})
		.sort({ createdAt: -1 })
		.toArray();

	if (txs.length === 0) {
		console.log('  No reconciliation transactions found. Did the fix script run with --apply?');
	}
	for (const tx of txs) {
		console.log(`  tx _id=${tx._id}`);
		console.log(`    type=${tx.transactionType}  partNumber=${tx.partNumber}  qty=${tx.quantity}`);
		console.log(`    partDefinitionId=${tx.partDefinitionId}  step=${tx.manufacturingStep}`);
		console.log(`    createdAt=${tx.createdAt}`);
		console.log(`    notes=${tx.notes?.slice(0, 100)}...`);
		console.log('');
	}

	console.log('=== 3. AuditLog RECONCILE entry ===\n');
	const audit = await db
		.collection('audit_logs')
		.find({ tableName: 'backing_lots', recordId: LOT_ID, action: 'RECONCILE' })
		.sort({ changedAt: -1 })
		.toArray();
	for (const a of audit) {
		console.log(`  audit _id=${a._id}`);
		console.log(`    changedBy=${a.changedBy}  changedAt=${a.changedAt}`);
		console.log(`    newData=${JSON.stringify(a.newData)}`);
		console.log(`    reason=${a.reason?.slice(0, 100)}...`);
		console.log('');
	}

	console.log('=== 4. BackingLot final state ===\n');
	const lot = await db.collection('backing_lots').findOne({ _id: LOT_ID });
	console.log(`  cartridgeCount=${lot?.cartridgeCount}  status=${lot?.status}`);
	console.log('');

	console.log('=== 5. Math check: were exactly 34 units deducted from each part? ===\n');
	let allGood = true;
	for (const p of PARTS) {
		const tx = txs.find((t: any) => t.partNumber === p.partNumber);
		if (!tx) {
			console.log(`  ${p.partNumber}: ✗ no reconciliation transaction found`);
			allGood = false;
			continue;
		}
		const qtyOk = tx.quantity === 34;
		const typeOk = tx.transactionType === 'consumption';
		console.log(`  ${p.partNumber}: tx qty=${tx.quantity} (expected 34) ${qtyOk ? '✓' : '✗'}  type=${tx.transactionType} ${typeOk ? '✓' : '✗'}`);
		if (!qtyOk || !typeOk) allGood = false;
	}
	console.log('');
	console.log(allGood ? 'ALL CHECKS PASS ✓' : 'CHECKS FAILED ✗');

	await mongoose.disconnect();
}
main().catch((e) => {
	console.error(e);
	process.exit(1);
});
