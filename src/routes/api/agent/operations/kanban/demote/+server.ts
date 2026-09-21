import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB } from '$lib/server/db';
import { demote, ReplenishError } from '$lib/server/kanban/replenish';
import type { RequestHandler } from './$types';

/** KB2-02: unwind a commitment (Tier 2 → processed). Requires actor + reason. */
export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();
	const body = await request.json();
	const { taskId, actor, reason } = body;

	if (!taskId) return json({ success: false, error: 'taskId is required' }, { status: 400 });

	try {
		const result = await demote({ taskId, actorUsername: actor, via: 'mcp', reason });
		return json({ success: true, data: result });
	} catch (e) {
		if (e instanceof ReplenishError) {
			const status =
				e.code === 'PERMISSION_DENIED' ? 403 : e.code === 'ACTOR_INVALID' ? 401 : e.code === 'NOT_FOUND' ? 404 : 400;
			return json({ success: false, error: e.message, code: e.code }, { status });
		}
		throw e;
	}
};
