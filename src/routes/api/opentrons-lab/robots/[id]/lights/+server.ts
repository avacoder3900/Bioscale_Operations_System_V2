/**
 * Get/set robot rail lights.
 * GET  /api/opentrons-lab/robots/:id/lights
 * POST /api/opentrons-lab/robots/:id/lights
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot, robotGet, robotPost } from '$lib/server/opentrons/proxy';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	try {
		const res = await robotGet(robot, '/robot/lights');
		const data = await res.json();
		return json(data);
	} catch (e) {
		error(502, `Failed to reach robot: ${e instanceof Error ? e.message : 'unknown'}`);
	}
};

export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	const { on } = await request.json();

	try {
		const res = await robotPost(robot, '/robot/lights', { on });
		const data = await res.json();
		return json(data);
	} catch (e) {
		error(502, `Failed to reach robot: ${e instanceof Error ? e.message : 'unknown'}`);
	}
};
