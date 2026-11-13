/**
 * DILUENT-FILL-1 S5 — this robot's stored labware offsets.
 * GET  /api/opentrons-lab/robots/:id/labware-offsets                → { data: StoredOffsetRow[] }
 * POST /api/opentrons-lab/robots/:id/labware-offsets                → { data: { saved, rows } }
 *      Body: { protocolId?, offsets: [{ definitionUri, loadName, displayName?, slotName, vector{x,y,z} }] }
 * The clone's Labware Position Check wizard posts its measurements here so a
 * manufacturing (diluent) start can send them to the robot. Never touches the robot.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, OpentronsRobot } from '$lib/server/db';
import { listStoredOffsets, saveLpcOffsets, checkLpcOffset } from '$lib/server/opentrons/lpc-offsets';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();
	if (!(await OpentronsRobot.exists({ _id: params.id }))) error(404, 'Robot not found');
	return json({ data: await listStoredOffsets(params.id) });
};

export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');
	const body = (await request.json().catch(() => ({}))) as any;
	const offsets = Array.isArray(body?.offsets) ? body.offsets : null;
	if (!offsets || !offsets.length) error(400, 'offsets must be a non-empty array');
	if (offsets.length > 20) error(400, 'too many offsets');
	for (const o of offsets) {
		const bad = checkLpcOffset(o);
		if (bad) error(400, `offsets: ${bad}`);
	}
	const protocolId = typeof body?.protocolId === 'string' && body.protocolId.length <= 100 ? body.protocolId : null;
	await connectDB();
	if (!(await OpentronsRobot.exists({ _id: params.id }))) error(404, 'Robot not found');
	try {
		const r = await saveLpcOffsets({ robotId: params.id, protocolId, offsets, user: { _id: locals.user._id, username: locals.user.username } });
		return json({ data: r }, { status: 201 });
	} catch (e) {
		error(400, e instanceof Error ? e.message : 'Could not save offsets');
	}
};
