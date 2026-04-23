/**
 * One-off backfill: convert a list of status='completed' cartridges into
 * manually-removed-post-completion records.
 *
 * Input file format: one cartridge _id per line (blank lines and duplicates
 * are ignored). Path: scripts/data/manual-removal-backfill-2026-04-23.txt
 *
 * Per the user's spec:
 *   - Each cartridge is an INDEPENDENT record — one ManualCartridgeRemoval doc
 *     per cartridge (cartridgeIds[] has exactly one entry), so the history
 *     table renders one row per cartridge.
 *   - UI guard stays strict (wax_stored only); this script bypasses that
 *     check because the targets are status='completed' and will be
 *     re-classified to 'scrapped' as part of the backfill.
 *
 * Per cartridge the script writes:
 *   1. ManualCartridgeRemoval doc (single-cart group)
 *   2. CartridgeRecord update: status='completed' -> 'scrapped', voidedAt, voidReason
 *   3. InventoryTransaction (type='scrap', quantity=1, cartridgeRecordId=<cid>,
 *      manufacturingRunId=<removalId>, manufacturingStep='storage').
 *      No partDefinitionId set — inventory was already decremented at WI-01
 *      backing when these cartridges came into existence; re-decrementing
 *      would double-count.
 *   4. AuditLog for the cartridge_records status change.
 *
 * Idempotent: re-running will skip any cartridge that is no longer
 * status='completed' (i.e. already backfilled).
 */
import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
import { generateId } from '../src/lib/server/db/utils.js';

const INPUT_FILE = path.resolve(process.cwd(), 'scripts/data/manual-removal-backfill-2026-04-23.txt');
const REASON = 'Manually Removed Post Completion due to building of manual removal system before completion [backfilled 2026-04-23]';
const OPERATOR = 'system-backfill-2026-04-23';

async function main() {
	const URI = process.env.MONGODB_URI;
	if (!URI) throw new Error('MONGODB_URI not set');

	const raw = fs.readFileSync(INPUT_FILE, 'utf8');
	const all = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
	const unique = Array.from(new Set(all));
	console.log(`Input: ${all.length} lines, ${unique.length} unique IDs (${all.length - unique.length} duplicates ignored)`);

	await mongoose.connect(URI);
	const db = mongoose.connection.db!;
	const carts = db.collection('cartridge_records');
	const removals = db.collection('manual_cartridge_removals');
	const txns = db.collection('inventory_transactions');
	const audits = db.collection('audit_logs');

	// Pre-check: what's the current status of each listed ID?
	const docs = await carts.find({ _id: { $in: unique } }).project({ _id: 1, status: 1, waxStorage: 1 }).toArray() as any[];
	const byId = new Map(docs.map((d) => [d._id, d]));

	const missing: string[] = [];
	const wrongStatus: { id: string; status: string }[] = [];
	const eligible: string[] = [];
	const alreadyScrapped: string[] = [];

	for (const cid of unique) {
		const d = byId.get(cid);
		if (!d) { missing.push(cid); continue; }
		if (d.status === 'completed') { eligible.push(cid); continue; }
		if (d.status === 'scrapped') { alreadyScrapped.push(cid); continue; }
		wrongStatus.push({ id: cid, status: d.status });
	}

	console.log(`\nPre-check:`);
	console.log(`  eligible (status=completed): ${eligible.length}`);
	console.log(`  already scrapped (skip):     ${alreadyScrapped.length}`);
	console.log(`  wrong status (skip):         ${wrongStatus.length}`);
	for (const w of wrongStatus) console.log(`    ${w.id}: status='${w.status}'`);
	console.log(`  not found:                   ${missing.length}`);
	for (const m of missing) console.log(`    ${m}`);

	if (eligible.length === 0) {
		console.log('\nNothing to do. Exiting.');
		await mongoose.disconnect();
		return;
	}

	const now = new Date();
	const voidReason = REASON;

	console.log(`\nApplying backfill to ${eligible.length} cartridges...`);
	let writtenTxns = 0, writtenAudits = 0, writtenRemovals = 0, writtenCartUpdates = 0;

	for (const cid of eligible) {
		const removalId = generateId();

		await removals.insertOne({
			_id: removalId,
			cartridgeIds: [cid],
			reason: REASON,
			operator: { _id: OPERATOR, username: OPERATOR },
			removedAt: now,
			createdAt: now,
			updatedAt: now
		});
		writtenRemovals++;

		await carts.updateOne(
			{ _id: cid, status: 'completed' }, // defense against concurrent status change
			{ $set: { status: 'scrapped', voidedAt: now, voidReason } }
		);
		writtenCartUpdates++;

		await txns.insertOne({
			_id: generateId(),
			transactionType: 'scrap',
			cartridgeRecordId: cid,
			quantity: 1,
			manufacturingStep: 'storage',
			manufacturingRunId: removalId,
			operatorId: OPERATOR,
			operatorUsername: OPERATOR,
			performedBy: OPERATOR,
			performedAt: now,
			notes: `Manual wax-stored removal backfill (group ${removalId}): ${REASON}`,
			reason: REASON,
			scrapReason: REASON,
			scrapCategory: 'other'
		});
		writtenTxns++;

		await audits.insertOne({
			_id: generateId(),
			tableName: 'cartridge_records',
			recordId: cid,
			action: 'UPDATE',
			changedBy: OPERATOR,
			changedAt: now,
			newData: {
				status: 'scrapped',
				voidedAt: now,
				voidReason,
				removalGroupId: removalId,
				backfilled: true
			},
			reason: voidReason
		});
		writtenAudits++;
	}

	console.log(`\nDone.`);
	console.log(`  ManualCartridgeRemoval docs: ${writtenRemovals}`);
	console.log(`  CartridgeRecord updates:     ${writtenCartUpdates}`);
	console.log(`  InventoryTransactions:       ${writtenTxns}`);
	console.log(`  AuditLog entries:            ${writtenAudits}`);

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
