/**
 * Single protocol — Get / Delete.
 * GET    /api/opentrons-lab/robots/:id/protocols/:pid
 * DELETE /api/opentrons-lab/robots/:id/protocols/:pid
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/auth/permissions';
import { getProtocolFromRobot, deleteProtocolFromRobot } from '$lib/server/services/opentrons/protocol-manager';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	await requirePermission(locals.user, 'manufacturing:read');

	try {
		const protocol = await getProtocolFromRobot(params.id, params.pid);
		return json(protocol);
	} catch (e) {
		console.error('[API] get protocol error:', e instanceof Error ? e.message : e);
		error(502, 'Failed to reach robot');
	}
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	await requirePermission(locals.user, 'manufacturing:write');

	try {
		await deleteProtocolFromRobot(params.id, params.pid, locals.user.id);
		return json({ ok: true });
	} catch (e) {
		console.error('[API] delete protocol error:', e instanceof Error ? e.message : e);
		error(502, e instanceof Error ? e.message : 'Failed to delete protocol');
	}
};
