/**
 * Trace of robot calls the browser made directly over the tailnet (OT2-TAILNET-4).
 * POST /api/opentrons-lab/robots/:id/direct-calls   Body: { calls: DirectCallRow[] } (≤ 50)
 * GET  /api/opentrons-lab/robots/:id/direct-calls?limit=50
 *
 * The queue line is traced by Ot2BridgeCommand; this keeps the same "what did
 * BIMS tell the robot" record for the tailnet line. Rows are observations the
 * browser reports after the fact — the robot call has already happened — so
 * this route never touches the robot. username comes from the session.
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, OpentronsRobot, Ot2DirectCall, generateId } from '$lib/server/db';
import { recordOt2Action } from '$lib/server/robot-arm-move-log';

const MAX_ROWS = 50;
const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const body = await request.json().catch(() => ({}) as any);
	const calls = Array.isArray(body?.calls) ? body.calls.slice(0, MAX_ROWS) : [];
	if (!calls.length) return json({ written: 0 });

	await connectDB();
	const robot = (await OpentronsRobot.findById(params.id).select('name').lean()) as { _id: string; name?: string } | null;
	if (!robot) error(404, 'Robot not found');

	const now = Date.now();
	const rows = calls.map((c: any) => {
		const at = typeof c?.at === 'string' || typeof c?.at === 'number' ? new Date(c.at) : new Date(now);
		return {
			_id: generateId(),
			robotId: params.id,
			sessionId: str(c?.sessionId, 64),
			verb: str(c?.verb, 40),
			method: str(c?.method, 10),
			path: str(c?.path, 300),
			status: num(c?.status) ?? 0,
			ok: c?.ok === true,
			latencyMs: num(c?.latencyMs),
			error: str(c?.error),
			username: locals.user!.username,
			userId: locals.user!._id,
			// Clamp client clocks: never in the future, never older than a day.
			at: isNaN(at.getTime()) || at.getTime() > now || now - at.getTime() > 86_400_000 ? new Date(now) : at
		};
	});
	await Ot2DirectCall.insertMany(rows, { ordered: false });
	// Home and rail lights the browser sent straight to the robot go in the Movement Log too (2026-11-06).
	const user = { _id: locals.user._id, username: locals.user.username };
	await Promise.all(
		calls.map((c: any, i: number) =>
			recordOt2Action({
				robot,
				method: rows[i].method ?? '',
				path: rows[i].path ?? '',
				body: str(c?.body, 200),
				ok: rows[i].ok,
				error: rows[i].error ?? (rows[i].ok ? null : `HTTP ${rows[i].status}`),
				at: rows[i].at.getTime(),
				durationMs: rows[i].latencyMs ?? 0,
				from: 'Tailscale Line',
				user
			})
		)
	);
	return json({ written: rows.length });
};

export const GET: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');

	const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
	await connectDB();
	const calls = await Ot2DirectCall.find({ robotId: params.id }).sort({ at: -1 }).limit(limit).lean();
	return json({ calls: JSON.parse(JSON.stringify(calls)) });
};
