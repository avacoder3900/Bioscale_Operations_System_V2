import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * WaxBatch — tracks a batch of 15ml wax tubes created via wax-creation.
 * Each batch shares a single scannable lotBarcode. Volume is tracked at
 * the batch level (Option 1): total initial volume = fullTubeCount × 12000 μL.
 * Wax-filling runs deduct 800 μL per run from remainingVolumeUl.
 */
const waxBatchSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	lotNumber: { type: String, required: true }, // WAX-YYYY-NNNN
	lotBarcode: { type: String, required: true }, // scannable barcode label on tubes
	initialVolumeUl: { type: Number, required: true },
	remainingVolumeUl: { type: Number, required: true },
	fullTubeCount: { type: Number, required: true },
	partialTubeMl: { type: Number, default: 0 },
	sourceReceivingLotId: { type: String, index: true },
	createdBy: { _id: String, username: String },
	usageLog: {
		type: [{
			_id: { type: String, default: () => generateId() },
			runId: String,
			volumeChangedUl: Number,
			remainingBeforeUl: Number,
			remainingAfterUl: Number,
			operator: { _id: String, username: String },
			notes: String,
			createdAt: { type: Date, default: () => new Date() }
		}],
		default: []
	}
}, { timestamps: true });

waxBatchSchema.index({ lotBarcode: 1 }, { unique: true });
waxBatchSchema.index({ lotNumber: 1 });
waxBatchSchema.index({ createdAt: -1 });

export const WaxBatch = mongoose.models.WaxBatch
	|| mongoose.model('WaxBatch', waxBatchSchema, 'wax_batches');
