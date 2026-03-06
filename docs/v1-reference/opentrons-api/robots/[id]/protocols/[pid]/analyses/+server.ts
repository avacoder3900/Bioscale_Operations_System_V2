/**
 * Protocol analysis results.
 * GET /api/opentrons-lab/robots/:id/protocols/:pid/analyses
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/auth/permissions';
import { getProtocolAnalysis } from '$lib/server/services/opentrons/protocol-manager';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	await requirePermission(locals.user, 'manufacturing:read');

	try {
		const analyses = await getProtocolAnalysis(params.id, params.pid);
		return json(analyses);
	} catch (e) {
		console.error('[API] protocol analysis error:', e instanceof Error ? e.message : e);
		error(502, 'Failed to reach robot');
	}
};
