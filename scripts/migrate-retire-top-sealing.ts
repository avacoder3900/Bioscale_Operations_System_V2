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
 *   2. CartridgeRecords at `sealed` (top-sealed, awaiting the Reagent Inspect
 *      photo) → `reagent_filled`. Under the new flow reagent_filled IS the
 *      "awaiting photo" state; the photo takes it to reagent_qc. The old
 *      `topSeal` sub-doc is left in place (history); `priorStatus` records
 *      where the cart came from.
 *   3. Audit log rows for both, tagged action 'migrate_retire_top_sealing'.
 *
 * NOT touched: `sealed` / 'Top Sealing' stay in the schema enums (historical
 * rows must still validate); the Cut Top Seal material-cutting flow
 * (top-seal-cutting, WI-03, PT-CT-103 rolls) is unchanged.
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

	// ---- Step 2: sealed cartridges → reagent_filled --------------------------
	const sealedCount = await carts.countDocuments({ status: 'sealed' });
	const sealedSample = (await carts
		.find({ status: 'sealed' })
		.project({ _id: 1, 'topSeal.timestamp': 1, 'reagentFilling.runId': 1, priorStatus: 1 })
		.limit(10)
		.toArray()) as any[];
	console.log(`\nStep 2: ${sealedCount} cartridge(s) at 'sealed' → 'reagent_filled'`);
	for (const c of sealedSample) {
		console.log(`   ${String(c._id)}  sealedAt=${c.topSeal?.timestamp?.toISOString?.() ?? '-'}  reagentRun=${c.reagentFilling?.runId ?? '-'}  prior=${c.priorStatus ?? '-'}`);
	}
	if (sealedCount > 10) console.log(`   … and ${sealedCount - 10} more`);
	if (APPLY && sealedCount > 0) {
		const ids = (await carts.find({ status: 'sealed' }).project({ _id: 1 }).toArray()).map((c: any) => c._id);
		const res = await carts.updateMany(
			{ _id: { $in: ids }, status: 'sealed' },
			{ $set: { status: 'reagent_filled', priorStatus: 'sealed' } }
		);
		console.log(`   modified ${res.modifiedCount}`);
		if (ids.length) {
			await audit.insertMany(ids.map((id: any) => ({
				_id: nanoid(),
				tableName: 'cartridge_records',
				recordId: String(id),
				action: 'migrate_retire_top_sealing',
				oldData: { status: 'sealed' },
				newData: { status: 'reagent_filled' },
				reason: 'REAGENT-TOPSEAL-IMPLICIT: `sealed` retired; reagent_filled is the awaiting-photo state',
				changedBy: 'migration',
				changedAt: now
			})));
		}
	}

	// ---- Summary -------------------------------------------------------------
	const [remainingRuns, remainingSealed] = await Promise.all([
		runs.countDocuments({ status: { $in: RETIRED_RUN_STAGES } }),
		carts.countDocuments({ status: 'sealed' })
	]);
	console.log(`\nAfter: retired-stage runs=${remainingRuns}  sealed carts=${remainingSealed}`);
	if (!APPLY) console.log('\nDry run — nothing written. Re-run with --apply to migrate.');
	await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
