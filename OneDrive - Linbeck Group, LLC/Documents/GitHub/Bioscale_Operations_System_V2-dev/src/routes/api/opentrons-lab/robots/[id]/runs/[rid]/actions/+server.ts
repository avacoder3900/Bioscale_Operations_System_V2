/**
 * Run control actions — play, pause, stop, resume.
 * POST /api/opentrons-lab/robots/:id/runs/:rid/actions
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot, robotPost } from '$lib/server/opentrons/proxy';

const VALID_ACTIONS = ['play', 'pause', 'stop', 'resume'] as const;
type RunAction = (typeof VALID_ACTIONS)[number];

export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	const { action } = await request.json();
	if (!VALID_ACTIONS.includes(action)) {
		error(400, 'action must be play, pause, stop, or resume');
	}

	try {
		const res = await robotPost(robot, `/runs/${params.rid}/actions`, {
			data: { actionType: action as RunAction }
		});
		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			error(502, (body as any).errors?.[0]?.detail ?? `Robot returned ${res.status}`);
		}
		return json({ ok: true, action });
	} catch (e) {
		if ((e as any).status) throw e;
		console.error('[API] run action error:', e instanceof Error ? e.message : e);
		error(502, e instanceof Error ? e.message : 'Failed to control run');
	}
};
