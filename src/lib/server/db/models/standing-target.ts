import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * KB2-10 — standing work / supply targets (the real build queue).
 * "Always have N cartridges on hand" is a supply signal, not a flow item —
 * it never finishes, so it never sits in a queue pretending it will.
 * Actuals are computed live from BIMS collections; never stored.
 */
const standingTargetSchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },
		name: { type: String, required: true }, // "Filled cartridges on hand"
		board: { type: String, default: 'ops' },
		metric: {
			kind: { type: String, enum: ['cartridge_phase_count', 'part_stock', 'manual'], required: true },
			params: Schema.Types.Mixed // cartridge_phase_count: {statuses:[...], skus?:[...]} | part_stock: {partId} | manual: {value}
		},
		target: { type: Number, required: true },
		reorderPoint: { type: Number, required: true }, // below this → spawn a build option
		batchSize: { type: Number, required: true }, // suggested build quantity per signal
		spawnItemType: { type: String, enum: ['chore', 'deliverable'], default: 'deliverable' },
		active: { type: Boolean, default: true },
		notes: String,
		createdBy: String
	},
	{ timestamps: true }
);

export const StandingTarget =
	mongoose.models.StandingTarget || mongoose.model('StandingTarget', standingTargetSchema, 'kanban_standing_targets');
