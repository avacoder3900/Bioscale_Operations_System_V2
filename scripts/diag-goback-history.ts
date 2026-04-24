/**
 * Has Go Back ever been invoked in production? If yes, every invocation
 * should have thrown (because InventoryTransaction.deleteMany is blocked),
 * which means there may be half-rewound wax runs on dev already — the
 * goBack audit entry wrote, WaxFillingRun/CartridgeRecord updates ran,
 * but the subsequent InventoryTransaction.deleteMany call threw mid-action.
 * That scenario needs cleanup beyond just fixing the code.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const audits = await db.collection('audit_logs').find({ action: 'GO_BACK' }).toArray() as any[];
	console.log(`GO_BACK audit entries in audit_logs: ${audits.length}`);
	for (const a of audits) {
		console.log(`  ${a._id}  at=${a.changedAt?.toISOString?.()}  by=${a.changedBy}  run=${a.recordId}  ${JSON.stringify(a.newData)}`);
	}

	// If any GO_BACK entries exist, check whether the related InventoryTransactions
	// are still live (meaning the delete threw after the audit wrote) — these are
	// candidates for retroactive retraction.
	if (audits.length > 0) {
		const runIds = audits.map((a) => a.recordId);
		const liveTxns = await db.collection('inventory_transactions').find({
			manufacturingRunId: { $in: runIds },
			manufacturingStep: 'wax_filling',
			transactionType: { $in: ['consumption', 'scrap'] },
			retractedAt: { $exists: false }
		}).project({ _id: 1, manufacturingRunId: 1, transactionType: 1, cartridgeRecordId: 1 }).toArray() as any[];
		console.log(`\nLive (non-retracted) wax_filling txns on those runs: ${liveTxns.length}`);
		if (liveTxns.length > 0) {
			console.log('  → These need retroactive retraction as part of S12 cleanup.');
		}
	}

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
