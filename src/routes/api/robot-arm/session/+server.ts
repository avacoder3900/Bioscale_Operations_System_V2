/**
 * The arm's session, for the control page's session bar to poll while a run
 * is in progress.
 *
 *   GET → { active: {run_id, kind} | null, activeError: string | null,
 *           holder: ArmHolder | null }
 *
 * `active` is the Pi's live answer (GET /sessions/active); `holder` is derived
 * from robot_arm_runs and, for a replay, carries the loop in progress from
 * the Pi's `replay.loop` events. A JSON route rather than invalidateAll():
 * the control page's load also lists recordings, trash and tasks, which is
 * far too much to re-run every couple of seconds just to move a loop counter.
 * Touches no servo and never throws for an unreachable Pi — that is reported
 * as activeError, the same way the page load does it.
 */
import { error, json } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection';
import { requirePermission } from '$lib/server/permissions';
import { robotArmFetch, type ActiveSession } from '$lib/server/robot-arm-client';
import { deriveArmHolder } from '$lib/server/robot-arm-lock';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const [activeResult, holder] = await Promise.all([
		robotArmFetch<ActiveSession>('/sessions/active', { timeoutMs: 4000 })
			.then((res) => ({ active: res.active ?? null, activeError: null as string | null }))
			.catch((err) => ({ active: null, activeError: (err as Error).message })),
		deriveArmHolder()
	]);

	return json(
		{ active: activeResult.active, activeError: activeResult.activeError, holder },
		{ headers: { 'Cache-Control': 'no-store' } }
	);
};
