import { json, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { connectDB, KanbanTask, KanbanProject, AuditLog } from '$lib/server/db';
import { generateId } from '$lib/server/db/utils.js';
import type { RequestHandler } from './$types';

function requireApiKey(request: Request) {
	const key = request.headers.get('x-api-key') || request.headers.get('x-agent-api-key') || request.headers.get('authorization')?.replace('Bearer ', '');
	if (!env.AGENT_API_KEY || key !== env.AGENT_API_KEY) {
		throw error(401, 'Invalid or missing API key');
	}
}

export const POST: RequestHandler = async ({ request, params }) => {
	requireApiKey(request);
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
			priority: sub.priority || parent.priority || 'medium',
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
