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
			'mint', 'create', 'advance', 'adjust', 'scrap', 'consume',
			'merge_in', 'merge_out', 'release', 'quarantine', 'retire'
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
	operator: { _id: String, username: String },
	createdAt: { type: Date, default: Date.now }
}, { timestamps: false });

bucketTransactionSchema.index({ cycleId: 1, createdAt: 1 });
bucketTransactionSchema.index({ bucketId: 1, createdAt: -1 });
bucketTransactionSchema.index({ type: 1, createdAt: -1 });

applyImmutableMiddleware(bucketTransactionSchema);

export const BucketTransaction = mongoose.models.BucketTransaction
	|| mongoose.model('BucketTransaction', bucketTransactionSchema, 'bucket_transactions');
