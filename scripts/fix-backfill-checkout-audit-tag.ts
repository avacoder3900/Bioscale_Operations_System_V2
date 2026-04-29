/**
 * ECC-11 — Backfill action='CHECKOUT' audit tag for 2026-04-23 post-completion removals.
 *
 * Context: On 2026-04-23 a batch of 30 cartridges was marked as manually
 * removed via scripts/fix-backfill-post-completion-manual-removals.ts. That
 * script wrote audit_logs rows with action='UPDATE' because the 'CHECKOUT'
 * action label was introduced later the same day (commit 0e8140e added it
 * to the enum). As a result, any compliance filter such as
 *   audit_logs.find({ action: 'CHECKOUT' })
 * will miss those 30 cartridges.
 *
 * This script is ADDITIVE — it does not mutate the existing UPDATE audit
 * rows. It inserts brand-new AuditLog entries with action='CHECKOUT' for
 * every cartridge that belongs to the 2026-04-23 backfill event, preserving
 * the original removal timestamp as changedAt.
 *
 * Idempotent: re-runs detect rows previously written by this migration
 * (via newData.removalGroupId) and skip them.
 *
 * Safety gate: the script verifies the manual_cartridge_removals query
 * returns exactly 30 docs spanning 30 distinct cartridge IDs before doing
 * anything. If that shape drifts, the script exits — preventing cross-event
 * contamination.
 *
 * Usage:
 *   npx tsx scripts/fix-backfill-checkout-audit-tag.ts --plan
 *   npx tsx scripts/fix-backfill-checkout-audit-tag.ts --apply
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
import { generateId } from '../src/lib/server/db/utils.js';

const BACKFILL_OPERATOR = 'system-backfill-2026-04-23';
const TAG_OPERATOR = 'system-backfill-checkout-tag-2026-04-24';
const EXPECTED_COUNT = 30;
const REASON = 'Backfill: CHECKOUT audit tag for 2026-04-23 post-completion removals';
const MIGRATION_META_ID = 'migration-checkout-tag-2026-04-24';

type Mode = 'plan' | 'apply';

function parseMode(): Mode {
	const args = process.argv.slice(2);
	const hasPlan = args.includes('--plan');
	const hasApply = args.includes('--apply');
	if (hasPlan === hasApply) {
		// either both or neither
		console.error('Usage: npx tsx scripts/fix-backfill-checkout-audit-tag.ts [--plan | --apply]');
		console.error('  --plan  : read-only, print what would change');
		console.error('  --apply : commit the backfill');
		process.exit(1);
	}
	return hasApply ? 'apply' : 'plan';
}

async function main() {
	const mode = parseMode();
	const URI = process.env.MONGODB_URI;
	if (!URI) throw new Error('MONGODB_URI not set');

	await mongoose.connect(URI);
	const db = mongoose.connection.db!;
	const removalsCol = db.collection('manual_cartridge_removals');
	const auditsCol = db.collection('audit_logs');

	// Step 1: fetch the 30 target removal docs. Scope strictly by operator.username.
	const removals = await removalsCol
		.find({ 'operator.username': BACKFILL_OPERATOR })
		.toArray() as any[];

	// Collect distinct cartridge IDs across all removals
	const cartridgeSet = new Set<string>();
	for (const r of removals) {
		for (const cid of r.cartridgeIds ?? []) cartridgeSet.add(cid);
	}
	const allCartridgeIds = Array.from(cartridgeSet);

	console.log(`Mode: ${mode.toUpperCase()}`);
	console.log(`Target removal docs (operator='${BACKFILL_OPERATOR}'): ${removals.length}`);
	console.log(`Distinct cartridge IDs across those removals:          ${allCartridgeIds.length}`);

	if (removals.length !== EXPECTED_COUNT || allCartridgeIds.length !== EXPECTED_COUNT) {
		console.error(
			`\nERROR: Safety gate failed. Expected exactly ${EXPECTED_COUNT} removal docs and ${EXPECTED_COUNT} distinct cartridges.`
		);
		console.error(`Got ${removals.length} removals, ${allCartridgeIds.length} cartridges.`);
		console.error('This script is scoped to the 2026-04-23 backfill event only — aborting to avoid cross-event contamination.');
		await mongoose.disconnect();
		process.exit(1);
	}

	// Step 2: plan/apply per-cartridge
	type Row = { removalId: string; cartridgeId: string; removedAt: Date; reason: string; alreadyTagged: boolean };
	const rows: Row[] = [];

	for (const removal of removals) {
		const removalId: string = removal._id;
		const removedAt: Date = removal.removedAt ?? removal.createdAt ?? new Date(0);
		const reason: string = removal.reason ?? '';
		for (const cid of removal.cartridgeIds ?? []) {
			const existing = await auditsCol.findOne({
				recordId: cid,
				action: 'CHECKOUT',
				'newData.removalGroupId': removalId
			});
			rows.push({
				removalId,
				cartridgeId: cid,
				removedAt,
				reason,
				alreadyTagged: !!existing
			});
		}
	}

	// Aggregate for display: removal group -> counts
	const byGroup = new Map<string, { total: number; existing: number; new: number }>();
	for (const r of rows) {
		const b = byGroup.get(r.removalId) ?? { total: 0, existing: 0, new: 0 };
		b.total++;
		if (r.alreadyTagged) b.existing++;
		else b.new++;
		byGroup.set(r.removalId, b);
	}

	console.log(`\nPer-removal-group plan:`);
	console.log(`  ${'removalId'.padEnd(24)}  total  new  existing`);
	for (const [gid, b] of byGroup) {
		console.log(`  ${gid.padEnd(24)}  ${String(b.total).padStart(5)}  ${String(b.new).padStart(3)}  ${String(b.existing).padStart(8)}`);
	}

	const totalNew = rows.filter((r) => !r.alreadyTagged).length;
	const totalSkip = rows.filter((r) => r.alreadyTagged).length;

	console.log(`\nTotals:`);
	console.log(`  cartridges evaluated:    ${rows.length}`);
	console.log(`  new CHECKOUT inserts:    ${totalNew}`);
	console.log(`  already tagged (skip):   ${totalSkip}`);

	if (mode === 'plan') {
		console.log(`\n[PLAN] No writes performed. Re-run with --apply to commit.`);
		await mongoose.disconnect();
		return;
	}

	// Step 3: apply inserts
	console.log(`\n[APPLY] Inserting ${totalNew} CHECKOUT audit rows...`);
	const nowApplied = new Date();
	let inserted = 0;
	let skipped = 0;

	for (const r of rows) {
		if (r.alreadyTagged) {
			skipped++;
			continue;
		}
		await auditsCol.insertOne({
			_id: generateId(),
			tableName: 'cartridge_records',
			recordId: r.cartridgeId,
			action: 'CHECKOUT',
			changedBy: TAG_OPERATOR,
			changedAt: r.removedAt, // preserve historical timestamp
			newData: {
				checkedOut: true,
				removalGroupId: r.removalId,
				reason: r.reason,
				backfilledTag: true,
				backfilledAt: nowApplied
			},
			reason: REASON
		});
		inserted++;
	}

	// Step 4: meta-audit documenting the migration
	if (inserted > 0) {
		await auditsCol.insertOne({
			_id: generateId(),
			tableName: 'audit_logs',
			recordId: MIGRATION_META_ID,
			action: 'MIGRATION_CHECKOUT_TAG_BACKFILL',
			changedBy: TAG_OPERATOR,
			changedAt: nowApplied,
			newData: {
				inserted,
				skipped,
				targetCartridges: allCartridgeIds
			},
			reason: REASON
		});
	}

	console.log(`\n[APPLY] Done.`);
	console.log(`  inserted: ${inserted}`);
	console.log(`  skipped:  ${skipped}`);
	console.log(`  target cartridges (total): ${allCartridgeIds.length}`);

	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
