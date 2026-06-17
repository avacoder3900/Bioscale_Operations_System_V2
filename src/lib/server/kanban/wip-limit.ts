/**
 * Hard cap on per-user WIP. Called before any status transition into 'wip'
 * or any assignee change that would land an existing wip task on a user at
 * their limit.
 *
 * Per PRD KANBAN-WIP-LIMIT-ENFORCEMENT: no bypass, including admins.
 */
import { connectDB, KanbanTask, User } from '$lib/server/db';

export type WipLimitCheck =
	| { ok: true }
	| {
			ok: false;
			kind: 'wip_limit_exceeded';
			assigneeId: string;
			assignee: string;
			limit: number;
			currentCount: number;
			currentTasks: { _id: string; title: string }[];
	  };

export async function checkWipLimit(
	assigneeId: string | null | undefined,
	excludeTaskId: string | null = null
): Promise<WipLimitCheck> {
	if (!assigneeId) return { ok: true };

	await connectDB();
	const user = (await User.findById(assigneeId).select('wipLimit username').lean()) as any;
	if (!user) return { ok: true }; // missing assignee record — let other validation surface this

	const limit = typeof user.wipLimit === 'number' ? user.wipLimit : 3;

	const filter: any = {
		'assignee._id': assigneeId,
		status: 'wip',
		archived: false
	};
	if (excludeTaskId) filter._id = { $ne: excludeTaskId };

	const currentWipTasks = (await KanbanTask.find(filter).select('_id title').lean()) as any[];
	const currentCount = currentWipTasks.length;

	if (currentCount >= limit) {
		return {
			ok: false,
			kind: 'wip_limit_exceeded',
			assigneeId,
			assignee: user.username ?? assigneeId,
			limit,
			currentCount,
			currentTasks: currentWipTasks.map((t) => ({ _id: t._id, title: t.title }))
		};
	}

	return { ok: true };
}
