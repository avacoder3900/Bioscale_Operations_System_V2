/**
 * In-app trigger enqueue.
 *
 * Browser → POST /api/scanner/trigger { deviceId, source?, contextRef? }
 * Authenticated by user session + manufacturing:write permission.
 *
 * Inserts a row into scanner_triggers; the daemon polls
 * /api/agent/scanner/triggers and consumes it.
 *
 * TAILNET LINE (OT2-TAILNET-5 S6, opt-in): `line: 'tailnet'` + `robotId`
 * writes NO ScannerTrigger (nothing to queue) and returns
 * `job: { kind: 'scan', payload: { source, contextRef } }` for the browser to
 * POST to the robot daemon's /bridge/scan. The daemon runs the same test-scan
 * the trigger loop runs (same ScannerPort lock) and posts the same ScannerEvent
 * to /api/agent/scanner/event, so /api/scanner/events shows it as before.
 * 409 when the robot is not on the tailnet line here (two-key gate), or this deployment has no OT2_BRIDGE_TOKEN_SECRET (bridgeJobGate).
 * The browser half is $lib/opentrons/studio-bridge-jobs testScanOverBridge
 * (prepare → /bridge/scan, never retried → the ScannerEvent read back from
 * /api/scanner/events by metadata.bridgeScanId). The tailnet prepare writes
 * nothing, so a failed scan leaves no row to close.
 */
import { json, error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, OpentronsRobot, ScannerTrigger } from '$lib/server/db';
import { getRobot } from '$lib/server/opentrons/proxy';
import { bridgeJobGate, isTailnetLineRequest } from '$lib/server/opentrons/bridge-token';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals, url }) => {
	if (!locals.user) throw error(401, 'Not signed in');
	requirePermission(locals.user, 'manufacturing:write');

	let body: any;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	const deviceId = typeof body?.deviceId === 'string' ? body.deviceId.trim() : '';
	if (!deviceId) throw error(400, 'deviceId is required');

	const source = ['test', 'wax_filling', 'reagent_filling', 'manual'].includes(body?.source)
		? body.source : 'test';

	if (isTailnetLineRequest(body, url)) {
		const robotId = typeof body?.robotId === 'string' ? body.robotId.trim() : '';
		if (!robotId) throw error(400, 'robotId is required for the tailnet line');
		let robot = await getRobot(robotId);
		if (!robot) {
			await connectDB();
			robot = (await OpentronsRobot.findOne({ legacyRobotId: robotId, isActive: { $ne: false } }).lean()) as any;
		}
		if (!robot) throw error(404, 'Robot not found');
		const gate = bridgeJobGate(robot);
		if (!gate.ok) throw error(409, gate.reason);
		return json({
			success: true,
			line: 'tailnet',
			job: {
				kind: 'scan',
				payload: {
					source,
					...(typeof body?.contextRef === 'string' ? { contextRef: body.contextRef } : {})
				}
			}
		});
	}

	await connectDB();
	const trigger = await ScannerTrigger.create({
		deviceId,
		source,
		contextRef: typeof body?.contextRef === 'string' ? body.contextRef : undefined,
		requestedBy: locals.user._id,
		requestedByUsername: locals.user.username,
		requestedAt: new Date()
	});

	return json({ success: true, triggerId: trigger._id });
};
