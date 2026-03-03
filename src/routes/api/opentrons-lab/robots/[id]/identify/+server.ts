/**
 * Identify robot (flash lights).
 * POST /api/opentrons-lab/robots/:id/identify
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot, robotPost } from '$lib/server/opentrons/proxy';

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	try {
		// Flash lights on then off to identify the robot
		await robotPost(robot, '/robot/lights', { on: true });
		await new Promise((r) => setTimeout(r, 1000));
		await robotPost(robot, '/robot/lights', { on: false });
		return json({ ok: true });
	} catch (e) {
		error(502, `Failed to reach robot: ${e instanceof Error ? e.message : 'unknown'}`);
	}
};
