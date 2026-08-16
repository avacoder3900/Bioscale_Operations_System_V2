/**
 * Hard cap on per-user WIP (KB2-04). Called by the transition service before
 * any status transition into 'wip' or any assignee change that would land an
 * existing wip task on a user at their limit.
 *
 * The limit lives in KanbanPolicy.wipPerPerson — one human, one limit
 * (replaces the old per-user `user.wipLimit` field). At most
 * KanbanPolicy.wipChoreMax of a person's WIP may be chores. Per PRD
 * KANBAN-WIP-LIMIT-ENFORCEMENT: no bypass, including admins. Per-person WIP
 * is a limit, not a score.
 */
import { connectDB, KanbanTask, User } from '$lib/server/db';
import { getKanbanPolicy } from './policy.js';

export type WipLimitCheck =
	| { ok: true }
	| {
			ok: false;
			kind: 'wip_limit_exceeded' | 'chore_limit_exceeded';
			assigneeId: string;
			assignee: string;
			limit: number;
			currentCount: number;
			currentTasks: { _id: string; title: string }[];
	  };

export async function checkWipLimit(
	assigneeId: string | null | undefined,
	excludeTaskId: string | null = null,
	incomingIsChore = false
): Promise<WipLimitCheck> {
	if (!assigneeId) return { ok: true };

	await connectDB();
	const user = (await User.findById(assigneeId).select('username').lean()) as any;
	if (!user) return { ok: true }; // missing assignee record — let other validation surface this

	const policy = await getKanbanPolicy();
	const limit = policy?.wipPerPerson ?? 2;
	const choreMax = policy?.wipChoreMax ?? 1;

	const filter: any = {
		'assignee._id': assigneeId,
		status: 'wip', // one human, one limit
		archived: false
	};
	if (excludeTaskId) filter._id = { $ne: excludeTaskId };

	const currentWipTasks = (await KanbanTask.find(filter).select('_id title itemType classOfService').lean()) as any[];
	// Expedite bypasses personal WIP limits by definition (it is the emergency lane).
	const counted = currentWipTasks.filter((t) => t.classOfService !== 'expedite');
	const currentCount = counted.length;

	if (currentCount >= limit) {
		return {
			ok: false,
			kind: 'wip_limit_exceeded',
			assigneeId,
			assignee: user.username ?? assigneeId,
			limit,
			currentCount,
			currentTasks: counted.map((t) => ({ _id: t._id, title: t.title }))
		};
	}

	if (incomingIsChore) {
		const chores = counted.filter((t) => t.itemType === 'chore' || t.classOfService === 'chore');
		if (chores.length >= choreMax) {
			return {
				ok: false,
				kind: 'chore_limit_exceeded',
				assigneeId,
				assignee: user.username ?? assigneeId,
				limit: choreMax,
				currentCount: chores.length,
				currentTasks: chores.map((t) => ({ _id: t._id, title: t.title }))
			};
		}
	}

	return { ok: true };
}
