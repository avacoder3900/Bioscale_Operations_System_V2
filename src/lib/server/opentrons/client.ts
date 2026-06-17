/**
 * Stateless typed client for the Opentrons OT-2 HTTP API.
 *
 * Wraps openapi-fetch with a factory that injects:
 *   - per-robot base URL
 *   - the required `opentrons-version` header
 *   - a short request timeout
 *
 * Every call is a live pass-through to the robot. No DB, no caching.
 */

import createClient, { type Middleware } from 'openapi-fetch';
import type { paths } from './openapi-types';

export type OpentronsClient = ReturnType<typeof createClient<paths>>;
export type { paths } from './openapi-types';

export interface RobotEndpoint {
	ip: string;
	port?: number | null;
}

const DEFAULT_PORT = 31950;
const DEFAULT_TIMEOUT_MS = 10_000;
const OPENTRONS_VERSION_HEADER = 'opentrons-version';
const OPENTRONS_VERSION_VALUE = '*';

export function robotBaseUrl(robot: RobotEndpoint): string {
	const port = robot.port ?? DEFAULT_PORT;
	return `http://${robot.ip}:${port}`;
}

/**
 * Create a typed client bound to a specific robot.
 * Each call forwards to the robot with a timeout; callers may override via init.signal.
 */
export function createRobotClient(
	robot: RobotEndpoint,
	options: { timeoutMs?: number } = {}
): OpentronsClient {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	const timeoutMiddleware: Middleware = {
		async onRequest({ request }) {
			if (request.signal) return request;
			const signal = AbortSignal.timeout(timeoutMs);
			return new Request(request, { signal });
		},
	};

	const headerMiddleware: Middleware = {
		async onRequest({ request }) {
			if (!request.headers.has(OPENTRONS_VERSION_HEADER)) {
				request.headers.set(OPENTRONS_VERSION_HEADER, OPENTRONS_VERSION_VALUE);
			}
			return request;
		},
	};

	const client = createClient<paths>({ baseUrl: robotBaseUrl(robot) });
	client.use(headerMiddleware, timeoutMiddleware);
	return client;
}

/**
 * Unwrap an openapi-fetch result, throwing on error.
 * Keep the signature loose — openapi-fetch's response shape carries rich generics
 * that aren't worth threading through every caller.
 */
export function unwrap<T>(res: { data?: T; error?: unknown; response: Response }): T {
	if (res.error !== undefined) {
		throw new Error(
			`Opentrons API error: ${res.response.status} ${res.response.statusText} — ${JSON.stringify(res.error)}`
		);
	}
	return res.data as T;
}
