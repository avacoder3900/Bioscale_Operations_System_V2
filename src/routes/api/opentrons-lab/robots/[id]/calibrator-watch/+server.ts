/**
 * Start a live limit-switch watch on the tip calibrator.
 * POST /api/opentrons-lab/robots/:id/calibrator-watch
 *   { runId, pipetteId, durationMs? }  →  { ok, commandId, expiresAt }
 *
 * The operator hand-jogs the tip onto the calibrator while this runs; every time
 * a limit switch closes, the daemon records WHICH switch, WHEN, and where the
 * pipette was at that instant, and appends it to the command's events[]. The
 * Studio polls the sibling [commandId] route to render them live.
 *
 * Why this exists alongside /api/scanner/calibrate-tip: that endpoint runs the
 * closed-loop creep probe, which drives the gantry itself and reports a single
 * net adjust{x,y} — it throws away when and where each switch actually closed.
 * Locating the fixture by hand needs the opposite: no motion from us, and the
 * individual trips.
 *
 * THIS COMMAND COMMANDS NO MOTION. It attaches to the Studio's already-open
 * maintenance run and only READS position (the same ATTACHED mode
 * execute_calibrate_tip uses). runId and pipetteId are therefore both required
 * and fail closed — a watch without a run to attach to would either be a no-op
 * or, worse, tempt the daemon into opening its own run and moving an arm the
 * operator has their hands on.
 *
 * Returns as soon as the command is queued. It is deliberately NOT synchronous
 * like the probe: a watch lasts as long as the operator takes to jog, which is
 * minutes, and nothing useful can be reported until they get there.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot, bridgeDeviceIdForRobot } from '$lib/server/opentrons/proxy';
import { connectDB, Ot2BridgeCommand, AuditLog, generateId } from '$lib/server/db';

/**
 * How long a watch may stay armed, in ms. Long enough for an unhurried jog onto
 * the fixture, short enough that a forgotten watch releases the calibrator's
 * serial port rather than holding it against the next operation. The Studio's
 * Stop button and the daemon's own deadline both end it early.
 */
const DEFAULT_DURATION_MS = 10 * 60_000;
const MAX_DURATION_MS = 30 * 60_000;

export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');
	const user = locals.user;

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	const body = await request.json().catch(() => ({}) as any);
	// Both fail closed — see the ATTACHED-only note above.
	const runId = body?.runId?.toString().trim();
	const pipetteId = body?.pipetteId?.toString().trim();
	if (!runId || !pipetteId) {
		error(400, 'runId and pipetteId are required — a watch attaches to the open maintenance run');
	}

	const requested = Number(body?.durationMs);
	const durationMs = Number.isFinite(requested)
		? Math.min(Math.max(requested, 30_000), MAX_DURATION_MS)
		: DEFAULT_DURATION_MS;

	await connectDB();

	// One watch at a time per robot: two daemons contending for the calibrator's
	// serial port would each see half the trips, and neither would be wrong in a
	// way anyone could spot. Retire the old one rather than refusing, so a
	// browser that closed mid-watch cannot lock the operator out.
	const superseded = await Ot2BridgeCommand.updateMany(
		{ robotId: String(robot._id), kind: 'calibrator_watch', status: { $in: ['pending', 'claimed'] } },
		{ $set: { status: 'expired', error: 'Superseded by a new watch', completedAt: new Date() } }
	);

	const deviceId = bridgeDeviceIdForRobot(robot);
	const cmd = await Ot2BridgeCommand.create({
		_id: generateId(),
		robotId: String(robot._id),
		deviceId,
		kind: 'calibrator_watch',
		payload: { runId, pipetteId, durationMs },
		events: [],
		// The command must survive unclaimed for as long as the daemon's poll
		// interval plus a margin; the watch's own length is durationMs, enforced
		// daemon-side once it is claimed.
		ttlMs: 60_000,
		requestedBy: user.username
	});

	await AuditLog.create({
		_id: generateId(),
		tableName: 'ot2_bridge_commands',
		recordId: cmd._id,
		action: 'calibrator_watch_start',
		newData: { robotId: String(robot._id), deviceId, runId, pipetteId, durationMs },
		changedAt: new Date(),
		changedBy: user.username
	});

	return json({
		ok: true,
		commandId: cmd._id,
		durationMs,
		expiresAt: new Date(Date.now() + durationMs).toISOString(),
		supersededCount: superseded?.modifiedCount ?? 0
	});
};
