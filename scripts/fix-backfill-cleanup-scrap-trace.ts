/**
 * Backfill AuditLog + InventoryTransaction(type='scrap') rows for the 90
 * cleanup-scrapped cartridges voided on 2026-04-22 via one-off cleanup scripts.
 *
 * These bypassed the normal scrap path, leaving an ISO 13485 traceability gap:
 *   - 0 audit_log entries for the cartridge_records mutation
 *   - 0 InventoryTransaction(type='scrap') records for the cartridge
 *
 * Source reasons (voidReason):
 *   83x "Orphan backing cleanup — no active oven lot for this cartridge (abandoned/test data)"
 *    7x "Scrapped post-fill queue cleanup — operator request 2026-04-22"
 *
 * Backfill does NOT touch PartDefinition.inventoryCount — the cartridges were
 * already counted against inventory at WI-01 backing consumption when they
 * came into existence. The scrap txn is traceability-only (no partDefinitionId).
 *
 * Idempotent: skips cartridges that already have a backfilled txn or audit row.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
import { generateId } from '../src/lib/server/db/utils.js';

const CLEANUP_REASONS = [
	'Orphan backing cleanup — no active oven lot for this cartridge (abandoned/test data)',
	'Scrapped post-fill queue cleanup — operator request 2026-04-22'
];

// Each cleanup reason maps to the manufacturingStep the cartridge was at when
// scrapped (used by the inventory-transaction manufacturingStep field).
function stepForReason(reason: string): 'backing' | 'wax_filling' {
	if (reason.startsWith('Orphan backing cleanup')) return 'backing';
	return 'wax_filling'; // post-fill queue cleanup
}

function categoryForReason(_: string): 'other' {
	return 'other';
}

const BACKFILL_USER = 'system-audit-backfill-2026-04-23';

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const carts = db.collection('cartridge_records');
	const txns = db.collection('inventory_transactions');
	const audits = db.collection('audit_logs');

	const cleanupCarts = await carts.find({
		status: 'scrapped',
		voidReason: { $in: CLEANUP_REASONS }
	}).toArray();
	console.log(`Cleanup cartridges found: ${cleanupCarts.length}`);

	let newTxns = 0, newAudits = 0, skippedTxn = 0, skippedAudit = 0;
	for (const c of cleanupCarts as any[]) {
		const voidedAt = c.voidedAt ? new Date(c.voidedAt) : new Date();
		const reason: string = c.voidReason;

		// (1) InventoryTransaction — skip if one already exists for this cartridge
		const existingTxn = await txns.findOne({
			transactionType: 'scrap',
			cartridgeRecordId: c._id
		});
		if (existingTxn) {
			skippedTxn++;
		} else {
			await txns.insertOne({
				_id: generateId(),
				transactionType: 'scrap',
				cartridgeRecordId: c._id,
				quantity: 1,
				manufacturingStep: stepForReason(reason),
				manufacturingRunId: undefined,
				operatorId: BACKFILL_USER,
				operatorUsername: BACKFILL_USER,
				performedBy: BACKFILL_USER,
				performedAt: voidedAt,
				notes: `Backfilled traceability for cleanup-script scrap: ${reason}`,
				reason: reason,
				scrapReason: reason,
				scrapCategory: categoryForReason(reason)
			});
			newTxns++;
		}

		// (2) AuditLog for the scrap action — skip if any audit row already exists
		const existingAudit = await audits.findOne({
			tableName: 'cartridge_records',
			recordId: c._id,
			action: { $in: ['UPDATE', 'SCRAP'] }
		});
		if (existingAudit) {
			skippedAudit++;
		} else {
			await audits.insertOne({
				_id: generateId(),
				tableName: 'cartridge_records',
				recordId: c._id,
				action: 'UPDATE',
				changedBy: BACKFILL_USER,
				changedAt: voidedAt,
				newData: {
					status: 'scrapped',
					voidedAt: voidedAt,
					voidReason: reason,
					backfilled: true,
					backfillNote: 'Retroactive audit entry for 2026-04-22 cleanup-script scrap'
				}
			});
			newAudits++;
		}
	}

	console.log(`\nnew scrap txns:     ${newTxns} (skipped existing: ${skippedTxn})`);
	console.log(`new audit entries:  ${newAudits} (skipped existing: ${skippedAudit})`);

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
