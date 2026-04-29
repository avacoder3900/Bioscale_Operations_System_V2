/**
 * Retract the 4 duplicate InventoryTransaction records on the Superseded lot
 * KnvhBjHKSC0jStX1rQw4s (WI-01 2026-04-13, duplicate confirmComplete submission).
 *
 * Leaves the originals intact. For each duplicate:
 *   - sets retractedBy / retractedAt / retractionReason on the original txn doc
 *     (direct collection write, since InventoryTransaction has immutable middleware)
 *   - writes an 'adjustment' txn that ADDS the duplicated quantity back to
 *     PartDefinition.inventoryCount to restore the correct on-hand count.
 *
 * The 4 duplicates are identified by performedAt >= the second-submit boundary
 * (2026-04-13T21:18:12.685Z, which is 1.56s after the first submission started).
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const LOT_ID = 'KnvhBjHKSC0jStX1rQw4s';
const BOUNDARY = new Date('2026-04-13T21:18:12.500Z'); // before the 2nd submit, after the 1st's 4 txns

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const txns = db.collection('inventory_transactions');
	const parts = db.collection('part_definitions');

	const all = await txns.find({ manufacturingRunId: LOT_ID }).sort({ performedAt: 1 }).toArray();
	console.log(`Total txns on lot ${LOT_ID}: ${all.length}`);
	const dupes = all.filter((t: any) => new Date(t.performedAt) > BOUNDARY);
	console.log(`Duplicates to retract: ${dupes.length}`);
	for (const t of dupes as any[]) {
		console.log(`  ${t._id}  ${t.performedAt.toISOString()}  type=${t.transactionType}  part=${t.partDefinitionId}  qty=${t.quantity}`);
	}
	if (dupes.length !== 4) {
		console.log('Unexpected number of duplicates — aborting for safety.');
		await mongoose.disconnect();
		process.exit(1);
	}

	// Check any were already retracted
	const alreadyRetracted = dupes.filter((t: any) => t.retractedAt);
	if (alreadyRetracted.length > 0) {
		console.log(`\n${alreadyRetracted.length} already retracted — skipping those:`);
		for (const t of alreadyRetracted as any[]) console.log(`  ${t._id}`);
	}
	const toRetract = dupes.filter((t: any) => !t.retractedAt);

	const now = new Date();
	const RETRACTOR = 'system-audit-2026-04-23';
	const REASON = `Duplicate submission of WI-01 confirmComplete for lot ${LOT_ID}; lot was superseded by 5C7FRF9CX44gpdslMViOr. See audit-scrap-tracking follow-up.`;

	// 1) Mark originals retracted (direct collection update to bypass immutable middleware)
	for (const t of toRetract as any[]) {
		await txns.updateOne(
			{ _id: t._id },
			{ $set: { retractedBy: RETRACTOR, retractedAt: now, retractionReason: REASON } }
		);
		console.log(`  marked retracted: ${t._id}`);
	}

	// 2) Emit adjustment txns that add quantity back to inventoryCount per part.
	//    For consumption/scrap the original subtracted Math.abs(quantity); to
	//    reverse, we add the same absolute quantity with type='adjustment' and
	//    positive quantity (the adjustment branch does inventoryCount += quantity).
	const { InventoryTransaction, PartDefinition } = await import('../src/lib/server/db/models/index.js');
	// We bypass the service helper to write a precise reversing txn with custom notes.
	for (const t of toRetract as any[]) {
		if (!t.partDefinitionId) continue; // nothing to reverse
		const part = await parts.findOne({ _id: t.partDefinitionId });
		const prev = (part as any)?.inventoryCount ?? 0;
		const amount = Math.abs(t.quantity);
		const next = prev + amount;
		await parts.updateOne({ _id: t.partDefinitionId }, { $set: { inventoryCount: next } });

		const adjId = new mongoose.Types.ObjectId().toString(); // just unique — generateId is nanoid but any unique string is fine here
		await txns.insertOne({
			_id: adjId,
			transactionType: 'adjustment',
			partDefinitionId: t.partDefinitionId,
			quantity: amount,
			previousQuantity: prev,
			newQuantity: next,
			manufacturingStep: t.manufacturingStep,
			manufacturingRunId: LOT_ID,
			operatorId: RETRACTOR,
			operatorUsername: RETRACTOR,
			performedBy: RETRACTOR,
			performedAt: now,
			notes: `Reversing duplicate ${t.transactionType} txn ${t._id} on superseded lot ${LOT_ID}`,
			reason: `Reversing duplicate ${t.transactionType} txn ${t._id}`
		});
		console.log(`  adjustment txn ${adjId}: part ${t.partDefinitionId} inventoryCount ${prev} -> ${next} (+${amount})`);
	}

	// 3) Also write audit_log entry for the fix
	await db.collection('audit_logs').insertOne({
		_id: new mongoose.Types.ObjectId().toString(),
		tableName: 'inventory_transactions',
		recordId: LOT_ID,
		action: 'RETRACT',
		changedBy: RETRACTOR,
		changedAt: now,
		newData: {
			reason: REASON,
			retractedTxnIds: toRetract.map((t: any) => t._id),
			superseded_lot: LOT_ID,
			supersedes: '5C7FRF9CX44gpdslMViOr'
		}
	});
	console.log('\nAudit log entry written.');

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
