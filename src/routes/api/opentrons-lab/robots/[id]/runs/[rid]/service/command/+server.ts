/**
 * Queue one command for the parked fill protocol (WAX-SERVICE-1).
 * POST /api/opentrons-lab/robots/:id/runs/:rid/service/command
 * Body: { verb: 'jog'|'goto_well'|'change_tip'|'tip_cal'|'resume', args?: {...} }
 *
 * jog args: { axis: 'x'|'y'|'z', mm: number }
 *
 * Exactly one command may be outstanding: the protocol executes strictly one
 * verb before asking for the next, so queueing a second while one is in flight
 * is rejected rather than silently dropped.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot } from '$lib/server/opentrons/proxy';
import { connectDB, Ot2ServiceSession, SERVICE_VERBS, AuditLog, generateId } from '$lib/server/db';

const JOG_AXES = ['x', 'y', 'z'];
// Matches the Deck Calibration Studio's step selector; 25mm is deliberately not
// offered mid-run with a wet tip over a loaded deck.
const JOG_MAX_MM = 10;

export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	const body = await request.json().catch(() => ({} as any));
	const verb = body?.verb;
	const args = body?.args ?? {};

	if (!SERVICE_VERBS.includes(verb)) {
		error(400, `verb must be one of ${SERVICE_VERBS.join(', ')}`);
	}
	if (verb === 'jog') {
		if (!JOG_AXES.includes(args?.axis)) error(400, `jog axis must be one of ${JOG_AXES.join(', ')}`);
		const mm = Number(args?.mm);
		if (!Number.isFinite(mm) || mm === 0) error(400, 'jog mm must be a non-zero finite number');
		if (Math.abs(mm) > JOG_MAX_MM) error(400, `jog mm must be within ±${JOG_MAX_MM}`);
	}

	await connectDB();
	const session = await Ot2ServiceSession
		.findOne({ opentronsRunId: params.rid, status: { $in: ['requested', 'active'] } })
		.lean() as any;

	if (!session) error(409, 'No open service session for this run');
	if (session.status !== 'active') {
		error(409, 'The protocol has not reached a checkpoint yet — wait for it to park');
	}
	if (session.pendingCommand?.id) {
		error(409, `Still running '${session.pendingCommand.verb}' — wait for it to finish`);
	}

	const now = new Date();
	const commandId = generateId();

	// Guard the slot in the write itself so two operators can't both think they
	// queued the next move.
	const claimed = await Ot2ServiceSession.findOneAndUpdate(
		{ _id: session._id, status: 'active', 'pendingCommand.id': null },
		{
			$set: {
				pendingCommand: {
					id: commandId,
					verb,
					args,
					issuedAt: now,
					issuedBy: locals.user.username,
					deliveredAt: null
				},
				updatedAt: now
			}
		},
		{ new: true }
	).lean() as any;

	if (!claimed) error(409, 'Another command was queued first — try again');

	await AuditLog.create({
		_id: generateId(),
		tableName: 'ot2_service_sessions',
		recordId: String(session._id),
		action: 'service_command',
		changedBy: locals.user.username,
		changedAt: now,
		newData: { verb, args, opentronsRunId: params.rid, robotId: String(robot._id ?? '') }
	});

	return json({ ok: true, commandId, verb });
};
