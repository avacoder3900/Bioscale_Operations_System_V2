import mongoose, { Schema } from 'mongoose';

/**
 * ProductionBucket — the physical tub (BUCKET-SYSTEM_PLAN.md §4.1).
 *
 * The barcode IS the _id and is permanent: a bucket is used, drained and
 * refilled indefinitely. Contents live on BucketCycle (one row per pass), so
 * the same label can carry material through the stages many times without
 * any history becoming ambiguous. This is the deliberate opposite of the
 * legacy BackingLot, whose barcode-as-primary-key made it single-use.
 */
const productionBucketSchema = new Schema({
	_id: { type: String }, // 'BKT-000123' — minted by generateBarcode('BKT', 'bucket')
	state: {
		type: String,
		enum: ['available', 'in_use', 'quarantined', 'retired'],
		default: 'available'
	},
	currentCycleId: { type: String, default: null }, // BucketCycle._id while in_use
	cycleCount: { type: Number, default: 0 },        // monotonic; $inc on every cycle open
	homeLocation: String,                            // shelf label or Equipment._id
	// Set on auto-release (cycle drained to 0). The next Start Cycle shows a
	// one-tap "Confirmed empty" that clears it — never blocks (§3.5).
	spotCheckPending: { type: Boolean, default: false },
	// Set when a residual was reported and the operator chose Defer (§7c).
	// The bucket stops being offered for reuse until dispositioned.
	residualNote: String,
	retiredAt: Date,
	retiredReason: String,
	createdBy: { _id: String, username: String }
}, { timestamps: true });

productionBucketSchema.index({ state: 1 });

export const ProductionBucket = mongoose.models.ProductionBucket
	|| mongoose.model('ProductionBucket', productionBucketSchema, 'production_buckets');
