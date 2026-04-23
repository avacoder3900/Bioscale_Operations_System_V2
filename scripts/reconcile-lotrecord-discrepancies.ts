/**
 * Document-don't-paper-over:
 *  (a) LotRecord V1BSHFzMXsNAxYiP59o6b: qProd=54 but 66 UUID-shaped cartridges
 *      were actually pulled across 4 wax runs today. Record a correction
 *      capturing the discrepancy + root cause (pre-refactor code didn't
 *      decrement BackingLot.cartridgeCount so operators couldn't see over-pull).
 *  (b) LotRecord KnvhBjHKSC0jStX1rQw4s: qty=1, finished 2026-04-13. Second
 *      LotRecord 5C7FRF9CX44gpdslMViOr (qty=2, finished 2026-04-15) exists for
 *      the same bucketBarcode 5b867012. Treat the April 15 record as the real
 *      production and mark the older one as voided with a cross-reference.
 *
 * Both actions write AuditLog entries for traceability.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
import { nanoid } from 'nanoid';

(async () => {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const now = new Date();

	// === (a) Over-pull correction on V1BSHFzMXsNAxYiP59o6b ===
	const overPullLotId = 'V1BSHFzMXsNAxYiP59o6b';
	const bucket = '2941bb67-effd-4f87-b5d5-73f9ff840ee3';
	const uuidPulled = await db.collection('cartridge_records').countDocuments({
		'backing.lotId': bucket,
		_id: { $regex: /^[0-9a-f-]{36}$/i }
	});
	console.log(`Over-pull reconciliation for LotRecord ${overPullLotId}`);
	console.log(`  bucketBarcode=${bucket}  quantityProduced=54  actual UUID-shaped cartridges pulled=${uuidPulled}`);

	const correction = {
		_id: nanoid(),
		fieldPath: 'quantityProduced',
		previousValue: 54,
		correctedValue: 54, // not changing the produced qty — documenting the discrepancy
		reason: `Reconciliation: 66 UUID-shaped cartridges were pulled from bucket ${bucket} today (4 wax runs on 2026-04-22) but LotRecord.quantityProduced was 54. Discrepancy of +${uuidPulled - 54} cartridges. Root cause: the deployed code path did not decrement BackingLot.cartridgeCount at loadDeck, so the over-pull was undetectable in real time. Refactor landing this commit (forward fix in wax-filling/+page.server.ts loadDeck with conditional $inc guard) prevents recurrence. Production quantity remains as originally recorded (54); the extra ${uuidPulled - 54} cartridges have provenance traceable to this bucket but an unexplained origin — QA review required before any customer-bound shipments include them.`,
		correctedBy: { _id: 'system', username: 'system-reconciliation' },
		correctedAt: now
	};
	await db.collection('lot_records').updateOne(
		{ _id: overPullLotId },
		{
			$push: { corrections: correction as any },
			$set: { actualConsumedCount: uuidPulled, reconciledAt: now }
		}
	);
	await db.collection('audit_logs').insertOne({
		_id: nanoid(),
		tableName: 'lot_records',
		recordId: overPullLotId,
		action: 'RECONCILE',
		changedBy: 'system-reconciliation',
		changedAt: now,
		reason: 'Over-pull from bucket without decrement guard; 12 cartridges have unverified provenance',
		newData: { actualConsumedCount: uuidPulled, quantityProduced: 54 }
	});
	console.log(`  Correction appended; actualConsumedCount=${uuidPulled} recorded on the LotRecord.`);

	// === (b) Duplicate LotRecord resolution on bucket 5b867012 ===
	const dupBucket = '5b867012-5207-4c53-9d28-a1a69ce34924';
	const dupLots = await db.collection('lot_records').find({ bucketBarcode: dupBucket }).sort({ finishTime: 1 }).toArray();
	console.log(`\nDuplicate LotRecords on bucket ${dupBucket}:`);
	for (const lr of dupLots as any[]) {
		console.log(`  ${lr._id}  qty=${lr.quantityProduced}  finished=${lr.finishTime?.toISOString?.()}`);
	}
	if (dupLots.length === 2) {
		const older = dupLots[0] as any;
		const newer = dupLots[1] as any;
		await db.collection('lot_records').updateOne(
			{ _id: older._id },
			{
				$set: {
					status: 'Superseded',
					supersededBy: newer._id,
					supersededAt: now
				}
			}
		);
		await db.collection('audit_logs').insertOne({
			_id: nanoid(),
			tableName: 'lot_records',
			recordId: older._id,
			action: 'SUPERSEDE',
			changedBy: 'system-reconciliation',
			changedAt: now,
			reason: `Duplicate LotRecord for bucket ${dupBucket}. Superseded by ${newer._id} (newer, larger quantity).`,
			newData: { status: 'Superseded', supersededBy: newer._id }
		});
		console.log(`  Marked ${older._id} as Superseded by ${newer._id}`);
	}

	await mongoose.disconnect();
	console.log('\nDone.');
})();
