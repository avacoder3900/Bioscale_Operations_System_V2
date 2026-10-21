/**
 * Read-only check for PERF-01 BM-02: for every dashboard count, the old pipeline
 * (`_id: { $nin: checkedOutIds }`) and groupCountsExcluding() must return the same rows.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/verify-dashboard-counts.ts
 *
 * Exits 1 on any mismatch. Prints per-key timings for the old and new paths.
 */
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import type { PipelineStage } from 'mongoose';
import { groupCountsExcluding, type GroupRow, type GroupSpec } from '../src/lib/server/checked-out-counts';
import { dashboardCountSpecs, homeCountSpecs } from '../src/lib/server/dashboard-count-specs';

const uri = process.env.MONGODB_URI;
if (!uri) {
	console.error('MONGODB_URI not set in .env');
	process.exit(1);
}

const normalize = (rows: GroupRow[]) =>
	[...rows].map((r) => JSON.stringify(r)).sort();

async function main() {
	const client = await new MongoClient(uri!).connect();
	try {
		const db = client.db();
		const carts = db.collection('cartridge_records');
		const removals = await db.collection('manual_cartridge_removals').find({}, { projection: { cartridgeIds: 1 } }).toArray();
		const checkedOutIds = [...new Set(removals.flatMap((r) => (r.cartridgeIds as string[] | undefined) ?? []))];
		console.log(`checked-out ids: ${checkedOutIds.length}`);

		const aggregator = { aggregate: (pipeline: PipelineStage[]) => carts.aggregate(pipeline).toArray() };
		const now = new Date();
		let mismatches = 0;

		for (const [page, specs] of [['home', homeCountSpecs(now)], ['cartridge-dashboard', dashboardCountSpecs(now)]] as const) {
			const allSpecs = specs as Record<string, GroupSpec>;
			const t0 = performance.now();
			const fresh = await groupCountsExcluding(aggregator, allSpecs, checkedOutIds);
			const newMs = performance.now() - t0;
			let oldMs = 0;
			for (const [key, spec] of Object.entries(allSpecs)) {
				const t1 = performance.now();
				const old = (await carts
					.aggregate([{ $match: { ...spec.match, _id: { $nin: checkedOutIds } } }, { $group: spec.group }])
					.toArray()) as GroupRow[];
				oldMs += performance.now() - t1;
				const same = JSON.stringify(normalize(old)) === JSON.stringify(normalize(fresh[key]));
				if (!same) {
					mismatches += 1;
					console.log(`MISMATCH ${page}.${key}\n  old: ${JSON.stringify(old)}\n  new: ${JSON.stringify(fresh[key])}`);
				} else {
					console.log(`ok ${page}.${key} (${old.length} rows)`);
				}
			}
			console.log(`${page}: old sequential ${oldMs.toFixed(0)} ms, new (parallel) ${newMs.toFixed(0)} ms`);
		}
		if (mismatches > 0) process.exitCode = 1;
		console.log(mismatches === 0 ? 'ALL EQUAL' : `${mismatches} mismatch(es)`);
	} finally {
		await client.close();
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
