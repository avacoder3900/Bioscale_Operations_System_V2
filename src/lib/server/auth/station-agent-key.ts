import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

/**
 * Validates STATION_AGENT_KEY from the request header.
 *
 * Used by Pi-side endpoints that authenticate as "the fleet" rather than as a
 * specific BIMS user — registration, heartbeat, status sweep. Mirrors
 * requireAgentApiKey in src/lib/server/api-auth.ts but reads a distinct env
 * var so the scanner-bridge key (AGENT_API_KEY) and the capture-station key
 * can rotate independently.
 *
 * Timing-safe: every successful early-exit path runs the same compare loop,
 * so wrong-key requests don't reveal length or prefix matches via timing.
 *
 * Fail-closed: an unset STATION_AGENT_KEY env var rejects every request.
 */
export function requireStationAgentKey(request: Request): void {
	const presented = request.headers.get('x-station-agent-key') ?? '';
	const expected = env.STATION_AGENT_KEY ?? '';

	if (!expected) {
		throw error(401, 'STATION_AGENT_KEY not configured');
	}
	if (!presented) {
		throw error(401, 'Station agent key required');
	}
	if (presented.length !== expected.length) {
		throw error(401, 'Invalid station agent key');
	}

	let mismatch = 0;
	for (let i = 0; i < expected.length; i++) {
		mismatch |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
	}

	if (mismatch !== 0) {
		throw error(401, 'Invalid station agent key');
	}
}
