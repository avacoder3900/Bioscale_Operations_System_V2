/**
 * Live per-robot health (ready / busy / hung / offline), derived from the
 * bridge heartbeat. Polled by the wax-filling layout to keep the status badges
 * fresh without a full invalidateAll (which would disrupt the operator's form).
 * GET /api/opentrons-lab/robots/health  ->  { health: Record<robotId, RobotHealth> }
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Equipment } from '$lib/server/db';
import { getRobotsHealth } from '$lib/server/opentrons/health';

export const config = { maxDuration: 20 };

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');

	await connectDB();
	const robots = (await Equipment.find(
		{ equipmentType: 'robot', isActive: true },
		{ _id: 1, name: 1 }
	).lean()) as any[];

	const health = await getRobotsHealth(robots.map((r) => ({ _id: String(r._id), name: r.name })));
	return json({ health });
};
