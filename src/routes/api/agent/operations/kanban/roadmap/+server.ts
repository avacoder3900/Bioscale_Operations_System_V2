import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { computeRoadmap } from '$lib/server/kanban/schedule';
import type { RequestHandler } from './$types';

/**
 * KB2-28 — the derived roadmap (kanban_roadmap). Recomputed fresh per call:
 * CPM backward/forward pass per dated milestone + capacity clamp, slack,
 * critical chain, must-start list, buffer burn, calibration. All dates in the
 * result are OUTPUTS — nothing here is ever written to tasks.
 */
export const GET: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	const data = await computeRoadmap();
	return json({ success: true, data });
};
