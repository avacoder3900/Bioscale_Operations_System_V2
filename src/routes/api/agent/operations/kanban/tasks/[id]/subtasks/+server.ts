import { json, error } from '@sveltejs/kit';
import { connectDB, KanbanTask, KanbanProject, AuditLog } from '$lib/server/db';
import { generateId } from '$lib/server/db/utils.js';
import { requireAgentApiKey } from '$lib/server/api-auth';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, params }) => {
	requireAgentApiKey(request);
	await connectDB();

	const { id: parentTaskId } = params;
	const parent = await KanbanTask.findById(parentTaskId).lean() as any;
	if (!parent) throw error(404, 'Parent task not found');

	const body = await request.json();
	const { subtasks } = body;

	if (!Array.isArray(subtasks) || subtasks.length === 0) {
		throw error(400, 'subtasks array is required and must not be empty');
	}

	const now = new Date();
	const created: any[] = [];

	for (const sub of subtasks) {
		if (!sub.title?.trim()) throw error(400, 'Each subtask requires a title');

		const taskId = generateId();
		const task = await KanbanTask.create({
			_id: taskId,
			title: sub.title.trim(),
			description: sub.description || undefined,
			status: sub.status || 'backlog',
			prioritized: sub.prioritized === true || parent.prioritized === true,
			taskLength: sub.taskLength || 'short',
			project: parent.project,
			assignee: parent.assignee,
			tags: sub.tags || parent.tags || [],
			source: 'agent',
			sourceRef: sub.sourceRef || undefined,
			parentTaskId,
			statusChangedAt: now,
			createdBy: 'agent'
		});

		await AuditLog.create({
			_id: generateId(),
			tableName: 'kanban_tasks',
			recordId: taskId,
			action: 'INSERT',
			newData: { title: sub.title.trim(), parentTaskId, source: 'agent' },
			changedBy: 'agent',
			changedAt: now
		});

		created.push({
			id: task._id,
			title: task.title,
			status: task.status,
			parentTaskId
		});
	}

	return json({
		success: true,
		data: {
			parentTaskId,
			parentTitle: parent.title,
			subtasks: created
		}
	}, { status: 201 });
};
