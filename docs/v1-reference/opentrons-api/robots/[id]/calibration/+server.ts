/**
 * Full calibration report for a robot.
 * GET /api/opentrons-lab/robots/:id/calibration
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/auth/permissions';
import { getCalibrationReport } from '$lib/server/services/opentrons/robot-info';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	await requirePermission(locals.user, 'manufacturing:read');

	try {
		const report = await getCalibrationReport(params.id);
		return json(report);
	} catch (e) {
		console.error('[API] calibration error:', e instanceof Error ? e.message : e);
		error(502, 'Failed to reach robot');
	}
};
