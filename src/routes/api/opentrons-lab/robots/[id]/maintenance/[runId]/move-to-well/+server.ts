/**
 * Move the pipette to a well's nominal position inside a maintenance run
 * (DECK-CALIBRATION-STUDIO "move to hole"). Requires the labware to have been
 * loaded first via .../load-labware.
 * POST /api/opentrons-lab/robots/:id/maintenance/:runId/move-to-well
 * Body: { pipetteId: string, labwareId: string, wellName: string, zOffsetMm?: number, minimumZHeight?: number }
 * minimumZHeight (deck mm) makes the move a safe arc — lift up, travel, descend.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot } from '$lib/server/opentrons/proxy';
import { moveToWell } from '$lib/server/opentrons/maintenance';

export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	const body = await request.json().catch(() => ({}) as any);
	const pipetteId = body?.pipetteId;
	const labwareId = body?.labwareId;
	const wellName = body?.wellName;
	const zOffsetMm = typeof body?.zOffsetMm === 'number' ? body.zOffsetMm : undefined;
	const minimumZHeight = typeof body?.minimumZHeight === 'number' ? body.minimumZHeight : undefined;
	if (!pipetteId || typeof pipetteId !== 'string') error(400, 'pipetteId required');
	if (!labwareId || typeof labwareId !== 'string') error(400, 'labwareId required');
	if (!wellName || typeof wellName !== 'string') error(400, 'wellName required');

	try {
		await moveToWell(robot, params.runId, pipetteId, labwareId, wellName, { zOffsetMm, minimumZHeight });
		return json({ ok: true });
	} catch (e) {
		console.error('[API] move-to-well error:', e instanceof Error ? e.message : e);
		error(502, e instanceof Error ? e.message : 'Failed to move to well');
	}
};
