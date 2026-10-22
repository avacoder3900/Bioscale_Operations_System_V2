/**
 * Animate — live sliders (ARM-06 §13). The pose editor calls this for every
 * slider move and polls it for where the arm is, so it is a JSON route
 * rather than a page action: a page action would re-run the whole page load
 * (library + servo read) on every move.
 *
 *   GET  → { active: {kind, runId} | null, positions: number[6] | null,
 *            temps: (°C|null)[6] | null, torqueOn }
 *          positions/temps are null while a session owns the bus (never read mid-session).
 *   POST { goals: { "<servoId>": position } }   absolute goals
 *        → { goals, positions, temps, torqueOn, warnings, via }
 *          positions/temps are the read taken just before the goals were written.
 *
 * Refused (409) while a session owns the arm, torque is off, a servo is too
 * hot, or a goal is far from the arm; the arm MOVES on POST. Session auth +
 * manufacturing permissions, like /torque.
 */
import { json } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { AnimateError, liveMove, playbackActive, readArm } from '$lib/server/robot-arm-animation';
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
		if (active) return json({ active, positions: null, temps: null, torqueOn: null }, noStore);
		const arm = await readArm();
		return json({ active: null, positions: arm.positions, temps: arm.temps, torqueOn: arm.torqueOn }, noStore);
	} catch (err) {
		return failure(err);
	}
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'manufacturing:write');
	const body = (await request.json().catch(() => null)) as { goals?: unknown } | null;
	if (!body) return json({ error: 'Body must be JSON { goals: { servoId: position } }.' }, { status: 400, ...noStore });
	try {
		return json(await liveMove({ goals: body.goals }), noStore);
	} catch (err) {
		return failure(err);
	}
};
