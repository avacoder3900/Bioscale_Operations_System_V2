/**
 * Robot CRUD — List all robots / Register new robot.
 * GET  /api/opentrons-lab/robots
 * POST /api/opentrons-lab/robots
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, OpentronsRobot, generateId } from '$lib/server/db';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const robots = await OpentronsRobot.find({ isActive: true })
		.select('-recentHealthSnapshots')
		.lean();

	return json(JSON.parse(JSON.stringify(robots)));
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');
	await connectDB();

	const body = await request.json();
	const { name, ip, port, robotSide, legacyRobotId } = body;

	if (!name || !ip) {
		error(400, 'name and ip are required');
	}

	const robot = await OpentronsRobot.create({
		_id: generateId(),
		name,
		ip,
		port: port ?? 31950,
		robotSide: robotSide ?? null,
		legacyRobotId: legacyRobotId ?? null,
		isActive: true,
		source: locals.user.username
	});

	return json(JSON.parse(JSON.stringify(robot)), { status: 201 });
};
