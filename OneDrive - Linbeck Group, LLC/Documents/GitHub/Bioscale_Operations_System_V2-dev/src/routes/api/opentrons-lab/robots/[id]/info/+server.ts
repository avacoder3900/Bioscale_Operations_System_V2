/**
 * Get robot system info (versions, pipettes, modules).
 * GET /api/opentrons-lab/robots/:id/info
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot, robotGet } from '$lib/server/opentrons/proxy';
import { connectDB, OpentronsRobot } from '$lib/server/db';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	try {
		const [healthRes, pipettesRes] = await Promise.all([
			robotGet(robot, '/health'),
			robotGet(robot, '/pipettes').catch(() => null)
		]);

		const health = await healthRes.json().catch(() => ({})) as any;
		const pipettes = pipettesRes ? await pipettesRes.json().catch(() => null) : null;

		// Persist version info to DB
		await connectDB();
		await OpentronsRobot.updateOne(
			{ _id: params.id },
			{
				$set: {
					firmwareVersion: health.fw_version ?? null,
					apiVersion: health.api_version ?? null,
					robotModel: health.robot_model ?? null,
					robotSerial: health.robot_serial ?? null
				}
			}
		);

		return json({ health, pipettes });
	} catch (e) {
		error(502, `Failed to reach robot: ${e instanceof Error ? e.message : 'unknown'}`);
	}
};
