/**
 * Run control actions — play, pause, stop, resume.
 * POST /api/opentrons-lab/robots/:id/runs/:rid/actions
 */

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot } from '$lib/server/opentrons/proxy';
import { verbResponse } from '$lib/server/opentrons/transport';

// Control actions route through the bridge (up to ~30s); exceed Vercel's ~10s default.
export const config = { maxDuration: 45 };

// The action → OT-2 actionType map (resume → play) and the 4xx → 409 conflict /
// 5xx → 502 mapping live in $lib/opentrons/ot2-protocol ('run.action'), shared
// with the browser's tailnet line (OT2-TAILNET-4).
export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	const { action } = await request.json().catch(() => ({}) as any);
	return verbResponse(robot, 'run.action', { rid: params.rid, action });
};
