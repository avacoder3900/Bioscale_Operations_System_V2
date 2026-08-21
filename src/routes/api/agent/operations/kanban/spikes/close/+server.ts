import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB } from '$lib/server/db';
import { closeSpike } from '$lib/server/kanban/process';
import { TransitionError } from '$lib/server/kanban/transition';
import type { RequestHandler } from './$types';

/**
 * KB2-07: close a spike. Records the outcome ("still unknown" is valid) and
 * files any new knowledge as captured/discovered options — a spike's output
 * is options, never tasks.
 */
export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();
	const body = await request.json();
	const { taskId, actor, outcome, spawnOptions } = body;

	if (!taskId) return json({ success: false, error: 'taskId is required' }, { status: 400 });
	if (!actor?.trim()) return json({ success: false, error: 'actor (username) is required' }, { status: 400 });

	try {
		const result = await closeSpike({ taskId, actorUsername: actor.trim(), via: 'mcp', outcome, spawnOptions });
		return json({ success: true, data: result });
	} catch (e) {
		if (e instanceof TransitionError) {
			return json({ success: false, error: e.message, code: e.code }, { status: e.code === 'NOT_FOUND' ? 404 : 400 });
		}
		throw e;
	}
};
