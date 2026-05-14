import mongoose, { Schema } from 'mongoose';

/**
 * CalibratedAnalysis — research-v2 collection, shared Mongo Atlas. Read-only.
 * Calibration overlay on AnalysisProfile: cartridgeIds[], excludedChannels[],
 * beadBarcode, tracerBarcode, baseProfileId, correctionExponent, results.
 */
const excludedChannelSchema = new Schema(
	{ cartridgeId: String, channel: String },
	{ _id: false }
);

const calibratedAnalysisSchema = new Schema(
	{
		_id: String,
		name: String,
		description: String,
		cartridgeIds: [String],
		excludedChannels: [excludedChannelSchema],
		beadBarcode: String,
		tracerBarcode: String,
		baseProfileId: String,
		correctionExponent: Number,
		results: Schema.Types.Mixed,
		lastRunAt: String,
		lastRunBy: String
	},
	{ strict: false, timestamps: true }
);

export const CalibratedAnalysis =
	mongoose.models.CalibratedAnalysis ||
	mongoose.model('CalibratedAnalysis', calibratedAnalysisSchema, 'calibrated_analyses');
