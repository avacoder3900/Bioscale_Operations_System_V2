import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { renameTag } from '$lib/server/kanban/tags';
import type { RequestHandler } from './$types';

/**
 * Bulk tag rename / removal (MCP-IMPROVEMENTS P1-3, kanban_rename_tag).
 * body: { from, to (string | null = remove), scope?: 'active' | 'all', actor }
 */
export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const body = await request.json();
	const { from, to, scope, actor } = body;
	if (typeof from !== 'string' || !from.trim()) throw error(400, '`from` tag is required');
	if (to !== null && to !== undefined && typeof to !== 'string') throw error(400, '`to` must be a string or null');
	if (scope !== undefined && scope !== 'active' && scope !== 'all') throw error(400, "scope must be 'active' or 'all'");
	const actorName = typeof actor === 'string' && actor.trim() ? actor.trim() : 'agent';

	const result = await renameTag({
		from,
		to: to === undefined || to === '' ? null : to,
		scope,
		actor: { username: actorName, via: 'agent-api' }
	});
	return json({ success: true, data: result });
};
