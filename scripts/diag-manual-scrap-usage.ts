import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	// The qa-qc scrapCartridge action writes manufacturingStep='scrap' and a
	// notes prefix "QC scrap:". Find any txn matching that signature.
	const hits = await db.collection('inventory_transactions').find({
		transactionType: 'scrap',
		$or: [
			{ manufacturingStep: 'scrap' },
			{ notes: /^QC scrap:/ }
		]
	}).toArray();
	console.log(`Manual scrapCartridge txns ever emitted: ${hits.length}`);
	for (const t of hits as any[]) {
		console.log(`  ${t._id}  at=${t.performedAt?.toISOString?.()}  cartridge=${t.cartridgeRecordId}  by=${t.operatorUsername}  category=${t.scrapCategory}  notes="${t.notes}"`);
	}

	// Audit logs with reason prefix "QC scrap:"
	const audits = await db.collection('audit_logs').find({ reason: /^QC scrap:/ }).toArray();
	console.log(`\nAudit log entries from scrapCartridge action: ${audits.length}`);

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
