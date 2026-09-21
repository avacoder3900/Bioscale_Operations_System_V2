import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const operatorRef = { _id: String, username: String };

/**
 * BucketCycle — one pass of material through the pre-serialization stages
 * (BUCKET-SYSTEM_PLAN.md §4.2). _id is a nanoid so every pass is a permanent,
 * unambiguous record even though the bucket barcode repeats. Displayed as
 * 'BKT-000123 #7' in history views only; operators never scan a suffix.
 *
 * Invariant: a cycle is at exactly one stage and advances as a whole. The
 * quantity changes within a stage only via adjust / scrap / merge, and via
 * WI-01 consumption at qr_pending (partial consumption is allowed, partial
 * advancement is not — §3.1).
 */
const sourceLotSchema = new Schema({
	partNumber: String,   // 'PT-CT-104' | 'PT-CT-106'
	lotId: String,        // ReceivingLot.lotId (scanned barcode)
	scannedAt: Date
}, { _id: false });

const residualFoundSchema = new Schema({
	qty: Number,
	stage: String,
	disposition: { type: String, enum: ['merge', 'scrap', 'defer'] },
	destinationCycleId: String, // set on merge
	removalId: String,          // ManualCartridgeRemoval._id on scrap
	at: Date,
	by: operatorRef
}, { _id: false });

// Count discrepancies discovered against this cycle. 'overrun' = WI-01
// scanned more cartridges than the cycle said it held; 'shortfall' = a
// residual was found after the cycle closed (so fewer went in than
// recorded). §7.1: the residual disposition links back here so the gap
// closes with a cause attached instead of staying an unexplained variance.
const discrepancySchema = new Schema({
	type: { type: String, enum: ['overrun', 'shortfall'] },
	qty: Number,
	relatedId: String, // LotRecord._id (overrun) or removal / destination cycle id (shortfall)
	at: Date,
	note: String
}, { _id: false });

const bucketCycleSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	bucketId: { type: String, required: true },   // ProductionBucket._id ('BKT-000123')
	cycleNumber: { type: Number, required: true }, // → 'BKT-000123 #7'
	stage: {
		type: String,
		enum: ['raw', 'unpressed', 'pressed', 'qr_pending'],
		required: true
	},
	quantity: { type: Number, required: true },   // current count
	openedQty: { type: Number, required: true },  // count at creation; shrinkage = openedQty − quantity
	sourceLots: { type: [sourceLotSchema], default: [] },
	pressEquipmentId: String,    // Equipment._id, set at unpressed → pressed
	pressEquipmentName: String,  // denormalized for display (E-45 / E-46 per equipment datasheet)
	status: {
		type: String,
		enum: ['open', 'consumed', 'scrapped'],
		default: 'open'
	},
	emptyConfirmedBy: operatorRef,
	emptyConfirmedAt: Date,
	closedWithResidual: { type: Boolean, default: false },
	residualFound: { type: [residualFoundSchema], default: [] },
	discrepancies: { type: [discrepancySchema], default: [] },
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

export const BucketCycle = mongoose.models.BucketCycle
	|| mongoose.model('BucketCycle', bucketCycleSchema, 'bucket_cycles');
