/**
 * GET /api/opentrons-lab/robots/:id/bridge-token?kinds=sweep,scan
 * (OT2-TAILNET-5 §7.3, S5)
 *
 * Mints a 5-minute HMAC token the browser sends as `Authorization: Bearer …`
 * to the robot daemon's /bridge job server
 * (https://ot2-<slot>.tailf65a70.ts.net/bridge/…). Modelled on the CV station
 * token (/api/cv/stations/[id]/token): the signing secret never leaves BIMS and
 * the robot, and every mint is audit-logged.
 *
 *   kinds   comma list from the daemon's allowlist (sweep, deck_scan,
 *           calibrate_tip, tip_swap_request, restart_robot_server,
 *           auto_resume_run, scan). Empty/absent = a health-only token.
 *
 * 200 { token, exp, kinds, deviceId }   exp = unix seconds
 * 400 unknown kind · 401/403 auth · 404 robot · 409 robot not on the tailnet
 * line in this deployment (two-key gate) · 503 OT2_BRIDGE_TOKEN_SECRET unset.
 *
 * Token wire format: see $lib/server/opentrons/bridge-token.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, OpentronsRobot, AuditLog, generateId } from '$lib/server/db';
import { getRobot, bridgeDeviceIdForRobot } from '$lib/server/opentrons/proxy';
import {
	BRIDGE_TOKEN_TTL_S,
	bridgeTokenSecret,
	mintBridgeToken,
	parseBridgeKinds,
	tailnetLineGate
} from '$lib/server/opentrons/bridge-token';
import { BRIDGE_TOKEN_KINDS } from '$lib/opentrons/bridge-client';

export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');
	const user = locals.user;

	const { kinds, unknown } = parseBridgeKinds(url.searchParams.get('kinds'));
	if (unknown.length > 0) {
		return json(
			{ error: `unknown bridge job kind(s): ${unknown.join(', ')} (allowed: ${BRIDGE_TOKEN_KINDS.join(', ')})` },
			{ status: 400 }
		);
	}

	let robot = await getRobot(params.id);
	if (!robot) {
		await connectDB();
		robot = (await OpentronsRobot.findOne({ legacyRobotId: params.id, isActive: { $ne: false } }).lean()) as any;
	}
	if (!robot) error(404, 'Robot not found');

	const gate = tailnetLineGate(robot);
	if (!gate.ok) return json({ error: gate.reason, reason: gate.reason }, { status: 409 });

	const secret = bridgeTokenSecret();
	if (!secret) {
		return json({ error: 'OT2_BRIDGE_TOKEN_SECRET is not set on this deployment' }, { status: 503 });
	}

	const robotId = String(robot._id);
	const deviceId = bridgeDeviceIdForRobot(robot);
	const { token, exp, claims } = mintBridgeToken({ robotId, deviceId, kinds, sub: user.username }, secret);

	await connectDB();
	await AuditLog.create({
		_id: generateId(),
		tableName: 'opentrons_robots',
		recordId: robotId,
		action: 'bridge_token_issued',
		newData: { kinds, deviceId, exp, jti: claims.jti, ttlS: BRIDGE_TOKEN_TTL_S },
		changedAt: new Date(),
		changedBy: user.username
	});

	return json({ token, exp, kinds, deviceId }, { headers: { 'cache-control': 'no-store' } });
};
