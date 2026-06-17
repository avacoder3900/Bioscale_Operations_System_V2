import mongoose, { Schema } from 'mongoose';

/**
 * Sample — research-v2 collection, shared Mongo Atlas. Read-only mirror.
 * Each sample has experimentId, analyteId, concentration, diluent, matrix.
 */
const sampleSchema = new Schema(
	{
		_id: String,
		experimentId: String,
		sampleNumber: Number,
		concentration: Number,
		diluent: String,
		matrix: String,
		analyteId: String,
		analyteName: String,
		description: String
	},
	{ strict: false, timestamps: true }
);

export const Sample =
	mongoose.models.Sample || mongoose.model('Sample', sampleSchema, 'samples');
