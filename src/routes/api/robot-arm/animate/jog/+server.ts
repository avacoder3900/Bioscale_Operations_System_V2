/**
 * Animate — jog one joint of the follower live, and read the arm back
 * (ARM-06 §10). Used by the Animate tab's jog panel, which calls it on
 * every button press and polls it for the live positions, so it is a
 * JSON route rather than a page action: a page action would re-run the
 * whole page load (library + servo read) on every nudge.
 *
 *   GET  → { active: {kind, runId} | null, positions: number[6] | null, torqueOn }
 *          positions is null while a session owns the bus (never read mid-session).
 *   POST { sid: 1..6, delta: ±steps }
 *        → { sid, delta, goal, positions, torqueOn, chunks }
 *
 * Refused (409) while a session owns the arm or torque is off; the arm
 * MOVES on POST. Session auth + manufacturing permissions, like /torque.
 */
import { json } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { AnimateError, jogArm, playbackActive, readArm } from '$lib/server/robot-arm-animation';
import type { RequestHandler } from './$types';

const noStore = { headers: { 'Cache-Control': 'no-store' } };

function failure(err: unknown) {
	const e = err as AnimateError;
	const status = e instanceof AnimateError ? e.status : 502;
	return json({ error: e?.message ?? String(err) }, { status, ...noStore });
}

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'manufacturing:read');
	try {
		const active = await playbackActive();
		if (active) return json({ active, positions: null, torqueOn: null }, noStore);
		const arm = await readArm();
		return json({ active: null, positions: arm.positions, torqueOn: arm.torqueOn }, noStore);
	} catch (err) {
		return failure(err);
	}
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'manufacturing:write');
	const body = (await request.json().catch(() => null)) as { sid?: unknown; delta?: unknown } | null;
	if (!body) return json({ error: 'Body must be JSON { sid, delta }.' }, { status: 400, ...noStore });
	try {
		return json(await jogArm({ _id: locals.user._id, username: locals.user.username }, { sid: body.sid, delta: body.delta }), noStore);
	} catch (err) {
		return failure(err);
	}
};
