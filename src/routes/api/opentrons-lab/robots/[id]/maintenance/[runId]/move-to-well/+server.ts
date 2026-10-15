/**
 * Move the pipette to a well's nominal position inside a maintenance run
 * (DECK-CALIBRATION-STUDIO "move to hole"). Requires the labware to have been
 * loaded first via .../load-labware.
 * POST /api/opentrons-lab/robots/:id/maintenance/:runId/move-to-well
 * Body: { pipetteId: string, labwareId: string, wellName: string, zOffsetMm?: number, minimumZHeight?: number }
 * minimumZHeight (deck mm) makes the move a safe arc — lift up, travel, descend.
 */
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot } from '$lib/server/opentrons/proxy';
import { verbResponse } from '$lib/server/opentrons/transport';

export const config = { maxDuration: 60 };

// Validation + robot command + response shape live in $lib/opentrons/ot2-protocol
// ('mx.moveToWell'), shared with the browser's tailnet line (OT2-TAILNET-4).
export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	const body = await request.json().catch(() => ({}) as any);
	return verbResponse(robot, 'mx.moveToWell', { ...body, runId: params.runId });
};
