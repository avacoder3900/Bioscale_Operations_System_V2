/**
 * Home gantry inside a maintenance run.
 * POST /api/opentrons-lab/robots/:id/maintenance/:runId/home
 * Body (optional): { axes?: string[] }
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot } from '$lib/server/opentrons/proxy';
import { home } from '$lib/server/opentrons/maintenance';

// Homing all axes can take 30-60s — well past the default function window.
export const config = { maxDuration: 120 };

export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	const body = await request.json().catch(() => ({} as any));
	const axes = Array.isArray(body?.axes) ? body.axes : undefined;

	try {
		await home(robot, params.runId, axes);
		return json({ ok: true });
	} catch (e) {
		if ((e as any).status) throw e;
		console.error('[API] maintenance home error:', e instanceof Error ? e.message : e);
		error(502, e instanceof Error ? e.message : 'Failed to home robot');
	}
};
