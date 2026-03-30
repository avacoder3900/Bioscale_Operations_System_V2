import { json, error } from '@sveltejs/kit';
import { connectDB, KanbanTask, KanbanProject, AuditLog } from '$lib/server/db';
import { generateId } from '$lib/server/db/utils.js';
import { requireAgentApiKey } from '$lib/server/api-auth';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const body = await request.json();
	const { title, projectId, description, status, prioritized, taskLength, assignedTo, dueDate, source, sourceRef, tags, parentTaskId } = body;

	if (!title?.trim()) throw error(400, 'title is required');
	if (!projectId) throw error(400, 'projectId is required');

	const project = await KanbanProject.findById(projectId).lean() as any;
	if (!project) throw error(404, 'Project not found');

	let assignee = null;
	if (assignedTo) {
		const { User } = await import('$lib/server/db');
		const u = await User.findById(assignedTo).lean() as any;
		if (u) assignee = { _id: u._id, username: u.username };
	}

	if (parentTaskId) {
		const parent = await KanbanTask.findById(parentTaskId).lean();
		if (!parent) throw error(404, 'Parent task not found');
	}

	const taskId = generateId();
	const now = new Date();
	const taskStatus = status || 'backlog';

	const task = await KanbanTask.create({
		_id: taskId,
		title: title.trim(),
		description: description || undefined,
		status: taskStatus,
		prioritized: prioritized === true,
		taskLength: taskLength || 'medium',
		project: { _id: project._id, name: project.name, color: project.color },
		assignee,
		dueDate: dueDate ? new Date(dueDate) : undefined,
		source: source || 'agent',
		sourceRef: sourceRef || undefined,
		tags: tags || [],
		parentTaskId: parentTaskId || undefined,
		statusChangedAt: now,
		createdBy: 'agent'
	});

	await AuditLog.create({
		_id: generateId(),
		tableName: 'kanban_tasks',
		recordId: taskId,
		action: 'INSERT',
		newData: { title: title.trim(), status: taskStatus, projectId, source: source || 'agent' },
		changedBy: 'agent',
		changedAt: now
	});

	return json({
		success: true,
		data: {
			id: task._id,
			title: task.title,
			status: task.status,
			prioritized: task.prioritized ?? false,
			projectId: project._id,
			parentTaskId: parentTaskId || null,
			createdAt: task.createdAt
		}
	}, { status: 201 });
};
