/**
 * Read current gantry position from a maintenance run.
 * POST /api/opentrons-lab/robots/:id/maintenance/:runId/position
 * Body: { pipetteId: string }
 *
 * Uses the OT-2 savePosition command to get a reliable XYZ readback after
 * a jog or moveTo. Modeled as POST (not GET) because savePosition mutates
 * robot run state on the OT-2 side.
 */

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot } from '$lib/server/opentrons/proxy';
import { verbResponse } from '$lib/server/opentrons/transport';

export const config = { maxDuration: 45 };

// Validation + robot command + response shape live in $lib/opentrons/ot2-protocol
// ('mx.position'), shared with the browser's tailnet line (OT2-TAILNET-4).
export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	const body = await request.json().catch(() => ({}) as any);
	return verbResponse(robot, 'mx.position', { ...body, runId: params.runId });
};
