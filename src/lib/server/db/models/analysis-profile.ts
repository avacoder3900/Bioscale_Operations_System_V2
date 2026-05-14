import mongoose, { Schema } from 'mongoose';

/**
 * AnalysisProfile — research-v2 collection, shared Mongo Atlas. Read-only.
 * Configures raw-data processing: scan groups, sum columns, ratio columns.
 */
const analysisProfileSchema = new Schema(
	{
		_id: String,
		name: String,
		description: String,
		scanGroupDetection: String,
		scanGroupLabels: [String],
		manualScanGroups: [Number],
		sumColumns: [String],
		denominatorColumn: String,
		ratioNumerators: [String],
		ratioScanGroups: [Number],
		outputColumns: [String],
		outputScanGroups: [Number],
		outputChannels: [String]
	},
	{ strict: false, timestamps: true }
);

export const AnalysisProfile =
	mongoose.models.AnalysisProfile ||
	mongoose.model('AnalysisProfile', analysisProfileSchema, 'analysis_profiles');
