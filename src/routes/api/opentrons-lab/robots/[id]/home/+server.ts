/**
 * Home robot gantry.
 * POST /api/opentrons-lab/robots/:id/home
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot, robotPost } from '$lib/server/opentrons/proxy';

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	try {
		const res = await robotPost(robot, '/robot/home', { target: 'robot' });
		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			error(502, (body as any).message ?? `Robot returned ${res.status}`);
		}
		return json({ ok: true });
	} catch (e) {
		if ((e as any).status) throw e;
		error(502, `Failed to reach robot: ${e instanceof Error ? e.message : 'unknown'}`);
	}
};
