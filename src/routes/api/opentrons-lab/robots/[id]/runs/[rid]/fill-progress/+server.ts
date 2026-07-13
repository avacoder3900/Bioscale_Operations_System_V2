/**
 * Where did this fill run get to?
 * GET /api/opentrons-lab/robots/:id/runs/:rid/fill-progress
 * Returns: { progress: { group, cartridge, hole, well, wellsFilled } | null }
 *
 * Drives the tip-break recovery dialog: the operator stops a run whose tip broke, and this
 * pre-fills the resume point with the last well that actually received liquid. `null` means
 * the run never dispensed anything, so there is nothing to resume — just run it again.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot } from '$lib/server/opentrons/proxy';
import { readFillProgress } from '$lib/server/opentrons/fill-resume';

// Pulls the full command log (up to 10k commands) off the robot.
export const config = { maxDuration: 60 };

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	try {
		const progress = await readFillProgress(robot as any, params.rid);
		return json({ progress });
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.error('[API] fill-progress failed:', msg);
		error(502, `Could not read the run's progress: ${msg}`);
	}
};
