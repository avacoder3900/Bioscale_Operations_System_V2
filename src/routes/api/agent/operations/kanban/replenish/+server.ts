import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB } from '$lib/server/db';
import { replenish, ReplenishError } from '$lib/server/kanban/replenish';
import type { RequestHandler } from './$types';

/**
 * KB2-02: THE commitment point. Promote Tier 1 options into the global ready
 * queue. Only a human commits — `actor` must be an active user holding
 * kanban:replenish (the human driving Claude counts; Claude is the channel).
 */
export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();
	const body = await request.json();
	const { taskIds, actor, note } = body;

	if (!Array.isArray(taskIds) || taskIds.length === 0) {
		return json({ success: false, error: 'taskIds (ordered array) is required' }, { status: 400 });
	}

	try {
		const result = await replenish({ taskIds, actorUsername: actor, via: 'mcp', note });
		return json({ success: true, data: result });
	} catch (e) {
		if (e instanceof ReplenishError) {
			const status = e.code === 'PERMISSION_DENIED' ? 403 : e.code === 'ACTOR_INVALID' ? 401 : 400;
			return json({ success: false, error: e.message, code: e.code }, { status });
		}
		throw e;
	}
};
