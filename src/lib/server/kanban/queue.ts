/**
 * Global ready-queue integrity helpers (KB2-02). Shared by the transition
 * service (pulls / exits from ready) and the replenishment service — kept
 * separate so the two don't import each other.
 */
import { KanbanTask, WorkflowViolation, generateId } from '$lib/server/db';
import { getKanbanPolicy, queuePolicyOf } from './policy.js';

// KB2-16: legacy per-board signal ids kept in the lookup so open pre-migration
// violations still auto-resolve instead of dangling forever.
const QUEUE_SIGNAL_IDS = ['queue:ready', 'board:ops', 'board:software'];

/** Renumber the global ready queue to strict 1..N (no ties, no gaps). */
export async function renumberReady(): Promise<void> {
	const items = (await KanbanTask.find({ status: 'ready', archived: false })
		.sort({ rank: 1, createdAt: 1 })
		.select('_id rank')
		.lean()) as any[];
	let r = 1;
	for (const t of items) {
		if (t.rank !== r) await KanbanTask.updateOne({ _id: t._id }, { $set: { rank: r } });
		r++;
	}
}

/** Below the minimum order point → emit (or auto-resolve) the replenishment signal. */
export async function checkMinOrderPoint(): Promise<void> {
	const policy = await getKanbanPolicy();
	const { minOrderPoint } = queuePolicyOf(policy);
	const count = await KanbanTask.countDocuments({ status: 'ready', archived: false });
	const open = await WorkflowViolation.findOne({ type: 'replenishment_needed', taskId: { $in: QUEUE_SIGNAL_IDS }, resolved: false });
	if (count < minOrderPoint && !open) {
		await WorkflowViolation.create({
			_id: generateId(),
			type: 'replenishment_needed',
			taskId: 'queue:ready',
			description: `Ready queue is at ${count} (minimum order point ${minOrderPoint}). Run replenishment before people start pulling from Tier 1 again.`,
			severity: 'high',
			timestamp: new Date()
		});
	} else if (count >= minOrderPoint && open) {
		await WorkflowViolation.updateMany(
			{ type: 'replenishment_needed', taskId: { $in: QUEUE_SIGNAL_IDS }, resolved: false },
			{ $set: { resolved: true, resolvedAt: new Date(), resolvedBy: 'system:auto' } }
		);
	}
}
