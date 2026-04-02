/**
 * POST /api/opentrons-lab/run-records/:recordId/actions
 * Body: { actionType: 'play' | 'pause' | 'stop' }
 * Forwards action to OT-2 robot and updates BIMS run record.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { sendRunAction } from '$lib/server/opentrons/run-lifecycle';

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'manufacturing:write');

	const { actionType } = await request.json();
	if (!['play', 'pause', 'stop'].includes(actionType)) {
		return json({ error: 'Invalid actionType. Must be play, pause, or stop.' }, { status: 400 });
	}

	const result = await sendRunAction(params.recordId, actionType);

	if (!result.success) {
		return json({ error: result.error }, { status: 500 });
	}

	return json({ success: true });
};
