/**
 * Global ready-queue integrity helpers (KB2-02). Shared by the transition
 * service (pulls / exits from ready) and the replenishment service — kept
 * separate so the two don't import each other.
 */
import { KanbanTask, WorkflowViolation, generateId } from '$lib/server/db';
import { getKanbanPolicy, boardPolicyOf } from './policy.js';
import type { KanbanBoard } from '$lib/shared/kanban-status';

/** Renumber the global ready queue of a board to strict 1..N (no ties, no gaps). */
export async function renumberReady(board: KanbanBoard): Promise<void> {
	const items = (await KanbanTask.find({ board, status: 'ready', archived: false })
		.sort({ rank: 1 })
		.select('_id rank')
		.lean()) as any[];
	let r = 1;
	for (const t of items) {
		if (t.rank !== r) await KanbanTask.updateOne({ _id: t._id }, { $set: { rank: r } });
		r++;
	}
}

/** Below the minimum order point → emit (or auto-resolve) the replenishment signal. */
export async function checkMinOrderPoint(board: KanbanBoard): Promise<void> {
	const policy = await getKanbanPolicy();
	const { minOrderPoint } = boardPolicyOf(policy, board);
	const count = await KanbanTask.countDocuments({ board, status: 'ready', archived: false });
	const open = await WorkflowViolation.findOne({ type: 'replenishment_needed', taskId: `board:${board}`, resolved: false });
	if (count < minOrderPoint && !open) {
		await WorkflowViolation.create({
			_id: generateId(),
			type: 'replenishment_needed',
			taskId: `board:${board}`,
			description: `Ready queue on the ${board} board is at ${count} (minimum order point ${minOrderPoint}). Run replenishment before people start pulling from Tier 1 again.`,
			severity: 'high',
			timestamp: new Date()
		});
	} else if (count >= minOrderPoint && open) {
		await WorkflowViolation.updateOne(
			{ _id: open._id },
			{ $set: { resolved: true, resolvedAt: new Date(), resolvedBy: 'system:auto' } }
		);
	}
}
