import { json, error } from '@sveltejs/kit';
import { connectDB, KanbanTask, KanbanProject } from '$lib/server/db';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { createKanbanItem, TransitionError } from '$lib/server/kanban/transition';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const body = await request.json();
	// NOTE: body.status is deliberately ignored — every new item is captured
	// (Tier 1). Entering Tier 2 happens only through replenishment (KB2-02).
	const { title, projectId, description, assignedTo, dueDate, source, sourceRef, tags, parentTaskId, actor } = body;

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

	const actorName = typeof actor === 'string' && actor.trim() ? actor.trim() : 'agent';

	let task: any;
	try {
		task = await createKanbanItem({
			title,
			description: description || undefined,
			project: { _id: project._id, name: project.name, color: project.color },
			assignee,
			dueDate: dueDate ? new Date(dueDate) : undefined,
			source: source || 'agent',
			sourceRef: sourceRef || undefined,
			tags: tags || [],
			parentTaskId: parentTaskId || undefined,
			actor: { username: actorName, via: 'agent-api' }
		});
	} catch (e) {
		if (e instanceof TransitionError) throw error(400, e.message);
		throw e;
	}

	return json({
		success: true,
		data: {
			id: task._id,
			title: task.title,
			status: task.status,
			projectId: project._id,
			parentTaskId: parentTaskId || null,
			createdAt: task.createdAt
		}
	}, { status: 201 });
};
