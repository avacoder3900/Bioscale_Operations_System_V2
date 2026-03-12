/**
 * Full robot info (health + pipettes + modules + calibration).
 * GET /api/opentrons-lab/robots/:id/info
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/auth/permissions';
import { getRobotFullInfo } from '$lib/server/services/opentrons/robot-info';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	await requirePermission(locals.user, 'manufacturing:read');

	const info = await getRobotFullInfo(params.id);
	return json(info);
};
