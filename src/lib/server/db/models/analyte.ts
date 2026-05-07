import mongoose, { Schema } from 'mongoose';

/**
 * Analyte — research-v2 collection, shared Mongo Atlas. Read-only mirror.
 * What's being measured: name, units, dynamicRange, lod, loq, referenceRange.
 */
const analyteSchema = new Schema(
	{
		_id: String,
		name: String,
		units: String,
		dynamicRange: { _id: false, low: Number, high: Number },
		lod: Number,
		loq: Number,
		referenceRange: { _id: false, low: Number, high: Number },
		description: String
	},
	{ strict: false, timestamps: true }
);

export const Analyte =
	mongoose.models.Analyte || mongoose.model('Analyte', analyteSchema, 'analytes');
