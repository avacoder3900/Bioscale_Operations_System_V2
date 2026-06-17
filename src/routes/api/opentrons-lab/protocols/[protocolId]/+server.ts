/**
 * GET    /api/opentrons-lab/protocols/:id — Protocol detail
 * PATCH  /api/opentrons-lab/protocols/:id — Update metadata
 * DELETE /api/opentrons-lab/protocols/:id — Soft-delete
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { connectDB, OpentronProtocol } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'manufacturing:read');

	await connectDB();
	const protocol = await OpentronProtocol.findById(params.protocolId).lean();
	if (!protocol) return json({ error: 'Not found' }, { status: 404 });

	return json({ data: JSON.parse(JSON.stringify(protocol)) });
};

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'manufacturing:write');

	await connectDB();
	const body = await request.json();
	const allowed = ['protocolName', 'description', 'processType', 'tags'];
	const update: Record<string, unknown> = { lastModifiedBy: locals.user.username };
	for (const key of allowed) {
		if (body[key] !== undefined) update[key] = body[key];
	}

	const protocol = await OpentronProtocol.findByIdAndUpdate(
		params.protocolId,
		{ $set: update },
		{ new: true }
	).lean();

	if (!protocol) return json({ error: 'Not found' }, { status: 404 });
	return json({ data: JSON.parse(JSON.stringify(protocol)) });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'manufacturing:write');

	await connectDB();
	const protocol = await OpentronProtocol.findByIdAndUpdate(
		params.protocolId,
		{ $set: { isActive: false, lastModifiedBy: locals.user.username } },
		{ new: true }
	).lean();

	if (!protocol) return json({ error: 'Not found' }, { status: 404 });
	return json({ success: true });
};
