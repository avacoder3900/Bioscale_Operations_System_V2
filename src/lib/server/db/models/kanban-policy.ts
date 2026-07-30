import mongoose, { Schema } from 'mongoose';

/**
 * Kanban policy singleton (_id:'default') — every tunable limit of the
 * two-tier system (KB2-02/04). Enforced invariants read at runtime;
 * adjustable via admin UI / MCP without a deploy. Numbers are SEEDS to be
 * recomputed from measured flow (see recalibrateAfter).
 */
const boardPolicy = {
	readyCap: { type: Number, default: 8 },
	minOrderPoint: { type: Number, default: 3 }
};

const kanbanPolicySchema = new Schema(
	{
		_id: { type: String, default: 'default' },
		boards: {
			ops: boardPolicy,
			software: boardPolicy
		},
		wipPerPerson: { type: Number, default: 2 }, // across BOTH boards combined
		wipChoreMax: { type: Number, default: 1 },
		pullWindow: { type: Number, default: 3 }, // pull only from top-N of global ready order
		expedite: {
			systemMax: { type: Number, default: 1 },
			alertPctRolling30d: { type: Number, default: 5 }
		},
		allocation: {
			standard: { type: Number, default: 60 },
			fixed_date: { type: Number, default: 25 },
			chore: { type: Number, default: 15 } // floor AND ceiling
		},
		sizeClassDefinitions: {
			short: { type: String, default: 'Fits in a day or less of focused work.' },
			medium: { type: String, default: 'A few days; one person; no unknown unknowns.' },
			long: { type: String, default: 'A week-plus or multiple people; consider splitting or a spike first.' }
		},
		sle: {
			percentile: { type: Number, default: 85 },
			seeded: { type: Boolean, default: true },
			perSizeClassDays: {
				short: { type: Number, default: null },
				medium: { type: Number, default: 20 }, // from 19 historical samples, p85 ≈ 20d
				long: { type: Number, default: null }
			}
		},
		recalibrateAfter: Date, // nag when past due — seeds must be replaced by measured demand
		updatedBy: String,
		updatedAt: Date
	},
	{ timestamps: false, _id: false }
);

export const KanbanPolicy =
	mongoose.models.KanbanPolicy || mongoose.model('KanbanPolicy', kanbanPolicySchema, 'kanban_policy');
