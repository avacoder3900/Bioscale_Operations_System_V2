/**
 * Current run state — for fast polling during active runs.
 * GET /api/opentrons-lab/robots/:id/runs/:rid/state
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot, robotGet } from '$lib/server/opentrons/proxy';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	try {
		const res = await robotGet(robot, `/runs/${params.rid}`);
		const data = await res.json() as any;

		// Return a lightweight state snapshot (not the full run object)
		return json({
			id: data?.data?.id,
			status: data?.data?.status,
			currentTask: data?.data?.currentTask,
			completedAt: data?.data?.completedAt,
			startedAt: data?.data?.startedAt,
			errors: data?.data?.errors
		});
	} catch (e) {
		console.error('[API] run state error:', e instanceof Error ? e.message : e);
		error(502, 'Failed to reach robot');
	}
};
