/**
 * Get robot calibration data.
 * GET /api/opentrons-lab/robots/:id/calibration
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot, robotGet } from '$lib/server/opentrons/proxy';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	try {
		const [deckRes, pipetteRes, tipLengthRes] = await Promise.all([
			robotGet(robot, '/calibration/deck').catch(() => null),
			robotGet(robot, '/calibration/pipette_offset').catch(() => null),
			robotGet(robot, '/calibration/tip_length').catch(() => null)
		]);

		return json({
			deck: deckRes ? await deckRes.json().catch(() => null) : null,
			pipetteOffsets: pipetteRes ? await pipetteRes.json().catch(() => null) : null,
			tipLengths: tipLengthRes ? await tipLengthRes.json().catch(() => null) : null
		});
	} catch (e) {
		error(502, `Failed to reach robot: ${e instanceof Error ? e.message : 'unknown'}`);
	}
};
