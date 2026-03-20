/**
 * Blink robot lights for identification.
 * POST /api/opentrons-lab/robots/:id/identify
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/auth/permissions';
import { getRobot } from '$lib/server/services/opentrons/robot-registry';
import { createOT2Client } from '$lib/server/integrations/opentrons/client';

export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	await requirePermission(locals.user, 'manufacturing:write');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	const body = await request.json().catch(() => ({}));
	const seconds = (body as { seconds?: number }).seconds ?? 10;

	const client = createOT2Client({ ip: robot.ip, port: robot.port });
	await client.identify(seconds);
	return json({ ok: true });
};
