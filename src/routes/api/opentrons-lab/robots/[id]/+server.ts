/**
 * Single robot — Get / Update / Deactivate.
 * GET    /api/opentrons-lab/robots/:id
 * PATCH  /api/opentrons-lab/robots/:id
 * DELETE /api/opentrons-lab/robots/:id
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot } from '$lib/server/opentrons/proxy';
import { connectDB, OpentronsRobot } from '$lib/server/db';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');
	return json(JSON.parse(JSON.stringify(robot)));
};

export const PATCH: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');
	await connectDB();

	const body = await request.json();
	const allowedFields = ['name', 'ip', 'port', 'robotSide', 'legacyRobotId'];
	const updates: Record<string, unknown> = {};
	for (const field of allowedFields) {
		if (field in body) updates[field] = body[field];
	}

	const updated = await OpentronsRobot.findByIdAndUpdate(
		params.id,
		{ $set: updates },
		{ new: true }
	).lean();

	if (!updated) error(404, 'Robot not found');
	return json(JSON.parse(JSON.stringify(updated)));
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');
	await connectDB();

	const result = await OpentronsRobot.findByIdAndUpdate(
		params.id,
		{ $set: { isActive: false } }
	).lean();

	if (!result) error(404, 'Robot not found');
	return json({ ok: true });
};
