/**
 * Close a maintenance run on the OT-2.
 * DELETE /api/opentrons-lab/robots/:id/maintenance/:runId
 */

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot } from '$lib/server/opentrons/proxy';
import { verbResponse } from '$lib/server/opentrons/transport';

// Closing routes through the bridge (up to ~30s); exceed Vercel's ~10s default.
export const config = { maxDuration: 45 };

// 'mx.close' + AuditLog maintenance_run_close — shared with the tailnet line.
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	return verbResponse(robot, 'mx.close', { runId: params.runId }, locals.user);
};
