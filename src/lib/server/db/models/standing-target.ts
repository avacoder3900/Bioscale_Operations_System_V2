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
		metric: {
			// reagent_stock: ReagentInventory items (research-v2 shared collection).
			// Future chemistry inventory systems: add a kind here + a computeActual case
			// in src/lib/server/kanban/standing.ts — that is the whole extension contract (KB2-13).
			kind: { type: String, enum: ['cartridge_phase_count', 'part_stock', 'reagent_stock', 'manual'], required: true },
			params: Schema.Types.Mixed // cartridge_phase_count: {statuses:[...], skus?:[...]} | part_stock: {partId} | reagent_stock: {catalogId?, variantKey?, type?, statuses?, measure?} | manual: {value}
		},
		target: { type: Number, required: true },
		reorderPoint: { type: Number, required: true }, // below this → spawn a build option
		batchSize: { type: Number, required: true }, // suggested build quantity per signal
		spawnItemType: { type: String, enum: ['chore', 'deliverable'], default: 'deliverable' },
		// KB2-13 supply loops: system-spawned cards are auto-shaped and auto-committed
		// straight to the bottom of the ready queue (Jacob's decision — scoped exception
		// to the human-only commitment point). Set false to restore KB2-10 behavior
		// (captured option through the normal commitment point).
		autoCommit: { type: Boolean, default: true },
		spawnSizeClass: { type: String, enum: ['short', 'medium', 'long'], default: 'short' },
		// Optional KanbanTemplate link — when set, the template's shape (itemType,
		// sizeClass, classOfService, dor, tags) wins over the auto-generated shape.
		templateId: String,
		active: { type: Boolean, default: true },
		notes: String,
		createdBy: String
	},
	{ timestamps: true }
);

export const StandingTarget =
	mongoose.models.StandingTarget || mongoose.model('StandingTarget', standingTargetSchema, 'kanban_standing_targets');
