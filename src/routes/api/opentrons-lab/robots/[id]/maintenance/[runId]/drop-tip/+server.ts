/**
 * Drop the tip the maintenance run currently models into the fixed trash.
 * POST /api/opentrons-lab/robots/:id/maintenance/:runId/drop-tip
 * Body: { pipetteId }
 * Returns: { dropped: boolean } — false when the engine modelled no tip (a tip
 * pushed on by hand is invisible to it and must come off by hand).
 */
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot } from '$lib/server/opentrons/proxy';
import { verbResponse } from '$lib/server/opentrons/transport';

export const config = { maxDuration: 60 };

// Validation + robot command + response shape live in $lib/opentrons/ot2-protocol
// ('mx.dropTip'), shared with the browser's tailnet line (OT2-TAILNET-4).
export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	const body = await request.json().catch(() => ({}) as any);
	return verbResponse(robot, 'mx.dropTip', { ...body, runId: params.runId });
};
