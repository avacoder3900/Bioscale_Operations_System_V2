import { json, error } from '@sveltejs/kit';
import { connectDB, KanbanTask } from '$lib/server/db';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { createKanbanItem, TransitionError } from '$lib/server/kanban/transition';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const body = await request.json();
	// NOTE: body.status is deliberately ignored — every new item is captured
	// (Tier 1). Entering Tier 2 happens only through replenishment (KB2-02).
	// KB2-16: projectId/board are gone — tags carry both jobs.
	const { title, description, assignedTo, dueDate, source, sourceRef, tags, parentTaskId, actor, origin, spawnedFrom, itemType, spike } = body;

	if (!title?.trim() && !body.templateId) throw error(400, 'title is required (unless capturing from a template)');

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

	// KB2-11: capture from a workflow template — lands processed + DoR-complete.
	if (typeof body.templateId === 'string' && body.templateId.trim()) {
		const { captureFromTemplate } = await import('$lib/server/kanban/process');
		const { TransitionError } = await import('$lib/server/kanban/transition');
		try {
			const result = await captureFromTemplate({
				templateId: body.templateId.trim(),
				actorUsername: actorName,
				via: 'agent-api',
				title: typeof title === 'string' ? title : undefined,
				dueDate: dueDate ? new Date(dueDate) : undefined
			});
			return json({ success: true, data: { id: result.taskId, title: result.title, status: 'processed', template: result.templateName } }, { status: 201 });
		} catch (e) {
			if (e instanceof TransitionError) throw error(400, e.message);
			throw e;
		}
	}

	let task: any;
	try {
		task = await createKanbanItem({
			title,
			description: description || undefined,
			origin: origin === 'discovered' ? 'discovered' : 'planned',
			spawnedFrom: spawnedFrom || undefined,
			itemType: ['deliverable', 'spike', 'chore'].includes(itemType) ? itemType : undefined,
			spike: spike || undefined,
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
			tags: task.tags ?? [],
			parentTaskId: parentTaskId || null,
			createdAt: task.createdAt
		}
	}, { status: 201 });
};
