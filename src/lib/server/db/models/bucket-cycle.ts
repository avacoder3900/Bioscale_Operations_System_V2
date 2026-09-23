import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const operatorRef = { _id: String, username: String };

/**
 * BucketCycle — one pass of cartridges through a production bucket
 * (BUCKET-SYSTEM_PLAN.md v2). _id is a nanoid so every pass is a permanent,
 * unambiguous record even though the bucket id repeats. Displayed as
 * 'BKT-000123 #7' in history views only; operators scan the tub's QR sticker.
 *
 * v2 (2026-09-23): a pass is a MEMBERSHIP LIST, not a count. Each cartridge
 * is serialized (CartridgeRecord created at status 'raw') the moment its QR
 * sticker is scanned into the bucket; `cartridgeIds` holds the members and
 * `quantity` is kept equal to its length for the board and counts. Advancing
 * the bucket advances every member's status. WI-01 draws members out to
 * 'backing' (In Oven); the pass closes when the last one leaves.
 */
const sourceLotSchema = new Schema({
	partNumber: String,   // 'PT-CT-104' shell | 'PT-CT-106' label | 'PT-CT-112' thermoseal
	lotId: String,        // ReceivingLot.lotId (scanned barcode)
	scannedAt: Date
}, { _id: false });

const residualFoundSchema = new Schema({
	qty: Number,
	stage: String,
	cartridgeIds: { type: [String], default: [] },
	disposition: { type: String, enum: ['merge', 'scrap', 'defer'] },
	destinationCycleId: String, // set on merge
	removalId: String,          // ManualCartridgeRemoval._id on scrap
	at: Date,
	by: operatorRef
}, { _id: false });

// A physical audit of the tub (§9.8): every cart scanned against the pass's
// members. Append-only — an audit never rewrites quantity; what it moved or
// discarded is in the ledger next to it.
const auditRunSchema = new Schema({
	at: Date,
	by: operatorRef,
	scanned: { type: [String], default: [] },   // every code scanned in the tub
	present: { type: [String], default: [] },   // members that were found
	missing: { type: [String], default: [] },   // members that were NOT scanned (see missingActions)
	// What the operator chose for a missing member: scrapped, or taken off the pass
	// as a loose cart. A member with no entry here stayed on the pass.
	missingActions: {
		type: [{ _id: false, barcode: String, action: { type: String, enum: ['discard', 'release'] } }],
		default: []
	},
	foreign: {
		type: [{
			_id: false,
			barcode: String,
			action: { type: String, enum: ['moved', 'discarded', 'returned'] },
			fromCycleId: String,             // the open pass it was a member of, if any
			destinationBucketId: String,     // 'moved'
			destinationCycleId: String
		}],
		default: []
	}
}, { _id: false });

// Count discrepancies discovered against this cycle. 'shortfall' = leftover
// cartridges were found in the tub after the pass closed.
const discrepancySchema = new Schema({
	type: { type: String, enum: ['overrun', 'shortfall'] },
	qty: Number,
	relatedId: String,
	at: Date,
	note: String
}, { _id: false });

const bucketCycleSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	bucketId: { type: String, required: true },   // ProductionBucket._id ('BKT-000123')
	cycleNumber: { type: Number, required: true }, // → 'BKT-000123 #7'
	stage: {
		type: String,
		enum: ['raw', 'unpressed', 'pressed', 'qr_pending'], // qr_pending: v1 only, kept so old rows validate
		required: true
	},
	cartridgeIds: { type: [String], default: [] }, // members currently in the tub (v2)
	quantity: { type: Number, required: true },    // == cartridgeIds.length (denormalized for counts)
	openedQty: { type: Number, required: true },   // members when the pass first left Raw (shrinkage = openedQty − quantity)
	sourceLots: { type: [sourceLotSchema], default: [] },
	// Thermoseal taken at raw → unpressed (BUCKET-SYSTEM_PLAN v2 §3.4): total cm
	// and the roll segments it came from, so voidCycle can credit the length back.
	thermoseal: {
		cm: Number,
		cartridges: Number,
		segments: { type: [{ _id: false, rollId: String, cm: Number }], default: undefined },
		consumedAt: Date
	},
	status: {
		type: String,
		// 'voided' = the pass never really happened (test data, or opened against
		// the wrong lot). Its inventory debits were reversed by voidCycle(); the
		// record and its ledger stay, marked, never deleted.
		enum: ['open', 'consumed', 'scrapped', 'voided'],
		default: 'open'
	},
	voidedAt: Date,
	voidedBy: operatorRef,
	voidReason: String,
	statusBeforeVoid: String,
	emptyConfirmedBy: operatorRef,
	emptyConfirmedAt: Date,
	closedWithResidual: { type: Boolean, default: false },
	residualFound: { type: [residualFoundSchema], default: [] },
	discrepancies: { type: [discrepancySchema], default: [] },
	audits: { type: [auditRunSchema], default: [] },
	openedBy: operatorRef,
	openedAt: Date,
	stageEnteredAt: Date, // set on create and on every advance — dwell time without replaying the ledger
	closedAt: Date
}, { timestamps: true });

// DB-level guarantee that a bucket holds at most ONE open cycle. Two
// operators starting a cycle on the same tub becomes a duplicate-key write
// error (11000), not a silent double-booking. Do not rely on app checks.
bucketCycleSchema.index(
	{ bucketId: 1 },
	{ unique: true, partialFilterExpression: { status: 'open' } }
);
bucketCycleSchema.index({ stage: 1, status: 1 });
bucketCycleSchema.index({ bucketId: 1, cycleNumber: -1 });
bucketCycleSchema.index({ cartridgeIds: 1 });

export const BucketCycle = mongoose.models.BucketCycle
	|| mongoose.model('BucketCycle', bucketCycleSchema, 'bucket_cycles');
