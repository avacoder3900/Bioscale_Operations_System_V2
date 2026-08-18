import { json, error } from '@sveltejs/kit';
import { connectDB, KanbanTask } from '$lib/server/db';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { TransitionError } from '$lib/server/kanban/transition';
import { captureOptionsFromBody, captureOne } from '$lib/server/kanban/agent-shapes';
import type { RequestHandler } from './$types';

/**
 * Create subtasks under a parent (kanban_create_subtasks). Every subtask is
 * captured (Tier 1) — sub.status is ignored. Each element accepts the same
 * shape as a single capture (incl. dor / links / blockedBy — P0-1, P1-4);
 * assignee/tags default to the parent's when omitted.
 */
export const POST: RequestHandler = async ({ request, params }) => {
	requireAgentApiKey(request);
	await connectDB();

	const { id: parentTaskId } = params;
	const parent = (await KanbanTask.findById(parentTaskId).lean()) as any;
	if (!parent) throw error(404, 'Parent task not found');

	const body = await request.json();
	const { subtasks, actor } = body;

	if (!Array.isArray(subtasks) || subtasks.length === 0) {
		throw error(400, 'subtasks array is required and must not be empty');
	}

	const actorName = typeof actor === 'string' && actor.trim() ? actor.trim() : 'agent';
	const created: any[] = [];

	for (const sub of subtasks) {
		if (!sub?.title?.trim()) throw error(400, 'Each subtask requires a title');
		try {
			const opts = await captureOptionsFromBody(
				{ ...sub, parentTaskId, tags: sub.tags ?? parent.tags ?? [] },
				{ username: actorName, via: 'agent-api' },
				{ assignee: parent.assignee ?? null, source: 'agent' }
			);
			created.push(await captureOne(opts));
		} catch (e) {
			if (e instanceof TransitionError) throw error(400, e.message);
			throw e;
		}
	}

	return json(
		{
			success: true,
			data: {
				parentTaskId,
				parentTitle: parent.title,
				subtasks: created
			}
		},
		{ status: 201 }
	);
};
