/**
 * Move to absolute deck coordinates inside a maintenance run.
 * POST /api/opentrons-lab/robots/:id/maintenance/:runId/move-to
 * Body: { pipetteId: string, x: number, y: number, z: number,
 *         minimumZHeight?: number, forceDirect?: boolean }
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot } from '$lib/server/opentrons/proxy';
import { moveTo } from '$lib/server/opentrons/maintenance';

export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	const body = await request.json().catch(() => ({} as any));
	const pipetteId = body?.pipetteId;
	const x = body?.x;
	const y = body?.y;
	const z = body?.z;
	const minimumZHeight = body?.minimumZHeight;
	const forceDirect = body?.forceDirect;

	if (!pipetteId || typeof pipetteId !== 'string') error(400, 'pipetteId required');
	if (typeof x !== 'number' || !Number.isFinite(x)) error(400, 'x must be a finite number');
	if (typeof y !== 'number' || !Number.isFinite(y)) error(400, 'y must be a finite number');
	if (typeof z !== 'number' || !Number.isFinite(z)) error(400, 'z must be a finite number');

	try {
		await moveTo(
			robot,
			params.runId,
			pipetteId,
			{ x, y, z },
			{
				minimumZHeight: typeof minimumZHeight === 'number' ? minimumZHeight : undefined,
				forceDirect: typeof forceDirect === 'boolean' ? forceDirect : undefined
			}
		);
		return json({ ok: true });
	} catch (e) {
		if ((e as any).status) throw e;
		console.error('[API] maintenance move-to error:', e instanceof Error ? e.message : e);
		error(502, e instanceof Error ? e.message : 'Failed to move robot');
	}
};
