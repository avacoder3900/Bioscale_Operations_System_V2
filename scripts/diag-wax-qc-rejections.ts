import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
const URI = process.env.MONGODB_URI!;

const RUN_ID = '2y2fFrx6QdOaxhJMN78kt';

async function main() {
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;

	const run = await db.collection('wax_filling_runs').findOne({ _id: RUN_ID as any });
	const cartIds: string[] = (run as any)?.cartridgeIds ?? [];

	console.log(`Run status=${(run as any)?.status}  runEndTime=${(run as any)?.runEndTime}  coolingConfirmed=${(run as any)?.coolingConfirmedTime}\n`);

	const carts = await db.collection('cartridge_records').find(
		{ _id: { $in: cartIds } },
		{ projection: {
			_id: 1, status: 1, waxQc: 1, voidedAt: 1, voidReason: 1,
			'waxFilling.recordedAt': 1, 'waxFilling.deckPosition': 1,
			'waxStorage.timestamp': 1, updatedAt: 1
		} }
	).sort({ 'waxFilling.deckPosition': 1 }).toArray();

	console.log('deck#  cartId[:8]         status      qc.status  qc.ts(ms since epoch)  stored.ts(ms)  voidReason');
	for (const c of carts as any[]) {
		const qcTs = c.waxQc?.timestamp ? new Date(c.waxQc.timestamp).getTime() : 0;
		const storedTs = c.waxStorage?.timestamp ? new Date(c.waxStorage.timestamp).getTime() : 0;
		console.log(
			`${String(c.waxFilling?.deckPosition ?? '?').padStart(5)}  ` +
			`${String(c._id).slice(0, 8)}  ` +
			`${String(c.status ?? '-').padEnd(12)}` +
			`${String(c.waxQc?.status ?? '-').padEnd(11)}` +
			`${qcTs || '-'}`.padEnd(22) +
			`${storedTs || '-'}`.padEnd(16) +
			`${c.voidReason ?? ''}`
		);
	}

	// Audit log entries for this run
	console.log('\n=== AuditLog entries referencing this run ===');
	const audits = await db.collection('audit_logs').find(
		{ $or: [{ recordId: RUN_ID }, { 'newData.runId': RUN_ID }] }
	).sort({ changedAt: 1 }).toArray();
	for (const a of audits as any[]) {
		console.log(`${new Date(a.changedAt).toISOString()}  ${a.tableName}  ${a.action}  by=${a.changedBy}  newData=${JSON.stringify(a.newData)?.slice(0, 200)}`);
	}

	// Audit log entries referencing any of the cartridge ids
	console.log('\n=== AuditLog entries referencing any cartridge id (first 40) ===');
	const cartAudits = await db.collection('audit_logs').find(
		{ $or: [{ recordId: { $in: cartIds } }, { 'newData.cartridgeId': { $in: cartIds } }] }
	).sort({ changedAt: 1 }).limit(40).toArray();
	for (const a of cartAudits as any[]) {
		console.log(`${new Date(a.changedAt).toISOString()}  ${a.tableName}  ${a.action}  recordId=${a.recordId}  by=${a.changedBy}  newData=${JSON.stringify(a.newData)?.slice(0, 200)}`);
	}

	// Any scrap-category inventory_transactions for these cartridges
	console.log('\n=== inventory_transactions (scrap type) for these cartridges ===');
	const scrapTx = await db.collection('inventory_transactions').find({
		cartridgeRecordId: { $in: cartIds },
		transactionType: 'scrap'
	}).sort({ performedAt: 1 }).toArray();
	for (const t of scrapTx as any[]) {
		console.log(`${new Date(t.performedAt).toISOString()}  cart=${t.cartridgeRecordId}  step=${t.manufacturingStep}  by=${t.performedBy}  scrapReason=${t.scrapReason}  cat=${t.scrapCategory}`);
	}
	console.log(`\nTotal scrap tx: ${scrapTx.length}`);

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
