import mongoose, { Schema } from 'mongoose';

/**
 * UdiCounter — lightweight atomic counter collection used by the UDI generator.
 *
 * Shape: `{ _id: <prefix>, sequence: <number> }`.
 *
 * The `_id` is the prefix itself (e.g. "SPU"), which guarantees a single
 * document per prefix and lets us use `findOneAndUpdate({ _id: prefix },
 * { $inc: { sequence: 1 } }, { upsert: true, new: true })` as an atomic,
 * race-safe next-sequence operation (PRD-SPU-MFG-UNIFIED §9 Q3).
 */
const udiCounterSchema = new Schema(
	{
		_id: { type: String, required: true },
		sequence: { type: Number, default: 0 }
	},
	{ timestamps: false, _id: false }
);

export const UdiCounter =
	mongoose.models.UdiCounter ||
	mongoose.model('UdiCounter', udiCounterSchema, 'udi_counters');
