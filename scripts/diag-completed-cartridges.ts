/**
 * Scope the backfill for "completed" cartridges that should be re-tagged as
 * manually removed.
 *
 * Goals:
 *  - Count CartridgeRecord.status='completed' (and near-neighbor statuses).
 *  - Distinguish which phase they were at when they became 'completed'
 *    (wax_stored path vs reagent_filled/inspected/sealed/cured/stored/released).
 *  - Sample a few docs to show what fields they carry.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const carts = db.collection('cartridge_records');

	console.log('='.repeat(72));
	console.log(' CARTRIDGE STATUS DISTRIBUTION');
	console.log('='.repeat(72));

	const byStatus = await carts.aggregate([
		{ $group: { _id: '$status', n: { $sum: 1 } } },
		{ $sort: { n: -1 } }
	]).toArray();
	for (const s of byStatus) {
		console.log(`  ${String(s._id ?? '(null)').padEnd(24)} ${s.n}`);
	}

	console.log('\n' + '='.repeat(72));
	console.log(' status=completed — phase fingerprint (which steps did they complete?)');
	console.log('='.repeat(72));
	const completedBreakdown = await carts.aggregate([
		{ $match: { status: 'completed' } },
		{ $project: {
			hasBacking: { $cond: [{ $ifNull: ['$backing.lotId', false] }, 1, 0] },
			hasWaxFill: { $cond: [{ $ifNull: ['$waxFilling.runId', false] }, 1, 0] },
			waxQc: '$waxQc.status',
			hasWaxStorage: { $cond: [{ $ifNull: ['$waxStorage.location', false] }, 1, 0] },
			hasReagent: { $cond: [{ $ifNull: ['$reagentFilling.runId', false] }, 1, 0] },
			reagentInspection: '$reagentInspection.status',
			hasTopSeal: { $cond: [{ $ifNull: ['$topSeal.batchId', false] }, 1, 0] },
			hasStorage: { $cond: [{ $ifNull: ['$storage.locationId', false] }, 1, 0] },
			hasRelease: { $cond: [{ $ifNull: ['$qaqcRelease.shippingLotId', false] }, 1, 0] }
		} },
		{ $group: {
			_id: {
				hasBacking: '$hasBacking',
				hasWaxFill: '$hasWaxFill',
				waxQc: '$waxQc',
				hasWaxStorage: '$hasWaxStorage',
				hasReagent: '$hasReagent',
				reagentInspection: '$reagentInspection',
				hasTopSeal: '$hasTopSeal',
				hasStorage: '$hasStorage',
				hasRelease: '$hasRelease'
			},
			n: { $sum: 1 }
		} },
		{ $sort: { n: -1 } }
	]).toArray();

	console.log(`  distinct fingerprints: ${completedBreakdown.length}`);
	for (const f of completedBreakdown.slice(0, 15)) {
		const k = f._id as any;
		console.log(`  ${f.n.toString().padStart(4)}× backing=${k.hasBacking} waxFill=${k.hasWaxFill} waxQc=${k.waxQc ?? '-'} waxStorage=${k.hasWaxStorage} reagent=${k.hasReagent} reagentInsp=${k.reagentInspection ?? '-'} topSeal=${k.hasTopSeal} storage=${k.hasStorage} release=${k.hasRelease}`);
	}

	console.log('\n' + '='.repeat(72));
	console.log(' Sample completed cartridges (5)');
	console.log('='.repeat(72));
	const samples = await carts.find({ status: 'completed' }).limit(5).toArray();
	for (const c of samples as any[]) {
		console.log(`\n  _id=${c._id}`);
		console.log(`    backing.lotId=${c.backing?.lotId}  waxQc.status=${c.waxQc?.status}  waxStorage.location=${c.waxStorage?.location}`);
		console.log(`    reagentFilling.runId=${c.reagentFilling?.runId}  reagentInspection.status=${c.reagentInspection?.status}`);
		console.log(`    storage.locationId=${c.storage?.locationId}  storage.fridgeName=${c.storage?.fridgeName}`);
		console.log(`    updatedAt=${c.updatedAt?.toISOString?.() ?? c.updatedAt}`);
	}

	console.log('\n' + '='.repeat(72));
	console.log(' Also: other non-terminal statuses that might be the real target');
	console.log('='.repeat(72));
	for (const st of ['stored', 'released', 'reagent_filled', 'inspected', 'sealed', 'cured']) {
		const n = await carts.countDocuments({ status: st });
		if (n > 0) console.log(`  status=${st.padEnd(20)} ${n}`);
	}

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
