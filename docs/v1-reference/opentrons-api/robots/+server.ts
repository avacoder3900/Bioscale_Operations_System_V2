/**
 * Robot CRUD — List all robots / Register new robot.
 * GET  /api/opentrons-lab/robots
 * POST /api/opentrons-lab/robots
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/auth/permissions';
import { listRobots, registerRobot } from '$lib/server/services/opentrons/robot-registry';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	await requirePermission(locals.user, 'manufacturing:read');

	const robots = await listRobots();
	return json(robots);
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	await requirePermission(locals.user, 'manufacturing:write');

	const body = await request.json();
	const { name, ip, port, robotSide, legacyRobotId } = body;

	if (!name || !ip) {
		error(400, 'name and ip are required');
	}

	const robot = await registerRobot(
		{ name, ip, port, robotSide, legacyRobotId },
		locals.user.id
	);
	return json(robot, { status: 201 });
};
