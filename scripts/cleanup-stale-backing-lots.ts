/**
 * Mark stale BackingLots as 'consumed'.
 *
 * Rationale: a BackingLot stays in status='ready' as long as cartridgeCount>0,
 * but wax-filling only decrements that counter when carts are loaded onto a
 * deck. If an operator abandons a bucket with leftover carts (or the bucket
 * never gets loaded at all — TEST-LOT-* fixtures), the lot is stranded in
 * 'ready' forever and inflates pipeline.backing.totalReadyCartridges on the
 * cart-mfg dashboard.
 *
 * Safety: this script ONLY touches lots whose attached CartridgeRecords have
 * NO doc still in status='backing' (i.e. nothing is actually waiting in the
 * bucket to be wax-filled). It refuses any lot that has even one cart still
 * in backing status.
 *
 * Pass --apply to mutate. Without it, runs in dry-run mode and prints the plan.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { generateId } from '../src/lib/server/db/utils.js';
dotenv.config();

const APPLY = process.argv.includes('--apply');

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const lots = await db.collection('backing_lots').find({
		status: { $in: ['in_oven', 'ready', 'created'] }
	}).toArray() as any[];

	console.log(`Found ${lots.length} stale backing lots (status in in_oven/ready/created)`);
	console.log(`Mode: ${APPLY ? 'APPLY (will mutate)' : 'DRY-RUN (no mutation)'}\n`);

	const safe: any[] = [];
	const skipped: { lot: any; reason: string }[] = [];

	for (const lot of lots) {
		const stillBacking = await db.collection('cartridge_records').countDocuments({
			'backing.lotId': lot._id,
			status: 'backing'
		});
		if (stillBacking > 0) {
			skipped.push({ lot, reason: `${stillBacking} cart(s) still in status='backing'` });
		} else {
			safe.push(lot);
		}
	}

	console.log(`Safe to consume: ${safe.length}`);
	console.log(`Skipped:         ${skipped.length}\n`);

	for (const lot of safe) {
		console.log(`  CONSUME  ${lot._id}  status=${lot.status}  cartridgeCount=${lot.cartridgeCount}`);
	}
	for (const { lot, reason } of skipped) {
		console.log(`  SKIP     ${lot._id}  ${reason}`);
	}

	if (!APPLY) {
		console.log('\n(dry-run; rerun with --apply to mutate)');
		await mongoose.disconnect();
		return;
	}

	const now = new Date();
	const auditOps: any[] = [];
	const lotOps: any[] = [];
	for (const lot of safe) {
		const previousCartridgeCount = lot.cartridgeCount ?? 0;
		const previousStatus = lot.status;
		lotOps.push({
			updateOne: {
				filter: { _id: lot._id },
				update: { $set: { status: 'consumed', cartridgeCount: 0 } }
			}
		});
		auditOps.push({
			_id: generateId(),
			action: 'backing_lot_consume_stale',
			resourceType: 'backing_lot',
			resourceId: lot._id,
			userId: 'system',
			username: 'system',
			timestamp: now,
			details: {
				previousStatus,
				previousCartridgeCount,
				reason: 'No cartridges remain in status=backing for this lot; bucket remainder stranded by wax-fill workflow. Cleanup batch 2026-05-22.'
			}
		});
	}

	if (lotOps.length > 0) {
		const r = await db.collection('backing_lots').bulkWrite(lotOps);
		console.log(`\nBackingLot bulkWrite: modified=${r.modifiedCount}  matched=${r.matchedCount}`);
	}
	if (auditOps.length > 0) {
		const r = await db.collection('audit_log').insertMany(auditOps);
		console.log(`AuditLog inserted: ${r.insertedCount}`);
	}

	console.log('\nDone.');
	await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
