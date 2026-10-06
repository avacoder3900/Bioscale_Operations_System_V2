/**
 * Restart the OT-2 robot-server (recovery for a hung engine).
 * POST /api/opentrons-lab/robots/:id/restart-server
 *
 * The robot-server restart takes ~90s — longer than a serverless function — so
 * this is fire-and-forget: it enqueues a `restart_robot_server` bridge command,
 * briefly waits to confirm the daemon CLAIMED it (proof the bridge is alive),
 * then returns. The health badge reflects recovery on the next heartbeat.
 *
 * TAILNET PREPARE (OT2-TAILNET-5 S6, opt-in): `?line=tailnet` (or JSON body
 * `{ line: 'tailnet' }`) writes the same AuditLog 'restart_robot_server'
 * (stamped line:'tailnet', bridgeJobId, commandId null) but enqueues nothing;
 * it returns `job: { jobId, kind: 'restart_robot_server', payload: {} }` for
 * the browser to POST to the robot daemon's /bridge/jobs, where the same
 * restart handler (with its restart-storm guard) runs. 409 when the robot is
 * not on the tailnet line here (two-key gate), or this deployment has no OT2_BRIDGE_TOKEN_SECRET (bridgeJobGate). No flag = today's behaviour.
 *
 * TAILNET ABANDON: `{ line: 'tailnet', phase: 'abandon', jobId, error }` — the
 * browser's /bridge submit failed after the prepare. Nothing ran on the robot;
 * AuditLog 'restart_robot_server_submit_failed' records that the audited
 * restart never reached it (no retry, no queue re-send).
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import {
	connectDB,
	OpentronsRobot,
	Ot2BridgeCommand,
	AuditLog,
	generateId
} from '$lib/server/db';
import { getRobot, bridgeDeviceIdForRobot } from '$lib/server/opentrons/proxy';
import { bridgeJobGate, isTailnetLineRequest } from '$lib/server/opentrons/bridge-token';

export const config = { maxDuration: 30 };

const POLL_INTERVAL_MS = 400;
const CLAIM_WAIT_MS = 12_000;
const COMMAND_TTL_MS = 150_000; // give the daemon ample time to restart + verify

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const POST: RequestHandler = async ({ params, locals, request, url }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');
	const user = locals.user;

	let robot = await getRobot(params.id);
	if (!robot) {
		await connectDB();
		robot = (await OpentronsRobot.findOne({
			legacyRobotId: params.id,
			isActive: { $ne: false }
		}).lean()) as any;
	}
	if (!robot) error(404, 'Robot not found');

	// Only read a body when the query flag is absent — today's callers send none.
	const body: any = url.searchParams.get('line') === 'tailnet' ? null : await request.json().catch(() => null);
	const tailnet = url.searchParams.get('line') === 'tailnet' || isTailnetLineRequest(body, null);

	await connectDB();
	const deviceId = bridgeDeviceIdForRobot(robot);

	if (tailnet && body?.phase === 'abandon') {
		const jobId = body?.jobId?.toString() ?? '';
		if (!/^[A-Za-z0-9_-]{6,64}$/.test(jobId)) error(400, 'jobId required to abandon a tailnet restart');
		const reason = (typeof body?.error === 'string' && body.error.trim() ? body.error.trim() : 'bridge submit failed').slice(0, 500);
		await AuditLog.create({
			_id: generateId(),
			tableName: 'opentrons_robots',
			recordId: String(robot._id),
			action: 'restart_robot_server_submit_failed',
			newData: { deviceId, commandId: null, bridgeJobId: jobId, line: 'tailnet', error: reason },
			changedAt: new Date(),
			changedBy: user.username
		});
		return json({ success: true, abandoned: true });
	}

	if (tailnet) {
		const gate = bridgeJobGate(robot);
		if (!gate.ok) error(409, gate.reason);
		const bridgeJobId = generateId();
		await AuditLog.create({
			_id: generateId(),
			tableName: 'opentrons_robots',
			recordId: String(robot._id),
			action: 'restart_robot_server',
			newData: { deviceId, commandId: null, bridgeJobId, line: 'tailnet' },
			changedAt: new Date(),
			changedBy: user.username
		});
		return json({
			success: true,
			line: 'tailnet',
			job: { jobId: bridgeJobId, kind: 'restart_robot_server', payload: {} }
		});
	}

	const cmd = await Ot2BridgeCommand.create({
		_id: generateId(),
		robotId: String(robot._id),
		deviceId,
		kind: 'restart_robot_server',
		ttlMs: COMMAND_TTL_MS,
		requestedBy: user.username
	});

	await AuditLog.create({
		_id: generateId(),
		tableName: 'opentrons_robots',
		recordId: String(robot._id),
		action: 'restart_robot_server',
		newData: { deviceId, commandId: cmd._id },
		changedAt: new Date(),
		changedBy: user.username
	});

	// Wait briefly for the daemon to CLAIM the command — confirms the bridge is
	// online so we can tell the operator "restarting" vs "bridge is offline".
	const deadline = Date.now() + CLAIM_WAIT_MS;
	let claimed = false;
	while (Date.now() < deadline) {
		const doc = (await Ot2BridgeCommand.findById(cmd._id).select('status').lean()) as any;
		if (doc && doc.status !== 'pending') {
			claimed = true;
			break;
		}
		await sleep(POLL_INTERVAL_MS);
	}

	return json({
		success: true,
		claimed,
		message: claimed
			? 'Restart sent — the robot server will be back in ~90s. Watch the health badge.'
			: 'Restart queued, but the bridge has not picked it up yet — it may be offline.'
	});
};
