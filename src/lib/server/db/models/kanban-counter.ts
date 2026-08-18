import mongoose, { Schema } from 'mongoose';

/**
 * Monotonic sequence source for human-facing kanban tracking numbers (TASK-001).
 *
 * One document per sequence name, `_id` IS the name ('task'). Allocation is a
 * single atomic `$inc` with `upsert` — never read-then-write, so two concurrent
 * captures can never be handed the same number.
 *
 * The number is cosmetic identity only: `_id` (nanoid) remains the real key for
 * every relation, link and route. Deleting a task does NOT reclaim its number.
 */
const kanbanCounterSchema = new Schema({
	_id: { type: String }, // sequence name
	seq: { type: Number, default: 0 }
});

export const KanbanCounter =
	mongoose.models.KanbanCounter ||
	mongoose.model('KanbanCounter', kanbanCounterSchema, 'kanban_counters');

/**
 * Allocate the next tracking number. Atomic; safe under concurrency.
 * Format: TASK-001, zero-padded to 3 and growing naturally past 999.
 */
export async function nextTrackingNumber(sequence = 'task'): Promise<string> {
	const doc = await KanbanCounter.findByIdAndUpdate(
		sequence,
		{ $inc: { seq: 1 } },
		{ new: true, upsert: true, setDefaultsOnInsert: true }
	).lean();
	const n: number = (doc as any)?.seq ?? 1;
	return `${sequence.toUpperCase()}-${String(n).padStart(3, '0')}`;
}
