/**
 * Run control actions — play, pause, stop, resume.
 * POST /api/opentrons-lab/robots/:id/runs/:rid/actions
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot, robotPost } from '$lib/server/opentrons/proxy';

const VALID_ACTIONS = ['play', 'pause', 'stop', 'resume'] as const;

// The OT-2 has no 'resume' actionType — a paused run is resumed with 'play'.
// Passing 'resume' through made the robot reject it (the spurious error seen when
// auto-resuming the off-deck pause). Map it here.
const ACTION_TO_OT2: Record<string, string> = {
	play: 'play',
	pause: 'pause',
	stop: 'stop',
	resume: 'play'
};

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
			data: { actionType: ACTION_TO_OT2[action] }
		});
		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			const detail = (body as any).errors?.[0]?.detail ?? `Robot returned ${res.status}`;
			// A 4xx from the robot means the action is invalid for the run's CURRENT
			// state (e.g. pause when already paused) — benign; the client reconciles
			// by re-polling. 5xx/other = a real failure. Surface robotStatus + a
			// `conflict` flag so the client can tell them apart instead of alarming.
			const conflict = res.status >= 400 && res.status < 500;
			return json(
				{ ok: false, action, robotStatus: res.status, detail, conflict },
				{ status: conflict ? 409 : 502 }
			);
		}
		return json({ ok: true, action });
	} catch (e) {
		if ((e as any).status) throw e;
		console.error('[API] run action error:', e instanceof Error ? e.message : e);
		error(502, e instanceof Error ? e.message : 'Failed to control run');
	}
};
