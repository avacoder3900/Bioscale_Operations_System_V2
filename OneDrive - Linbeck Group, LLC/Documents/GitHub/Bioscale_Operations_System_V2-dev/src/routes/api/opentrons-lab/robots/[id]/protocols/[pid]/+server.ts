/**
 * Single protocol — Get / Delete.
 * GET    /api/opentrons-lab/robots/:id/protocols/:pid
 * DELETE /api/opentrons-lab/robots/:id/protocols/:pid
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot, robotGet, robotDelete } from '$lib/server/opentrons/proxy';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	try {
		const res = await robotGet(robot, `/protocols/${params.pid}`);
		const data = await res.json();
		return json(data);
	} catch (e) {
		error(502, `Failed to reach robot: ${e instanceof Error ? e.message : 'unknown'}`);
	}
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	try {
		const res = await robotDelete(robot, `/protocols/${params.pid}`);
		if (!res.ok && res.status !== 204) {
			error(502, `Robot returned ${res.status}`);
		}
		return json({ ok: true });
	} catch (e) {
		if ((e as any).status) throw e;
		error(502, `Failed to reach robot: ${e instanceof Error ? e.message : 'unknown'}`);
	}
};
