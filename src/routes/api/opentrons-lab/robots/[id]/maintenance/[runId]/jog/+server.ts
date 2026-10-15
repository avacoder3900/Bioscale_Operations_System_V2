/**
 * Jog (relative move) on a single axis inside a maintenance run.
 * POST /api/opentrons-lab/robots/:id/maintenance/:runId/jog
 * Body: { pipetteId: string, axis: 'x'|'y'|'leftZ'|'rightZ', distance: number }
 */

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot } from '$lib/server/opentrons/proxy';
import { verbResponse } from '$lib/server/opentrons/transport';

export const config = { maxDuration: 45 };

// Validation + robot command + response shape live in $lib/opentrons/ot2-protocol
// ('mx.jog'), shared with the browser's tailnet line (OT2-TAILNET-4).
export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	const body = await request.json().catch(() => ({}) as any);
	return verbResponse(robot, 'mx.jog', { ...body, runId: params.runId });
};
