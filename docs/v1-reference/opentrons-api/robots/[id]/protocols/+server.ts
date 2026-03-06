/**
 * Protocol management — List / Upload.
 * GET  /api/opentrons-lab/robots/:id/protocols
 * POST /api/opentrons-lab/robots/:id/protocols
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/auth/permissions';
import { listProtocolsOnRobot, uploadProtocol } from '$lib/server/services/opentrons/protocol-manager';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	await requirePermission(locals.user, 'manufacturing:read');

	try {
		const protocols = await listProtocolsOnRobot(params.id);
		return json(protocols);
	} catch (e) {
		console.error('[API] list protocols error:', e instanceof Error ? e.message : e);
		error(502, 'Failed to reach robot');
	}
};

export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	await requirePermission(locals.user, 'manufacturing:write');

	const formData = await request.formData();
	const file = formData.get('protocolFile') as File | null;
	if (!file) error(400, 'protocolFile is required');

	try {
		const result = await uploadProtocol(params.id, file, file.name, locals.user.id);
		return json(result, { status: 201 });
	} catch (e) {
		console.error('[API] upload protocol error:', e instanceof Error ? e.message : e);
		error(502, e instanceof Error ? e.message : 'Failed to upload protocol');
	}
};
