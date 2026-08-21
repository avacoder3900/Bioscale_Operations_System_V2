/**
 * Read or stop a live limit-switch watch.
 *
 *   GET    /api/opentrons-lab/robots/:id/calibrator-watch/:commandId
 *     → { ok, status, armed, events[], startedAt, error }
 *   DELETE /api/opentrons-lab/robots/:id/calibrator-watch/:commandId
 *     → { ok, status } — the Stop button; the daemon sees it on its next tick.
 *
 * The Studio polls GET while a watch is armed and renders events[] as the trip
 * log. Events are append-only from the daemon's side, so the client can simply
 * replace its list each poll rather than reconciling.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot } from '$lib/server/opentrons/proxy';
import { connectDB, Ot2BridgeCommand } from '$lib/server/db';

/** Statuses in which the daemon may still post trips. */
const LIVE = ['pending', 'claimed'];

/**
 * Load the watch and confirm it belongs to this robot.
 *
 * The robot check is not ceremony: command ids are the only thing separating
 * one robot's watch from another's, and reading a watch through the wrong
 * robot's URL would show an operator trips from a machine they are not standing
 * at — which, on a page whose whole purpose is "the tip is touching the fixture
 * right now", is a genuinely dangerous thing to believe.
 */
async function loadWatch(robotId: string, commandId: string) {
	const robot = await getRobot(robotId);
	if (!robot) error(404, 'Robot not found');

	await connectDB();
	const cmd = (await Ot2BridgeCommand.findById(commandId)
		.select('robotId kind status events error createdAt claimedAt completedAt')
		.lean()) as any;

	if (!cmd || cmd.kind !== 'calibrator_watch') error(404, 'No such calibrator watch');
	if (String(cmd.robotId) !== String(robot._id)) error(404, 'No such calibrator watch');
	return cmd;
}

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');

	const cmd = await loadWatch(params.id, params.commandId);

	return json({
		ok: true,
		status: cmd.status,
		// 'claimed' means a daemon has it and the switches are armed. 'pending'
		// means it is still queued — the operator can jog, but a trip now would
		// not be seen, so the UI must not imply otherwise.
		armed: cmd.status === 'claimed',
		queued: cmd.status === 'pending',
		events: Array.isArray(cmd.events) ? cmd.events : [],
		startedAt: cmd.claimedAt ?? null,
		endedAt: cmd.completedAt ?? null,
		error: cmd.error ?? null
	});
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const cmd = await loadWatch(params.id, params.commandId);

	// Already finished is a success, not an error — the operator pressed Stop on
	// a watch that had just timed out, and telling them that failed would be a
	// lie about a thing that is, in fact, stopped.
	if (!LIVE.includes(cmd.status)) {
		return json({ ok: true, status: cmd.status, alreadyEnded: true });
	}

	await Ot2BridgeCommand.updateOne(
		{ _id: params.commandId, status: { $in: LIVE } },
		{ $set: { status: 'completed', completedAt: new Date() } }
	);

	// Events already posted are kept: the trips are the whole point of having
	// run the watch, and stopping it must not discard the reading it produced.
	return json({ ok: true, status: 'completed' });
};
