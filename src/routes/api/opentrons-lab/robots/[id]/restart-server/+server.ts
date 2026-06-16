/**
 * Restart the OT-2 robot-server (recovery for a hung engine).
 * POST /api/opentrons-lab/robots/:id/restart-server
 *
 * The robot-server restart takes ~90s — longer than a serverless function — so
 * this is fire-and-forget: it enqueues a `restart_robot_server` bridge command,
 * briefly waits to confirm the daemon CLAIMED it (proof the bridge is alive),
 * then returns. The health badge reflects recovery on the next heartbeat.
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

export const config = { maxDuration: 30 };

const POLL_INTERVAL_MS = 400;
const CLAIM_WAIT_MS = 12_000;
const COMMAND_TTL_MS = 150_000; // give the daemon ample time to restart + verify

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const POST: RequestHandler = async ({ params, locals }) => {
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

	await connectDB();
	const deviceId = bridgeDeviceIdForRobot(robot);
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
