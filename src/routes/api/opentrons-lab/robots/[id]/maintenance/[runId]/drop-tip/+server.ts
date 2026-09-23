/**
 * Drop the tip the maintenance run currently models into the fixed trash.
 * POST /api/opentrons-lab/robots/:id/maintenance/:runId/drop-tip
 * Body: { pipetteId }
 * Returns: { dropped: boolean } — false when the engine modelled no tip (a tip
 * pushed on by hand is invisible to it and must come off by hand).
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot } from '$lib/server/opentrons/proxy';
import { dropTipInTrash } from '$lib/server/opentrons/maintenance';

export const config = { maxDuration: 60 };

export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	const body = await request.json().catch(() => ({}) as any);
	const pipetteId = body?.pipetteId;
	if (!pipetteId || typeof pipetteId !== 'string') error(400, 'pipetteId required');

	try {
		await dropTipInTrash(robot, params.runId, pipetteId);
		return json({ dropped: true });
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		// No tip modelled → nothing for the engine to drop. Not an error for the caller.
		if (/no tip|without a tip|does not have a tip|not.*attached/i.test(msg)) return json({ dropped: false, message: msg });
		console.error('[API] drop-tip error:', msg);
		error(502, msg || 'Failed to drop tip');
	}
};
