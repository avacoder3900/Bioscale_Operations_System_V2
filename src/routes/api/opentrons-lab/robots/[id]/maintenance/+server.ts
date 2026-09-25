/**
 * Open a maintenance run on the OT-2.
 * POST /api/opentrons-lab/robots/:id/maintenance
 * Body (optional): { pipetteName?: string, mount?: 'left'|'right' }
 *
 * Response: { runId, pipetteId?, pipetteName?, mount? }
 *
 * If pipetteName + mount aren't provided, the server discovers a mounted
 * pipette via the OT-2's /pipettes endpoint. A pipette is required to use
 * moveRelative / moveToCoordinates inside the run.
 */

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot } from '$lib/server/opentrons/proxy';
import { verbResponse } from '$lib/server/opentrons/transport';

// Opening a run can chain several bridge round-trips (clear stale run + discover/
// load pipette); give Vercel headroom so it isn't killed (FUNCTION_INVOCATION_TIMEOUT).
export const config = { maxDuration: 90 };

// Robot half ('mx.open': discover pipette, clear a stale run, open, load pipette)
// lives in $lib/opentrons/ot2-protocol; the AuditLog row (maintenance_run_open)
// in $lib/server/opentrons/maintenance-records — both shared with the tailnet line.
export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	const body = await request.json().catch(() => ({}) as any);
	return verbResponse(robot, 'mx.open', { mount: body?.mount }, locals.user);
};
