/**
 * Current run state — for fast polling during active runs.
 * GET /api/opentrons-lab/robots/:id/runs/:rid/state
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/auth/permissions';
import { getRunState } from '$lib/server/services/opentrons/run-monitor';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	await requirePermission(locals.user, 'manufacturing:read');

	try {
		const state = await getRunState(params.id, params.rid);
		return json(state);
	} catch (e) {
		console.error('[API] run state error:', e instanceof Error ? e.message : e);
		error(502, 'Failed to reach robot');
	}
};
