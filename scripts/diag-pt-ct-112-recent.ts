/**
 * Trace recent inventory_transactions for PT-CT-112 to confirm a receiving
 * lot was added between the reconciliation and now.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	const partDef = await db.collection('part_definitions').findOne({ partNumber: 'PT-CT-112' });
	console.log(`PT-CT-112 partDefinitionId=${partDef?._id}  current inventoryCount=${partDef?.inventoryCount}\n`);

	const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
	const txs = await db
		.collection('inventory_transactions')
		.find({
			partDefinitionId: partDef?._id,
			createdAt: { $gte: since }
		})
		.sort({ createdAt: 1 })
		.toArray();

	console.log(`Last 24h transactions for PT-CT-112 (${txs.length} total):\n`);
	let running = (partDef?.inventoryCount ?? 0);
	// Walk backwards from the current value applying inverse signs to compute pre-state
	const reverseRunning: number[] = [];
	for (let i = txs.length - 1; i >= 0; i--) {
		const t: any = txs[i];
		reverseRunning.unshift(running);
		// consumption / scrap subtract; receiving / creation add
		if (t.transactionType === 'consumption' || t.transactionType === 'scrap') running += t.quantity;
		else if (t.transactionType === 'receiving' || t.transactionType === 'creation' || t.transactionType === 'restock') running -= t.quantity;
	}
	for (let i = 0; i < txs.length; i++) {
		const t: any = txs[i];
		console.log(`  ${t.createdAt?.toISOString?.()}  type=${t.transactionType}  qty=${t.quantity}  step=${t.manufacturingStep}  by=${t.operatorUsername}`);
		console.log(`    notes=${t.notes?.slice(0, 130)}`);
		console.log(`    inventoryCount AFTER this tx ≈ ${reverseRunning[i]}`);
		console.log('');
	}

	// Also list ReceivingLots created today for PT-CT-112
	console.log('Recent ReceivingLots for PT-CT-112 (last 24h):\n');
	const receivingLots = await db
		.collection('receiving_lots')
		.find({
			'part._id': partDef?._id,
			createdAt: { $gte: since }
		})
		.sort({ createdAt: -1 })
		.toArray();
	for (const rl of receivingLots) {
		const r: any = rl;
		console.log(`  ${r._id}  qty=${r.quantity}  lotId=${r.lotId}  createdAt=${r.createdAt?.toISOString?.()}`);
	}

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
