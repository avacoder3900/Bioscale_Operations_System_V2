/**
 * Backfill script to reconcile two latent bugs exposed during the 2026-04-22 audit:
 *
 *  1. waxQc.status was only ever written on rejection ('Rejected'). The happy path
 *     just advanced the cartridge's top-level status. So every cartridge that
 *     passed QC has waxQc.status empty → dashboard yield and QC-accepted counts
 *     all read zero. Forward fix is already landed in completeQC; this backfills
 *     historical cartridges.
 *
 *  2. BackingLot.cartridgeCount was set once in WI-01 and never decremented as
 *     wax filling pulled cartridges out. Oven tile still shows cartridges that
 *     have already been wax-filled. Forward fix landed in loadDeck; this
 *     corrects the three currently-loaded lots.
 *
 * Idempotent — re-running is safe. Skips cartridges that already have waxQc set.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
const URI = process.env.MONGODB_URI!;

// Every top-level cartridge status that represents "advanced past wax QC on the
// happy path". Rejects live under 'scrapped' and already carry waxQc.status.
const POST_QC_STATUSES = [
	'wax_filled',
	'wax_stored',
	'reagent_filled',
	'inspected',
	'sealed',
	'cured',
	'stored',
	'released',
	'shipped',
	'linked',
	'underway',
	'completed',
	'packeted',
	'transferred',
	'refrigerated',
	'received'
];

async function main() {
	const dry = process.argv.includes('--dry');
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;

	// ---- (1) waxQc.status='Accepted' backfill ----
	console.log(`=== (1) Backfill waxQc.status='Accepted' on historical happy-path cartridges ===`);
	const pending = await db.collection('cartridge_records').countDocuments({
		status: { $in: POST_QC_STATUSES },
		'waxQc.recordedAt': { $exists: false }
	});
	console.log(`  Cartridges matching backfill criteria: ${pending}`);

	if (!dry && pending > 0) {
		const now = new Date();
		const res = await db.collection('cartridge_records').updateMany(
			{
				status: { $in: POST_QC_STATUSES },
				'waxQc.recordedAt': { $exists: false }
			},
			{
				$set: {
					'waxQc.status': 'Accepted',
					'waxQc.operator': { _id: 'system', username: 'system-backfill' },
					'waxQc.timestamp': now,
					'waxQc.recordedAt': now
				}
			}
		);
		console.log(`  UPDATED: matched=${res.matchedCount}  modified=${res.modifiedCount}`);
	} else if (dry) {
		console.log(`  (dry run — no writes)`);
	}

	// ---- (2) BackingLot.cartridgeCount reconciliation ----
	console.log(`\n=== (2) Reconcile BackingLot.cartridgeCount with cartridges actually pulled ===`);
	const lots = await db.collection('backing_lots').find({
		status: { $in: ['in_oven', 'ready'] }
	}).toArray();

	for (const bl of lots as any[]) {
		// Cartridges pulled from this lot = those whose backing.lotId matches the
		// BackingLot._id (the bucketBarcode) AND have advanced past 'backing'.
		// Anything still with status='backing' is physically in the oven.
		const pulled = await db.collection('cartridge_records').countDocuments({
			'backing.lotId': bl._id,
			status: { $ne: 'backing' }
		});
		const remaining = Math.max(0, (bl.cartridgeCount ?? 0) - pulled);
		const newStatus = remaining <= 0 ? 'consumed' : bl.status;
		console.log(`  lot=${bl._id}  was(count=${bl.cartridgeCount}, status=${bl.status})  pulled=${pulled}  ->  count=${remaining}, status=${newStatus}`);
		if (!dry) {
			await db.collection('backing_lots').updateOne(
				{ _id: bl._id },
				{ $set: { cartridgeCount: remaining, status: newStatus } }
			);
		}
	}
	if (dry) console.log(`  (dry run — no writes)`);

	await mongoose.disconnect();
	console.log('\nDone.');
}
main().catch(e => { console.error(e); process.exit(1); });
