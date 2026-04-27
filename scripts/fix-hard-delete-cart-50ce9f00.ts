/**
 * Hard-delete cartridge 50ce9f00-bff6-42d3-ad14-b8540f4e5d9a and all data tied
 * to its barcode. Physical cart is going in the trash (duplicate barcode or
 * ghost reagent run — indistinguishable from DB alone, but operator confirms
 * the physical cart in hand was never reagent-filled).
 *
 * Does NOT refund consumed inventory (PartDefinition.inventoryCount,
 * BackingLot.cartridgeCount) — operator instruction.
 *
 * Leaves ONE audit_logs row documenting the hard-delete so the trail of
 * deletion itself is preserved.
 *
 * Uses raw driver to bypass sacred + immutable middleware.
 */
import mongoose from 'mongoose';
import { nanoid } from 'nanoid';
import * as dotenv from 'dotenv';
dotenv.config();

const CID = '50ce9f00-bff6-42d3-ad14-b8540f4e5d9a';
const REAGENT_RUN = 'vn8DqR4BpOyrWeo1lZ_xR';
const WAX_RUN = '2y2fFrx6QdOaxhJMN78kt';

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const now = new Date();

	console.log('=== BEFORE ===');
	const pre = {
		cart: await db.collection('cartridge_records').countDocuments({ _id: CID } as any),
		reagentRun: await db.collection('reagent_batch_records').countDocuments({ _id: REAGENT_RUN } as any),
		invTxns: await db.collection('inventory_transactions').countDocuments({ cartridgeRecordId: CID }),
		inWaxRun: await db.collection('wax_filling_runs').countDocuments({ _id: WAX_RUN, cartridgeIds: CID } as any),
		auditRows: await db.collection('audit_logs').countDocuments({ recordId: CID })
	};
	console.log(`  cartridge_records: ${pre.cart}`);
	console.log(`  reagent_batch_records (vn8D): ${pre.reagentRun}`);
	console.log(`  inventory_transactions: ${pre.invTxns}`);
	console.log(`  wax_filling_run (2y2f) contains cart: ${pre.inWaxRun ? 'yes' : 'no'}`);
	console.log(`  audit_logs rows for cart: ${pre.auditRows}`);

	// Capture a snapshot of the cart's content BEFORE delete so we can embed
	// it in the HARD_DELETE audit row.
	const cartSnap = await db.collection('cartridge_records').findOne({ _id: CID } as any);
	const reagentRunSnap = await db.collection('reagent_batch_records').findOne({ _id: REAGENT_RUN } as any);
	const invTxnsSnap = await db.collection('inventory_transactions').find({ cartridgeRecordId: CID }).toArray();

	console.log('\n=== DELETING ===');

	// 1. Inventory transactions — hard delete (bypass immutable middleware via raw driver)
	const invRes = await db.collection('inventory_transactions').deleteMany({ cartridgeRecordId: CID });
	console.log(`  inventory_transactions deleted: ${invRes.deletedCount}`);

	// 2. Reagent batch record (single-cart ghost run) — hard delete
	const reagentRes = await db.collection('reagent_batch_records').deleteOne({ _id: REAGENT_RUN } as any);
	console.log(`  reagent_batch_records deleted: ${reagentRes.deletedCount}`);

	// 3. Pull cartridge from the wax run's cartridgeIds (keep the run itself — 23 siblings)
	const waxPullRes = await db.collection('wax_filling_runs').updateOne(
		{ _id: WAX_RUN } as any,
		{ $pull: { cartridgeIds: CID } as any }
	);
	console.log(`  wax_filling_runs.cartridgeIds pulled: matched=${waxPullRes.matchedCount} modified=${waxPullRes.modifiedCount}`);

	// 4. Cartridge record — hard delete (bypass sacred middleware via raw driver)
	const cartRes = await db.collection('cartridge_records').deleteOne({ _id: CID } as any);
	console.log(`  cartridge_records deleted: ${cartRes.deletedCount}`);

	// 5. Audit-trail breadcrumb — one row documenting WHAT got hard-deleted.
	// Raw driver insert so sacred middleware on AuditLog (if any) doesn't
	// interfere. AuditLog is immutable-append, but insert is allowed.
	const auditId = nanoid();
	await db.collection('audit_logs').insertOne({
		_id: auditId,
		tableName: 'cartridge_records',
		recordId: CID,
		action: 'HARD_DELETE',
		changedBy: 'jacobq@brevitest.com',
		changedAt: now,
		createdAt: now,
		reason: 'Physical cart identified as duplicate-barcode or ghost reagent run (reagent_batch_records.vn8DqR4BpOyrWeo1lZ_xR was a 6-second OT-2 cycle, single cartridge, no AuditLog trail). Physical cart thrown away. Consumed inventory NOT refunded per operator instruction.',
		newData: {
			deletedAt: now,
			deletedCollections: {
				cartridge_records: 1,
				reagent_batch_records: reagentRes.deletedCount,
				inventory_transactions: invRes.deletedCount,
				wax_filling_runs_cartridgeIds_pulled: waxPullRes.modifiedCount
			},
			inventoryRefundsSkipped: {
				backingLot_5522a72c: 'cartridgeCount left at 19 (not incremented by +1)',
				topSealPart_Mb28ve8fWodyJdoZ_zSNr: 'inventoryCount left decremented',
				note: 'Operator instruction: cartridge going to trash, treat consumption as real.'
			},
			preDeleteSnapshot: {
				cartridge: cartSnap,
				reagentRun: reagentRunSnap,
				inventoryTxns: invTxnsSnap
			}
		}
	});
	console.log(`  audit_logs HARD_DELETE row inserted: ${auditId}`);

	console.log('\n=== AFTER ===');
	const post = {
		cart: await db.collection('cartridge_records').countDocuments({ _id: CID } as any),
		reagentRun: await db.collection('reagent_batch_records').countDocuments({ _id: REAGENT_RUN } as any),
		invTxns: await db.collection('inventory_transactions').countDocuments({ cartridgeRecordId: CID }),
		inWaxRun: await db.collection('wax_filling_runs').countDocuments({ _id: WAX_RUN, cartridgeIds: CID } as any),
		auditRows: await db.collection('audit_logs').countDocuments({ recordId: CID })
	};
	console.log(`  cartridge_records: ${post.cart}  (expect 0)`);
	console.log(`  reagent_batch_records (vn8D): ${post.reagentRun}  (expect 0)`);
	console.log(`  inventory_transactions: ${post.invTxns}  (expect 0)`);
	console.log(`  wax_filling_run (2y2f) contains cart: ${post.inWaxRun ? 'yes' : 'no'}  (expect no)`);
	console.log(`  audit_logs rows for cart: ${post.auditRows}  (expect 1 — the HARD_DELETE row)`);

	const ok = post.cart === 0 && post.reagentRun === 0 && post.invTxns === 0 && post.inWaxRun === 0 && post.auditRows === 1;
	console.log(`\n${ok ? '✓ clean' : '✗ check above counts'}`);

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
