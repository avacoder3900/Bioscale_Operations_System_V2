import { json, error } from '@sveltejs/kit';
import { connectDB, KanbanTask } from '$lib/server/db';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { TransitionError } from '$lib/server/kanban/transition';
import { captureOptionsFromBody, captureOne } from '$lib/server/kanban/agent-shapes';
import type { RequestHandler } from './$types';

/**
 * Capture one Tier 1 option (kanban_capture). body.status is deliberately
 * ignored — every new item is captured; entering the Board happens only through
 * replenishment (KB2-02). Accepts dor / links / blockedBy at capture
 * (MCP-IMPROVEMENTS P0-1, P1-4) and echoes the stored task (P2-6.1).
 */
export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const body = await request.json();
	const { title, actor, parentTaskId } = body;

	if (!title?.trim() && !body.templateId) throw error(400, 'title is required (unless capturing from a template)');

	if (parentTaskId) {
		const parent = await KanbanTask.findById(parentTaskId).lean();
		if (!parent) throw error(404, 'Parent task not found');
	}

	const actorName = typeof actor === 'string' && actor.trim() ? actor.trim() : 'agent';

	// KB2-11: capture from a workflow template — lands processed + DoR-complete.
	if (typeof body.templateId === 'string' && body.templateId.trim()) {
		const { captureFromTemplate } = await import('$lib/server/kanban/process');
		try {
			const result = await captureFromTemplate({
				templateId: body.templateId.trim(),
				actorUsername: actorName,
				via: 'agent-api',
				title: typeof title === 'string' ? title : undefined,
				dueDate: body.dueDate ? new Date(body.dueDate) : undefined
			});
			return json({ success: true, data: { id: result.taskId, title: result.title, status: 'processed', template: result.templateName } }, { status: 201 });
		} catch (e) {
			if (e instanceof TransitionError) throw error(400, e.message);
			throw e;
		}
	}

	try {
		const opts = await captureOptionsFromBody(body, { username: actorName, via: 'agent-api' });
		const data = await captureOne(opts);
		return json({ success: true, data }, { status: 201 });
	} catch (e) {
		if (e instanceof TransitionError) throw error(400, e.message);
		throw e;
	}
};
