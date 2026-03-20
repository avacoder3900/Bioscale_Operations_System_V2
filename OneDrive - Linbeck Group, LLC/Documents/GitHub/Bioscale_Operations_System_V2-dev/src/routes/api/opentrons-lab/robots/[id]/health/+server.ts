/**
 * Live health check for a robot.
 * GET /api/opentrons-lab/robots/:id/health
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot, robotGet, updateRobotHealth } from '$lib/server/opentrons/proxy';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	try {
		const startTime = Date.now();
		const res = await robotGet(robot, '/health');
		const responseTimeMs = Date.now() - startTime;
		const isHealthy = res.ok;

		const data = await res.json().catch(() => ({}));

		await updateRobotHealth(params.id, isHealthy, {
			...data,
			responseTimeMs,
			errorMessage: isHealthy ? null : `HTTP ${res.status}`
		});

		return json({ ok: isHealthy, responseTimeMs, ...data });
	} catch (e) {
		await updateRobotHealth(params.id, false, {
			errorMessage: e instanceof Error ? e.message : 'Connection failed'
		});
		error(502, `Failed to reach robot: ${e instanceof Error ? e.message : 'unknown'}`);
	}
};
