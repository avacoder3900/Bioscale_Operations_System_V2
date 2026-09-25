/**
 * BUCKET-SYSTEM_PLAN §2 rename — move the first bucket stage from `raw` to
 * `barcoded` in stored data. The code no longer writes `raw`; both enums still
 * accept it so pre-rename rows validate until this has run everywhere.
 *
 * Touches:
 *   bucket_cycles.stage          'raw' → 'barcoded'
 *   cartridge_records.status     'raw' → 'barcoded'
 *   bucket_transactions.fromStage/toStage
 *
 * Writes go through the raw driver: cartridge_records is sacred (middleware
 * blocks bulk status writes) and bucket_transactions is immutable, and this is
 * a rename of an existing value, not a state change — no AuditLog row per
 * cartridge, one summary row instead.
 *
 * Usage:
 *   npx tsx scripts/migrate-bucket-raw-to-barcoded.ts --plan
 *   npx tsx scripts/migrate-bucket-raw-to-barcoded.ts --apply
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
import { generateId } from '../src/lib/server/db/utils.js';

const MODE: 'plan' | 'apply' | null = (() => {
	if (process.argv.includes('--apply')) return 'apply';
	if (process.argv.includes('--plan')) return 'plan';
	return null;
})();
if (!MODE) { console.error('Usage: --plan or --apply'); process.exit(1); }

const OPERATOR = 'system-migrate-bucket-barcoded-2026-09-25';

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	const cycles = db.collection('bucket_cycles');
	const carts = db.collection('cartridge_records');
	const txs = db.collection('bucket_transactions');

	const cycleCount = await cycles.countDocuments({ stage: 'raw' });
	const cartCount = await carts.countDocuments({ status: 'raw' });
	const txFrom = await txs.countDocuments({ fromStage: 'raw' });
	const txTo = await txs.countDocuments({ toStage: 'raw' });

	console.log(`bucket_cycles.stage 'raw':        ${cycleCount}`);
	console.log(`cartridge_records.status 'raw':   ${cartCount}`);
	console.log(`bucket_transactions.fromStage:    ${txFrom}`);
	console.log(`bucket_transactions.toStage:      ${txTo}`);

	if (cycleCount) {
		const sample = await cycles.find({ stage: 'raw' }).project({ _id: 1, bucketId: 1, cycleNumber: 1, quantity: 1 }).limit(10).toArray();
		console.log('\nOpen passes that will move:');
		for (const c of sample) console.log(`  ${c.bucketId} pass #${c.cycleNumber} — ${c.quantity} carts (${c._id})`);
		if (cycleCount > sample.length) console.log(`  … and ${cycleCount - sample.length} more`);
	}

	if (MODE === 'plan') {
		console.log('\n--plan: nothing written.');
		await mongoose.disconnect();
		return;
	}

	const r1 = await cycles.updateMany({ stage: 'raw' }, { $set: { stage: 'barcoded' } });
	const r2 = await carts.updateMany({ status: 'raw' }, { $set: { status: 'barcoded' } });
	const r3 = await txs.updateMany({ fromStage: 'raw' }, { $set: { fromStage: 'barcoded' } });
	const r4 = await txs.updateMany({ toStage: 'raw' }, { $set: { toStage: 'barcoded' } });

	console.log(`\nbucket_cycles       modified: ${r1.modifiedCount}`);
	console.log(`cartridge_records   modified: ${r2.modifiedCount}`);
	console.log(`bucket_transactions from:     ${r3.modifiedCount}`);
	console.log(`bucket_transactions to:       ${r4.modifiedCount}`);

	await db.collection('audit_logs').insertOne({
		_id: generateId(),
		action: 'UPDATE',
		resourceType: 'bucket_cycles',
		resourceId: 'MIGRATION',
		userId: OPERATOR,
		username: OPERATOR,
		timestamp: new Date(),
		details: {
			migration: 'bucket stage raw → barcoded (BUCKET-SYSTEM_PLAN §2)',
			bucketCycles: r1.modifiedCount,
			cartridgeRecords: r2.modifiedCount,
			bucketTransactionsFrom: r3.modifiedCount,
			bucketTransactionsTo: r4.modifiedCount
		}
	});

	const leftCycles = await cycles.countDocuments({ stage: 'raw' });
	const leftCarts = await carts.countDocuments({ status: 'raw' });
	console.log(`\nLeft at 'raw' — cycles: ${leftCycles}, carts: ${leftCarts} (expect 0 / 0).`);

	await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
