/**
 * POST → stop whatever the arm is doing (any play, replay, teleop or Return
 * to home attempt) and hold it where it is. Behind the status card's "Stop
 * arm" on every Robot Arm tab. Does not touch the OT-2: the Run tab's STOP
 * RUN is the whole-line halt.
 *
 *   200 { ok: true, torqueOn, stoppedRunId, message }
 *   502 { ok: false, error }   — the Pi refused or could not be reached
 */
import { error, json } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection';
import { requirePermission } from '$lib/server/permissions';
import { stopArm } from '$lib/server/robot-arm-stop';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');
	await connectDB();
	try {
		const r = await stopArm({ _id: locals.user._id, username: locals.user.username });
		return json({ ok: true, torqueOn: r.torqueOn, stoppedRunId: r.stoppedRunId, message: r.message }, { headers: { 'Cache-Control': 'no-store' } });
	} catch (err) {
		return json({ ok: false, error: (err as Error).message }, { status: 502 });
	}
};
