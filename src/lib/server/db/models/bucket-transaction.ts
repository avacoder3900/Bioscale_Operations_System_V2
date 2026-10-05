import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';
import { applyImmutableMiddleware } from '../middleware/immutable.js';

/**
 * BucketTransaction — immutable ledger for every bucket / cycle mutation
 * (BUCKET-SYSTEM_PLAN.md §4.3). The bucket and cycle docs are current state;
 * this is history. Never derive current state by replaying it at read time —
 * it exists for audit and metrics (dwell per stage, turns per bucket, loss).
 */
const bucketTransactionSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	bucketId: { type: String, required: true },
	cycleId: String, // null for bucket-only events (mint, retire, quarantine of an unused tub)
	type: {
		type: String,
		enum: [
			'mint', 'relabel', 'create', 'scan_in', 'unscan', 'advance', 'adjust', 'scrap', 'consume',
			'merge_in', 'merge_out', 'release', 'quarantine', 'retire', 'void', 'audit',
			'oven', // moveToOven: the backed pass's carts released to the oven, all at once (2026-09-25)
			'nickname', // setBucketNickname: nickname set, changed or cleared (2026-09-30)
			'pull', // pullIntoProcess: an Unpressed pass pulled into "in process" — the custody handoff (2026-10-05)
			'finish', // finishBarcoding: a Barcoded pass marked Finished — scan-in closed, awaiting thermoseal processing (2026-10-05)
			'reopen' // reopenBarcoding: that Finished taken back — the bucket takes scans again (2026-10-05)
		],
		required: true
	},
	fromStage: String,
	toStage: String,
	qtyBefore: Number,
	qtyAfter: Number,
	qtyDelta: Number,
	reason: String,    // required for adjust / scrap
	journal: String,   // required free text for residual scrap (§3.6)
	relatedId: String, // LotRecord._id on consume; peer cycleId on merge; removal id on scrap
	cartridgeIds: { type: [String], default: undefined }, // the cartridges this event touched (v2)
	operator: { _id: String, username: String },
	// Badge attribution (BADGE-SYSTEM_PLAN.md §15.3). `operator` is unchanged in
	// meaning — the effective actor. `enteredBy` is the web session that submitted
	// the request; on a badge-gated event (mint, create) they can differ.
	// Rows written before 2026-09-30 have neither: read them as method 'login'.
	enteredBy: { _id: String, username: String },
	attribution: {
		method: { type: String, enum: ['badge', 'login'] },
		badgeId: String,   // OperatorBadge._id
		custodyId: String  // Custody._id opened by this event (create only)
	},
	createdAt: { type: Date, default: Date.now }
}, { timestamps: false });

bucketTransactionSchema.index({ cycleId: 1, createdAt: 1 });
bucketTransactionSchema.index({ bucketId: 1, createdAt: -1 });
bucketTransactionSchema.index({ type: 1, createdAt: -1 });
// The board's change log is `find({}).sort({ createdAt: -1 }).limit(150)` — none
// of the compound indexes above can serve a bare createdAt sort, so that was a
// full collection scan on every board load, over a collection every scan-in
// appends to. Added 2026-09-25.
bucketTransactionSchema.index({ createdAt: -1 });

applyImmutableMiddleware(bucketTransactionSchema);

export const BucketTransaction = mongoose.models.BucketTransaction
	|| mongoose.model('BucketTransaction', bucketTransactionSchema, 'bucket_transactions');
