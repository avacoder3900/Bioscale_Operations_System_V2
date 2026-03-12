/**
 * Home robot gantry.
 * POST /api/opentrons-lab/robots/:id/home
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/auth/permissions';
import { getRobot } from '$lib/server/services/opentrons/robot-registry';
import { createOT2Client } from '$lib/server/integrations/opentrons/client';

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	await requirePermission(locals.user, 'manufacturing:write');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	const client = createOT2Client({ ip: robot.ip, port: robot.port });
	await client.homeRobot();
	return json({ ok: true });
};
