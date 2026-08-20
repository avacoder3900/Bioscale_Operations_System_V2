import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB } from '$lib/server/db';
import { processTask } from '$lib/server/kanban/process';
import { TransitionError } from '$lib/server/kanban/transition';
import type { RequestHandler } from './$types';

/**
 * KB2-03: processing (triage). captured → processed with sizeClass +
 * classOfService set by the person processing — not the author, not the
 * eventual assignee.
 */
export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();
	const body = await request.json();
	const { taskId, actor, sizeClass, classOfService, dueDate, dor, estimateDays } = body;

	if (!taskId) return json({ success: false, error: 'taskId is required' }, { status: 400 });
	if (!actor?.trim()) return json({ success: false, error: 'actor (username of the person processing) is required' }, { status: 400 });
	if (!sizeClass || !classOfService) {
		return json({ success: false, error: 'sizeClass and classOfService are both required at processing' }, { status: 400 });
	}

	try {
		const result = await processTask({
			taskId,
			actorUsername: actor.trim(),
			via: 'mcp',
			sizeClass,
			estimateDays: typeof estimateDays === 'number' && estimateDays > 0 ? estimateDays : undefined,
			classOfService,
			dueDate: dueDate ? new Date(dueDate) : undefined,
			dor
		});
		return json({ success: true, data: result });
	} catch (e) {
		if (e instanceof TransitionError) {
			return json({ success: false, error: e.message, code: e.code }, { status: e.code === 'NOT_FOUND' ? 404 : 400 });
		}
		throw e;
	}
};
