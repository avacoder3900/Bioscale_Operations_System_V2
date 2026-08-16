import mongoose, { Schema } from 'mongoose';

/**
 * Kanban policy singleton (_id:'default') — every tunable limit of the
 * two-tier system (KB2-02/04). Enforced invariants read at runtime;
 * adjustable via admin UI / MCP without a deploy. Numbers are SEEDS to be
 * recomputed from measured flow (see recalibrateAfter).
 */
const kanbanPolicySchema = new Schema(
	{
		_id: { type: String, default: 'default' },
		// KB2-16: one board, one queue — the per-board policy blocks collapsed to
		// a single top-level pair (migration copies the old boards.ops values).
		readyCap: { type: Number, default: 8 },
		minOrderPoint: { type: Number, default: 3 },
		wipPerPerson: { type: Number, default: 2 }, // one human, one limit
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
			short: { type: String, default: 'Fits in a day or less of focused work. Known steps (orders, quick fixes, single measurements).' },
			medium: { type: String, default: 'A few days; one person; no unknown unknowns. Most milestone-sized engineering work.' },
			long: {
				type: String,
				default:
					'A week-plus or multiple people. Before picking this, apply the sizing test: if you cannot confidently size it, split to the next nameable milestone, or timebox a spike — projects never enter the queue, their milestones do. Size is a measurement bucket, never a time promise (SLEs are computed from history).'
			}
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
