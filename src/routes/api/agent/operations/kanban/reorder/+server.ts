import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB } from '$lib/server/db';
import { reorder, ReplenishError } from '$lib/server/kanban/replenish';
import type { RequestHandler } from './$types';

/**
 * KB2-02: explicit, audited re-rank. scope 'ready' = the global commitment
 * order (actor needs kanban:replenish); scope 'tier1' = the global Tier 1
 * option order (KB2-16 — the legacy {projectId} shape maps to 'tier1').
 */
export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();
	const body = await request.json();
	const { orderedTaskIds, actor } = body;
	const scope = body.scope === 'ready' ? 'ready' : body.scope === 'tier1' || body.scope?.projectId ? 'tier1' : null;

	if (!Array.isArray(orderedTaskIds) || orderedTaskIds.length === 0) {
		return json({ success: false, error: 'orderedTaskIds is required' }, { status: 400 });
	}
	if (!scope) {
		return json({ success: false, error: "scope must be 'ready' or 'tier1'" }, { status: 400 });
	}
	if (!actor?.trim()) {
		return json({ success: false, error: 'actor (username) is required' }, { status: 400 });
	}

	try {
		const result = await reorder({ scope, orderedTaskIds, actorUsername: actor, via: 'mcp' });
		return json({ success: true, data: result });
	} catch (e) {
		if (e instanceof ReplenishError) {
			const status = e.code === 'PERMISSION_DENIED' ? 403 : e.code === 'ACTOR_INVALID' ? 401 : 400;
			return json({ success: false, error: e.message, code: e.code }, { status });
		}
		throw e;
	}
};
