/**
 * Single run — Get detail / Delete.
 * GET    /api/opentrons-lab/robots/:id/runs/:rid
 * DELETE /api/opentrons-lab/robots/:id/runs/:rid
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/auth/permissions';
import { getRunDetail, deleteRun } from '$lib/server/services/opentrons/run-monitor';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	await requirePermission(locals.user, 'manufacturing:read');

	try {
		const run = await getRunDetail(params.id, params.rid);
		return json(run);
	} catch (e) {
		console.error('[API] run detail error:', e instanceof Error ? e.message : e);
		error(502, 'Failed to reach robot');
	}
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	await requirePermission(locals.user, 'manufacturing:write');

	try {
		await deleteRun(params.id, params.rid);
		return json({ ok: true });
	} catch (e) {
		console.error('[API] delete run error:', e instanceof Error ? e.message : e);
		error(502, e instanceof Error ? e.message : 'Failed to delete run');
	}
};
