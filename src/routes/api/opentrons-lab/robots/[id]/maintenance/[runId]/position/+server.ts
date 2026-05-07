/**
 * Read current gantry position from a maintenance run.
 * POST /api/opentrons-lab/robots/:id/maintenance/:runId/position
 * Body: { pipetteId: string }
 *
 * Uses the OT-2 savePosition command to get a reliable XYZ readback after
 * a jog or moveTo. Modeled as POST (not GET) because savePosition mutates
 * robot run state on the OT-2 side.
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot } from '$lib/server/opentrons/proxy';
import { getCurrentPosition } from '$lib/server/opentrons/maintenance';

export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	const body = await request.json().catch(() => ({} as any));
	const pipetteId = body?.pipetteId;
	if (!pipetteId || typeof pipetteId !== 'string') error(400, 'pipetteId required');

	try {
		const pos = await getCurrentPosition(robot, params.runId, pipetteId);
		if (!pos) error(502, 'Robot did not return a position');
		return json({ position: pos });
	} catch (e) {
		if ((e as any).status) throw e;
		console.error('[API] maintenance position error:', e instanceof Error ? e.message : e);
		error(502, e instanceof Error ? e.message : 'Failed to read position');
	}
};
