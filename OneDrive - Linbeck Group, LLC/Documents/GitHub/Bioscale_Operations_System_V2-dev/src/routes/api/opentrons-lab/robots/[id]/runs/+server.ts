/**
 * Run management — List / Create.
 * GET  /api/opentrons-lab/robots/:id/runs
 * POST /api/opentrons-lab/robots/:id/runs
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot, robotGet, robotPost } from '$lib/server/opentrons/proxy';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	try {
		const res = await robotGet(robot, '/runs');
		const data = await res.json();
		return json(data);
	} catch (e) {
		console.error('[API] list runs error:', e instanceof Error ? e.message : e);
		error(502, 'Failed to reach robot');
	}
};

export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	const { protocolId, runTimeParameterValues } = await request.json();
	if (!protocolId) error(400, 'protocolId is required');

	try {
		const res = await robotPost(robot, '/runs', {
			data: {
				protocolId,
				...(runTimeParameterValues ? { runTimeParameterValues } : {})
			}
		});
		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			error(502, (body as any).errors?.[0]?.detail ?? `Robot returned ${res.status}`);
		}
		const data = await res.json();
		return json(data, { status: 201 });
	} catch (e) {
		if ((e as any).status) throw e;
		console.error('[API] create run error:', e instanceof Error ? e.message : e);
		error(502, e instanceof Error ? e.message : 'Failed to create run');
	}
};
