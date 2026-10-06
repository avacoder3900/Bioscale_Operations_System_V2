/**
 * Which line does BIMS use to reach a robot? (OT2-TAILNET-4)
 *
 * TWO keys, both required, so a robot never lands on the tailnet line by accident:
 *
 *   1. The robot is PROVISIONED — its record says connection.mode = 'tailnet'
 *      with a valid directUrl (set on /opentrons/devices/[robotId]/edit).
 *   2. This DEPLOYMENT allows it — OT2_TAILNET_ROBOT_IDS lists the robot
 *      (same matching as DECK_HARDENING_ROBOT_IDS: _id, name, serial or "b14").
 *
 * Previews share the production database, so key 1 alone would switch a robot
 * everywhere at once. Key 2 is what makes a preview a test environment: set
 * OT2_TAILNET_ROBOT_IDS=b14 on Vercel's Preview env only, and production keeps
 * the queue until someone sets it there too. Unset = every robot on the queue.
 *
 * Anything else — unset, 'queue', bad URL, not allowed here — is the queue:
 * exactly today's behaviour.
 */
import { parseRobotTokens, robotMatchesTokens } from '$lib/server/services/deck-calibration/rollout';

export type RobotConnection =
	| { transport: 'tailnet'; directUrl: string; reason: string }
	| { transport: 'queue'; directUrl?: undefined; reason: string };

/** https://<host>.tailf65a70.ts.net — https (mixed content), tailnet-only host, no port/path. */
export const TAILNET_URL_RE = /^https:\/\/[a-z0-9-]+\.tailf65a70\.ts\.net$/;

export function isValidDirectUrl(url: unknown): url is string {
	return typeof url === 'string' && TAILNET_URL_RE.test(url);
}

export function tailnetRobotTokens(): Set<string> {
	return parseRobotTokens(process.env.OT2_TAILNET_ROBOT_IDS);
}

/** True when this deployment's OT2_TAILNET_ROBOT_IDS lists the robot. */
export function tailnetAllowedHere(robot: unknown): boolean {
	return robotMatchesTokens(robot, tailnetRobotTokens());
}

export function resolveRobotConnection(robot: {
	_id?: unknown;
	name?: unknown;
	legacyRobotId?: unknown;
	robotSerial?: unknown;
	connection?: { mode?: string; directUrl?: string } | null;
}): RobotConnection {
	const c = robot?.connection;
	if (!c || c.mode !== 'tailnet') {
		return { transport: 'queue', reason: 'queue — robot not switched to tailnet' };
	}
	if (!isValidDirectUrl(c.directUrl)) {
		return { transport: 'queue', reason: 'queue — robot is set to tailnet but has no valid direct URL' };
	}
	if (!tailnetAllowedHere(robot)) {
		return { transport: 'queue', reason: 'queue — tailnet not enabled for this robot in this deployment (OT2_TAILNET_ROBOT_IDS)' };
	}
	return { transport: 'tailnet', directUrl: c.directUrl, reason: 'tailnet — browser talks to the robot directly' };
}
