import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB } from '$lib/server/db';
import { flowMetrics } from '$lib/server/kanban/flow-metrics';
import type { RequestHandler } from './$types';

/**
 * KB2-05: flow metrics — Work Item Age (+SLE bands, flow-debt flags),
 * discovered-work ratio, throughput trend, expedite rate, flow efficiency.
 * NO per-person aggregates, by design (enforced in the metrics module).
 */
export const GET: RequestHandler = async ({ request, url }) => {
	requireAgentApiKey(request);
	await connectDB();
	const board = url.searchParams.get('board') === 'software' ? 'software' : 'ops';
	const data = await flowMetrics(board);
	return json({ success: true, data: JSON.parse(JSON.stringify(data)) });
};
