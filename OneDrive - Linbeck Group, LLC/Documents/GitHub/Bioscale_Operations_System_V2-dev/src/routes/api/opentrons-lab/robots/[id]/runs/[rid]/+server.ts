/**
 * Single run — Get details / Update (stop).
 * GET   /api/opentrons-lab/robots/:id/runs/:rid
 * PATCH /api/opentrons-lab/robots/:id/runs/:rid
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot, robotGet, robotPatch } from '$lib/server/opentrons/proxy';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	try {
		const res = await robotGet(robot, `/runs/${params.rid}`);
		const data = await res.json();
		return json(data);
	} catch (e) {
		error(502, `Failed to reach robot: ${e instanceof Error ? e.message : 'unknown'}`);
	}
};

export const PATCH: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	const body = await request.json();

	try {
		const res = await robotPatch(robot, `/runs/${params.rid}`, body);
		const data = await res.json();
		return json(data);
	} catch (e) {
		error(502, `Failed to reach robot: ${e instanceof Error ? e.message : 'unknown'}`);
	}
};
