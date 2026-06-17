import { json } from '@sveltejs/kit';
import { connectDB, KanbanTask } from '$lib/server/db';
import { generateId } from '$lib/server/db/utils.js';
import { requirePermission } from '$lib/server/permissions';
import { checkWipLimit } from '$lib/server/kanban/wip-limit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'kanban:write');
	await connectDB();

	const { taskId, newStatus, sortOrder } = await request.json();
	if (!taskId || !newStatus) return json({ error: 'Missing taskId or newStatus' }, { status: 400 });

	const task = await KanbanTask.findById(taskId).lean() as any;
	if (!task) return json({ error: 'Task not found' }, { status: 404 });

	// Hard WIP-limit cap (PRD KANBAN-WIP-LIMIT-ENFORCEMENT). Only relevant when
	// the new status is 'wip' and the task isn't already in wip (idempotent move).
	if (newStatus === 'wip' && task.status !== 'wip') {
		const check = await checkWipLimit(task.assignee?._id ?? null, taskId);
		if (!check.ok) return json(check, { status: 409 });
	}

	const update: any = { status: newStatus, statusChangedAt: new Date() };
	if (sortOrder !== undefined) update.sortOrder = sortOrder;

	await KanbanTask.updateOne({ _id: taskId }, {
		$set: update,
		$push: {
			activityLog: {
				_id: generateId(),
				action: 'status_change',
				details: { from: task.status, to: newStatus },
				createdAt: new Date(),
				createdBy: locals.user._id
			}
		}
	});

	return json({ success: true });
};
