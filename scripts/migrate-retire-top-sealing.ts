/**
 * REAGENT-TOPSEAL-IMPLICIT migration: retire the Top Sealing / Storage
 * post-OT-2 reagent queue and the `sealed` cartridge hop.
 * Dry-run by default; --apply (or APPLY=1) to write. Idempotent — safe to re-run.
 * Run AFTER the REAGENT-TOPSEAL-IMPLICIT code is deployed (the old Opentron
 * Control reagent page that could have touched these rows is gone by then).
 *
 *   npx tsx scripts/migrate-retire-top-sealing.ts           # dry run
 *   npx tsx scripts/migrate-retire-top-sealing.ts --apply   # apply
 *
 * Steps (per docs/prds/REAGENT-TOPSEAL-IMPLICIT.md):
 *   1. ReagentBatchRecords stuck in the retired post-OT-2 stages
 *      ('Inspection' | 'Top Sealing' | 'Storage' + lowercase variants) →
 *      'Completed' (+ finalizedAt / runEndTime / robotReleasedAt if unset).
 *      The OT-2 already finished these runs; they were only "open" for the
 *      manual seal/store steps that no longer exist in BIMS.
 *   2. Report-only: carts still at `sealed`, and the topSeal sub-doc census.
 *      Per Jacob (2026-08-19): DO NOT change any cartridge status and do not
 *      touch completed carts / test results. `sealed` carts keep their status
 *      (/api/cv/capture still accepts `sealed` → reagent_qc when photographed);
 *      historical `topSeal` sub-docs stay for DHR / traceability.
 *   3. Audit log rows for step 1, tagged action 'migrate_retire_top_sealing'.
 *
 * NOT touched: any CartridgeRecord; `sealed` / 'Top Sealing' stay in the schema
 * enums (historical rows must still validate); the Cut Top Seal material-cutting
 * flow (top-seal-cutting, WI-03, PT-CT-103 rolls) is unchanged.
 */
import mongoose from 'mongoose';
import { nanoid } from 'nanoid';
import * as dotenv from 'dotenv';
dotenv.config();

const APPLY = process.env.APPLY === '1' || process.argv.includes('--apply');
const RETIRED_RUN_STAGES = ['Inspection', 'Top Sealing', 'Storage', 'inspection', 'top_sealing', 'storage'];

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const runs = db.collection('reagent_batch_records');
	const carts = db.collection('cartridge_records');
	const audit = db.collection('audit_log');
	const now = new Date();

	console.log(`\n=== REAGENT-TOPSEAL-IMPLICIT migration — ${APPLY ? 'APPLY' : 'DRY RUN'} ===`);

	// ---- Step 1: retired-stage reagent runs → Completed ---------------------
	const stuckRuns = (await runs
		.find({ status: { $in: RETIRED_RUN_STAGES } })
		.project({ _id: 1, status: 1, runEndTime: 1, robotReleasedAt: 1, finalizedAt: 1, cartridgesFilled: 1, 'robot.name': 1, createdAt: 1 })
		.toArray()) as any[];
	console.log(`\nStep 1: ${stuckRuns.length} reagent run(s) in retired stages → Completed`);
	for (const r of stuckRuns) {
		console.log(`   ${String(r._id)}  ${r.status.padEnd(12)} robot=${r.robot?.name ?? '?'}  carts=${r.cartridgesFilled?.length ?? 0}  created=${r.createdAt?.toISOString?.() ?? r.createdAt}`);
	}
	if (APPLY) {
		for (const r of stuckRuns) {
			const set: any = { status: 'Completed' };
			if (!r.finalizedAt) set.finalizedAt = now;
			if (!r.runEndTime) set.runEndTime = now;
			if (!r.robotReleasedAt) set.robotReleasedAt = now;
			await runs.updateOne({ _id: r._id, status: r.status }, { $set: set });
			await audit.insertOne({
				_id: nanoid(),
				tableName: 'reagent_batch_records',
				recordId: String(r._id),
				action: 'migrate_retire_top_sealing',
				oldData: { status: r.status },
				newData: { status: 'Completed' },
				reason: 'REAGENT-TOPSEAL-IMPLICIT: post-OT-2 reagent queue retired; run closed by migration',
				changedBy: 'migration',
				changedAt: now
			});
		}
	}

	// ---- Step 2: report only — no cartridge writes -------------------------
	const sealedCount = await carts.countDocuments({ status: 'sealed' });
	const topSealCensus = await carts.aggregate([
		{ $match: { 'topSeal.recordedAt': { $exists: true } } },
		{ $group: { _id: '$status', n: { $sum: 1 } } }, { $sort: { n: -1 } }
	]).toArray();
	console.log(`\nStep 2 (report only): ${sealedCount} cart(s) still at 'sealed' — left as-is (capture accepts sealed → reagent_qc).`);
	console.log('   carts with a historical topSeal sub-doc, by status (kept for DHR/traceability):');
	for (const row of topSealCensus as any[]) console.log(`     ${String(row._id).padEnd(14)} ${row.n}`);

	// ---- Summary -------------------------------------------------------------
	const remainingRuns = await runs.countDocuments({ status: { $in: RETIRED_RUN_STAGES } });
	console.log(`\nAfter: retired-stage runs=${remainingRuns}  (cartridge statuses untouched by design)`);
	if (!APPLY) console.log('\nDry run — nothing written. Re-run with --apply to migrate.');
	await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
