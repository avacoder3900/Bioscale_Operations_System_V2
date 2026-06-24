/**
 * Jog (relative move) on a single axis inside a maintenance run.
 * POST /api/opentrons-lab/robots/:id/maintenance/:runId/jog
 * Body: { pipetteId: string, axis: 'x'|'y'|'leftZ'|'rightZ', distance: number }
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot } from '$lib/server/opentrons/proxy';
import { jog, type JogAxis } from '$lib/server/opentrons/maintenance';

const VALID_AXES: JogAxis[] = ['x', 'y', 'leftZ', 'rightZ'];

// Each jog is a bridge round-trip (up to ~30s); exceed Vercel's ~10s default.
export const config = { maxDuration: 45 };

export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	const body = await request.json().catch(() => ({} as any));
	const pipetteId = body?.pipetteId;
	const axis = body?.axis;
	const distance = body?.distance;

	if (!pipetteId || typeof pipetteId !== 'string') error(400, 'pipetteId required');
	if (!VALID_AXES.includes(axis)) error(400, `axis must be one of ${VALID_AXES.join(', ')}`);
	if (typeof distance !== 'number' || !Number.isFinite(distance)) error(400, 'distance must be a finite number');

	try {
		await jog(robot, params.runId, pipetteId, axis, distance);
		return json({ ok: true });
	} catch (e) {
		if ((e as any).status) throw e;
		console.error('[API] maintenance jog error:', e instanceof Error ? e.message : e);
		error(502, e instanceof Error ? e.message : 'Failed to jog robot');
	}
};
