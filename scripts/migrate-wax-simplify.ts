/**
 * WAX-SIMPLIFY-1/2 migration: fold retired wax statuses into wax_filled.
 * Dry-run by default; --apply (or APPLY=1) to write. Idempotent — safe to re-run.
 * Run AFTER the WAX-SIMPLIFY code is deployed.
 *
 *   npx tsx scripts/migrate-wax-simplify.ts           # dry run
 *   npx tsx scripts/migrate-wax-simplify.ts --apply   # apply
 *
 * Steps (docs/prds/WAX-SIMPLIFY-1-DROP-WAX-STORED.md, WAX-SIMPLIFY-2-REJECT-ONLY-INSPECTION.md):
 *   1. cartridge_records status 'wax_stored' → 'wax_filled' (priorStatus kept, AuditLog per cart)
 *   2. cartridge_records status 'wax_qc'     → 'wax_filled' (photographed-awaiting-verdict is now
 *      "accepted unless rejected"; photos stay on the record)
 *   3. kanban_standing_targets metric.params.statuses: rewrite 'wax_stored'/'wax_qc' → 'wax_filled'
 *      (dedup) so cartridge_phase_count supply metrics keep counting the same carts
 *   Nothing else: waxStorage (fridge location) is untouched — it's still real data.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { nanoid } from 'nanoid';
dotenv.config();

const APPLY = process.env.APPLY === '1' || process.argv.includes('--apply');
const RETIRED = ['wax_stored', 'wax_qc'] as const;

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const carts = db.collection('cartridge_records');
	const audit = db.collection('audit_log');
	const targets = db.collection('kanban_standing_targets');

	console.log(`\n=== WAX-SIMPLIFY migration — ${APPLY ? 'APPLY' : 'DRY RUN'} ===`);

	// ---- Steps 1 + 2: retired statuses → wax_filled ------------------------------
	for (const from of RETIRED) {
		const rows = (await carts.find({ status: from }).project({ _id: 1 }).toArray()) as any[];
		console.log(`Step ${from === 'wax_stored' ? 1 : 2}: ${rows.length} carts at '${from}' → wax_filled`);
		if (!APPLY || rows.length === 0) continue;
		const now = new Date();
		await carts.updateMany({ status: from }, { $set: { status: 'wax_filled', priorStatus: from } });
		await audit.insertMany(
			rows.map((r) => ({
				_id: nanoid(),
				tableName: 'cartridge_records',
				recordId: r._id,
				action: 'wax_simplify_migration',
				newData: { from, to: 'wax_filled' },
				changedAt: now,
				changedBy: 'migration:wax-simplify'
			}))
		);
	}

	// ---- Step 3: standing-target metric status lists ------------------------------
	const tgts = (await targets
		.find({ 'metric.kind': 'cartridge_phase_count', 'metric.params.statuses': { $in: [...RETIRED] } })
		.project({ _id: 1, name: 1, 'metric.params.statuses': 1 })
		.toArray()) as any[];
	console.log(`Step 3: ${tgts.length} standing targets reference a retired wax status`);
	for (const t of tgts) {
		const old: string[] = t.metric?.params?.statuses ?? [];
		const next = Array.from(new Set(old.map((s) => ((RETIRED as readonly string[]).includes(s) ? 'wax_filled' : s))));
		console.log(`  - ${t.name ?? t._id}: [${old.join(', ')}] → [${next.join(', ')}]`);
		if (APPLY) await targets.updateOne({ _id: t._id }, { $set: { 'metric.params.statuses': next } });
	}

	// ---- Summary counts ----------------------------------------------------------
	const after = await carts
		.aggregate([
			{ $match: { status: { $in: ['wax_filled', 'wax_ready', 'wax_rejected', ...RETIRED] } } },
			{ $group: { _id: '$status', n: { $sum: 1 } } },
			{ $sort: { _id: 1 } }
		])
		.toArray();
	console.log('\nWax-stage counts now:', after.map((r: any) => `${r._id}=${r.n}`).join('  '));
	console.log(`\n${APPLY ? 'APPLIED.' : 'Dry run only — re-run with --apply to write.'}\n`);
	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
