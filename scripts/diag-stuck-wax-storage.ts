/**
 * Find cartridges that are stuck at post-QC storage assignment.
 *
 * The recordBatchStorage action in opentron-control/wax/[runId]/+page.server.ts
 * uses a write-once guard:  { _id: cid, 'waxStorage.recordedAt': {$exists:false} }
 * If a cartridge already has waxStorage.recordedAt set from anywhere — a prior
 * attempt, a backfill, stale state — the update silently skips and the
 * cartridge appears "stuck" to the operator.
 *
 * This scans every active wax run in Storage state for those stuck cartridges.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	// 1. Active Storage-phase wax runs
	const runs = await db.collection('wax_filling_runs').find({
		status: { $in: ['Storage', 'storage', 'QC', 'qc'] }
	}).sort({ createdAt: -1 }).toArray();

	console.log(`=== Active Storage/QC-phase wax runs: ${runs.length} ===\n`);

	for (const run of runs as any[]) {
		console.log(`Run ${run._id}  status=${run.status}  robot=${run.robot?.name ?? '?'}  created=${run.createdAt?.toISOString?.()}`);
		const ids: string[] = run.cartridgeIds ?? [];
		if (ids.length === 0) {
			console.log('  (no cartridges)');
			continue;
		}
		const carts = await db.collection('cartridge_records').find({
			_id: { $in: ids }
		}).project({
			_id: 1, status: 1,
			'waxQc.status': 1, 'waxQc.recordedAt': 1,
			'waxStorage.location': 1, 'waxStorage.locationId': 1,
			'waxStorage.recordedAt': 1, 'waxStorage.operator': 1
		}).toArray();

		// Diagnose each cartridge
		let stuck = 0, stored = 0, pendingStorage = 0, rejected = 0;
		for (const c of carts as any[]) {
			const hasStorage = !!c.waxStorage?.recordedAt;
			const status = c.status;
			if (status === 'scrapped') rejected++;
			else if (status === 'wax_stored' && hasStorage) stored++;
			else if (status === 'wax_filled' && !hasStorage) pendingStorage++;
			else {
				// STUCK conditions
				console.log(`  ⚠ STUCK cartridge: ${c._id}`);
				console.log(`    status=${status}`);
				console.log(`    waxStorage.recordedAt=${c.waxStorage?.recordedAt?.toISOString?.() ?? 'unset'}`);
				console.log(`    waxStorage.location=${c.waxStorage?.location ?? 'unset'}`);
				console.log(`    waxStorage.locationId=${c.waxStorage?.locationId ?? 'unset'}`);
				console.log(`    waxStorage.operator=${c.waxStorage?.operator?.username ?? 'unset'}`);
				console.log(`    waxQc.status=${c.waxQc?.status ?? 'unset'}`);
				if (hasStorage && status !== 'wax_stored') {
					console.log(`    ← Has waxStorage.recordedAt but status=${status}. The write-once filter blocks any retry.`);
				}
				stuck++;
			}
		}
		console.log(`  summary: total=${carts.length} stored=${stored} pending=${pendingStorage} rejected=${rejected} stuck=${stuck}\n`);
	}
}
main().catch(e => { console.error(e); process.exit(1); });
