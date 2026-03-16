/**
 * Single robot — Update / Deactivate.
 * PATCH  /api/opentrons-lab/robots/:id
 * DELETE /api/opentrons-lab/robots/:id
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/auth/permissions';
import { updateRobot, deactivateRobot, getRobot } from '$lib/server/services/opentrons/robot-registry';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	await requirePermission(locals.user, 'manufacturing:read');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');
	return json(robot);
};

export const PATCH: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	await requirePermission(locals.user, 'manufacturing:write');

	const body = await request.json();
	const updated = await updateRobot(params.id, body, locals.user.id);
	if (!updated) error(404, 'Robot not found');
	return json(updated);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	await requirePermission(locals.user, 'manufacturing:write');

	const success = await deactivateRobot(params.id, locals.user.id);
	if (!success) error(404, 'Robot not found');
	return json({ ok: true });
};
