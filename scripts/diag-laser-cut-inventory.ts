import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
const URI = process.env.MONGODB_URI!;

async function main() {
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;

	// 1) Current on-record PT-CT-112 inventory
	const part = await db.collection('part_definitions').findOne({ partNumber: 'PT-CT-112' });
	const currentCount = (part as any)?.inventoryCount ?? 0;
	console.log(`PT-CT-112 (${(part as any)?.name}) current inventoryCount: ${currentCount}`);

	// 2) Every LaserCutBatch ever recorded
	const batches = await db.collection('laser_cut_batches').find({}).sort({ createdAt: 1 }).toArray();
	console.log(`\nLaserCutBatch records: ${batches.length}`);
	let totalInputSheets = 0;
	let totalOutputSheets = 0;
	let totalFailures = 0;
	for (const b of batches as any[]) {
		totalInputSheets += b.inputSheetCount ?? 0;
		totalOutputSheets += b.outputSheetCount ?? 0;
		totalFailures += b.failureCount ?? 0;
		console.log(`  ${b.createdAt?.toISOString?.() ?? '?'}  input=${b.inputSheetCount ?? 0} output=${b.outputSheetCount ?? 0} fail=${b.failureCount ?? 0} lot=${b.outputLotId}  by=${b.operator?.username}`);
	}
	console.log(`\n  Totals: input=${totalInputSheets}  output=${totalOutputSheets}  failures=${totalFailures}`);

	// 3) All inventory_transactions for PT-CT-112 — sanity check the paper trail
	const partId = (part as any)?._id;
	const txns = await db.collection('inventory_transactions').find({ partDefinitionId: partId }).sort({ performedAt: 1 }).toArray();
	console.log(`\nInventoryTransactions for PT-CT-112: ${txns.length}`);
	let receiptsOrCreation = 0;
	let consumptionOrScrap = 0;
	for (const t of txns as any[]) {
		const sign = (t.transactionType === 'consumption' || t.transactionType === 'scrap') ? -1 : 1;
		const delta = sign * Math.abs(t.quantity ?? 0);
		if (sign === 1) receiptsOrCreation += Math.abs(t.quantity ?? 0);
		else consumptionOrScrap += Math.abs(t.quantity ?? 0);
		console.log(`  ${t.performedAt?.toISOString?.() ?? '?'}  ${t.transactionType}  qty=${t.quantity}  prev=${t.previousQuantity} → new=${t.newQuantity}  step=${t.manufacturingStep}  by=${t.performedBy}`);
	}
	console.log(`\n  Totals: credited=${receiptsOrCreation}  consumed/scrapped=${consumptionOrScrap}  net=${receiptsOrCreation - consumptionOrScrap}`);

	// 4) Reconciliation: what SHOULD be there if historical batches had used 16/sheet
	console.log(`\n=== Reconciliation ===`);
	console.log(`Credited historically (at 6/sheet): ${totalOutputSheets * 6}`);
	console.log(`If it had been credited at 16/sheet: ${totalOutputSheets * 16}`);
	console.log(`Difference (potential under-count)  : +${totalOutputSheets * (16 - 6)}`);
	console.log(`Current inventoryCount              : ${currentCount}`);
	console.log(`Net receipts from transactions      : ${receiptsOrCreation - consumptionOrScrap}`);

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
