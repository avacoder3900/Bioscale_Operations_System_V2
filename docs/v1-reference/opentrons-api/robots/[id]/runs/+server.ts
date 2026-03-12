/**
 * Run management — List / Create.
 * GET  /api/opentrons-lab/robots/:id/runs
 * POST /api/opentrons-lab/robots/:id/runs
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/auth/permissions';
import { listRunsOnRobot, createRun } from '$lib/server/services/opentrons/run-monitor';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	await requirePermission(locals.user, 'manufacturing:read');

	try {
		const runs = await listRunsOnRobot(params.id);
		return json(runs);
	} catch (e) {
		console.error('[API] list runs error:', e instanceof Error ? e.message : e);
		error(502, 'Failed to reach robot');
	}
};

export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	await requirePermission(locals.user, 'manufacturing:write');

	const { protocolId, runTimeParameterValues } = await request.json();
	if (!protocolId) error(400, 'protocolId is required');

	try {
		const run = await createRun(params.id, protocolId, runTimeParameterValues);
		return json(run, { status: 201 });
	} catch (e) {
		console.error('[API] create run error:', e instanceof Error ? e.message : e);
		error(502, e instanceof Error ? e.message : 'Failed to create run');
	}
};
