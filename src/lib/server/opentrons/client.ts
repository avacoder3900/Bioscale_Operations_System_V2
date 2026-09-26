/**
 * Server-side wrapper over the isomorphic robot client ($lib/opentrons/robot-client).
 *
 * Binds a client to a robot's LAN address with plain fetch — for scripts run
 * from a lab machine (scripts/verify-opentrons-clone.ts) and any leftover
 * server use. Pages do NOT use this: they call the robot from the browser over
 * the robot session (OT2-TAILNET-5 §7.8), because Vercel can't reach the LAN.
 */
import {
	createRobotClient as createIsomorphicClient,
	unwrap,
	type OpentronsClient
} from '../../opentrons/robot-client';

export type { OpentronsClient, paths } from '../../opentrons/robot-client';
export { unwrap };

export interface RobotEndpoint {
	ip: string;
	port?: number | null;
}

const DEFAULT_PORT = 31950;
const DEFAULT_TIMEOUT_MS = 10_000;

export function robotBaseUrl(robot: RobotEndpoint): string {
	const port = robot.port ?? DEFAULT_PORT;
	return `http://${robot.ip}:${port}`;
}

/**
 * Create a typed client bound to a specific robot. Each call forwards to the
 * robot with a timeout and `opentrons-version: *`, exactly as before the move.
 */
export function createRobotClient(robot: RobotEndpoint, options: { timeoutMs?: number } = {}): OpentronsClient {
	return createIsomorphicClient({
		baseUrl: robotBaseUrl(robot),
		timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		versionHeader: '*'
	});
}
