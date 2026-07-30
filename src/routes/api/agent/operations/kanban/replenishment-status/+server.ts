import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB } from '$lib/server/db';
import { replenishmentStatus } from '$lib/server/kanban/replenish';
import type { RequestHandler } from './$types';

/**
 * KB2-02: the "should we replenish?" view — candidates with DoR readiness,
 * ready count vs cap, min-order-point signal, WIP share by class of service.
 */
export const GET: RequestHandler = async ({ request, url }) => {
	requireAgentApiKey(request);
	await connectDB();
	const board = url.searchParams.get('board') === 'software' ? 'software' : 'ops';
	const data = await replenishmentStatus(board);
	return json({ success: true, data: JSON.parse(JSON.stringify(data)) });
};
