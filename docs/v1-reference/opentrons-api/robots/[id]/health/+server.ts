/**
 * Live health check for a robot.
 * GET /api/opentrons-lab/robots/:id/health
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/auth/permissions';
import { checkRobotHealth } from '$lib/server/services/opentrons/robot-info';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	await requirePermission(locals.user, 'manufacturing:read');

	const result = await checkRobotHealth(params.id);
	return json(result);
};
