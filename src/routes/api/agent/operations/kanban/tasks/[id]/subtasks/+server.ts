import { json, error } from '@sveltejs/kit';
import { connectDB, KanbanTask } from '$lib/server/db';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { createKanbanItem, TransitionError } from '$lib/server/kanban/transition';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, params }) => {
	requireAgentApiKey(request);
	await connectDB();

	const { id: parentTaskId } = params;
	const parent = await KanbanTask.findById(parentTaskId).lean() as any;
	if (!parent) throw error(404, 'Parent task not found');

	const body = await request.json();
	const { subtasks, actor } = body;

	if (!Array.isArray(subtasks) || subtasks.length === 0) {
		throw error(400, 'subtasks array is required and must not be empty');
	}

	const actorName = typeof actor === 'string' && actor.trim() ? actor.trim() : 'agent';
	const created: any[] = [];

	for (const sub of subtasks) {
		if (!sub.title?.trim()) throw error(400, 'Each subtask requires a title');

		// Every subtask is captured (Tier 1) — sub.status is deliberately ignored.
		let task: any;
		try {
			task = await createKanbanItem({
				title: sub.title,
				description: sub.description || undefined,
				project: parent.project ?? null,
				assignee: parent.assignee ?? null,
				tags: sub.tags || parent.tags || [],
				source: 'agent',
				sourceRef: sub.sourceRef || undefined,
				parentTaskId,
				actor: { username: actorName, via: 'agent-api' }
			});
		} catch (e) {
			if (e instanceof TransitionError) throw error(400, e.message);
			throw e;
		}

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
