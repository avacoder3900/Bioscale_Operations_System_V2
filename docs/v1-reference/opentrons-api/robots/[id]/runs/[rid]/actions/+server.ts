/**
 * Run control actions — play, pause, stop, resume.
 * POST /api/opentrons-lab/robots/:id/runs/:rid/actions
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/auth/permissions';
import { controlRun } from '$lib/server/services/opentrons/run-monitor';

export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	await requirePermission(locals.user, 'manufacturing:write');

	const { action } = await request.json();
	if (!['play', 'pause', 'stop', 'resume'].includes(action)) {
		error(400, 'action must be play, pause, stop, or resume');
	}

	try {
		await controlRun(params.id, params.rid, action);
		return json({ ok: true, action });
	} catch (e) {
		console.error('[API] run action error:', e instanceof Error ? e.message : e);
		error(502, e instanceof Error ? e.message : 'Failed to control run');
	}
};
