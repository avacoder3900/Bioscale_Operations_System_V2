/**
 * REVERTING an earlier mistake.
 *
 * scripts/fix-backfill-post-completion-manual-removals.ts incorrectly treated
 * a "manual checkout" as a "scrap" event. It changed status='completed' to
 * status='scrapped', stamped voidedAt/voidReason, and wrote an InventoryTransaction
 * of type='scrap' for each of 30 cartridges.
 *
 * User clarified: manual removal is a checkout (physical possession change),
 * orthogonal to scrap status. A scrapped cartridge stays scrapped when
 * checked out; a completed cartridge stays completed.
 *
 * This script:
 *   1. Reverts status from 'scrapped' back to 'completed' for the 30 target
 *      cartridges, and unsets voidedAt + voidReason.
 *   2. Marks the 30 incorrectly-emitted scrap InventoryTransactions with
 *      retractedAt/retractedBy/retractionReason so they're filtered out of
 *      the scrap audit (and the immutable collection doesn't need deletion).
 *   3. KEEPS the 30 ManualCartridgeRemoval docs — those correctly represent
 *      the checkout event and are what the user wanted.
 *   4. Writes AuditLog entries documenting the reversal.
 *
 * Idempotent: re-running skips cartridges that are already back to 'completed'.
 */
import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
import { generateId } from '../src/lib/server/db/utils.js';

const INPUT_FILE = path.resolve(process.cwd(), 'scripts/data/manual-removal-backfill-2026-04-23.txt');
const REVERSAL_REASON = 'Revert: manual checkout should not change status — cartridge is a checkout event, not a scrap event. Restoring status=completed and retracting the scrap InventoryTransaction.';
const OPERATOR = 'system-revert-2026-04-23';
const ORIGINAL_BACKFILL_USER = 'system-backfill-2026-04-23';

async function main() {
	const URI = process.env.MONGODB_URI;
	if (!URI) throw new Error('MONGODB_URI not set');

	const raw = fs.readFileSync(INPUT_FILE, 'utf8');
	const unique = Array.from(new Set(raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)));
	console.log(`Target: ${unique.length} unique cartridge IDs from the earlier backfill input`);

	await mongoose.connect(URI);
	const db = mongoose.connection.db!;
	const carts = db.collection('cartridge_records');
	const txns = db.collection('inventory_transactions');
	const audits = db.collection('audit_logs');

	// 1. Identify cartridges that are currently status='scrapped' from our backfill
	//    (voidReason was set to the backfill reason). Those get reverted.
	const scrappedFromBackfill = await carts.find({
		_id: { $in: unique },
		status: 'scrapped',
		voidReason: /^Manually Removed Post Completion/
	}).project({ _id: 1 }).toArray() as any[];

	const toRevert = scrappedFromBackfill.map((c) => c._id);
	const alreadyReverted = unique.filter((id) => !toRevert.includes(id));

	console.log(`\nCartridges to revert:  ${toRevert.length}`);
	console.log(`Already reverted/skip: ${alreadyReverted.length}`);

	const now = new Date();
	let cartReverts = 0, txnsRetracted = 0, auditsWritten = 0;

	for (const cid of toRevert) {
		// Revert cartridge status
		const res = await carts.updateOne(
			{ _id: cid, status: 'scrapped' },
			{
				$set: { status: 'completed' },
				$unset: { voidedAt: '', voidReason: '' }
			}
		);
		if (res.modifiedCount > 0) cartReverts++;

		// Retract the scrap txn that was incorrectly written
		const txnUpdate = await txns.updateMany(
			{
				cartridgeRecordId: cid,
				transactionType: 'scrap',
				operatorUsername: ORIGINAL_BACKFILL_USER,
				retractedAt: { $exists: false }
			},
			{
				$set: {
					retractedBy: OPERATOR,
					retractedAt: now,
					retractionReason: REVERSAL_REASON
				}
			}
		);
		txnsRetracted += txnUpdate.modifiedCount ?? 0;

		// Audit log the reversal
		await audits.insertOne({
			_id: generateId(),
			tableName: 'cartridge_records',
			recordId: cid,
			action: 'UPDATE',
			changedBy: OPERATOR,
			changedAt: now,
			newData: {
				status: 'completed',
				voidedAt: null,
				voidReason: null,
				revertedFromStatus: 'scrapped',
				note: 'Manual checkout does not change status; scrap treatment was incorrect'
			},
			reason: REVERSAL_REASON
		});
		auditsWritten++;
	}

	console.log(`\nDone.`);
	console.log(`  CartridgeRecord reverts (→completed): ${cartReverts}`);
	console.log(`  scrap InventoryTransactions marked retracted: ${txnsRetracted}`);
	console.log(`  AuditLog entries: ${auditsWritten}`);
	console.log(`\nManualCartridgeRemoval docs are untouched — they correctly represent the checkout event.`);

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
