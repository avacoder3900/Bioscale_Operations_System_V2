import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

/**
 * Timing-safe string comparison: compares character-by-character but
 * always checks all characters, so mismatch position never leaks.
 */
function timingSafeEqual(expected: string, actual: string): boolean {
	if (actual.length !== expected.length) return false;
	let mismatch = 0;
	for (let i = 0; i < expected.length; i++) {
		mismatch |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
	}
	return mismatch === 0;
}

function extractKey(request: Request): string | null {
	return (
		request.headers.get('x-api-key') ||
		request.headers.get('x-agent-api-key') ||
		request.headers.get('authorization')?.replace('Bearer ', '') ||
		null
	);
}

/**
 * Validates the agent API key from request headers.
 * Uses timing-safe comparison to prevent key extraction via timing attacks.
 * Accepts: x-api-key, x-agent-api-key, or Authorization: Bearer <key>
 */
export function requireAgentApiKey(request: Request): void {
	const key = extractKey(request);
	if (!env.AGENT_API_KEY || !key || !timingSafeEqual(env.AGENT_API_KEY, key)) {
		throw error(401, 'Invalid or missing API key');
	}
}

/**
 * Auth for robot-arm agent endpoints (webhook, runs).
 *
 * Accepts the dedicated ROBOT_ARM_AGENT_KEY (what the Pi sends as
 * x-agent-api-key) so the arm has its own rotatable credential, and falls
 * back to the shared AGENT_API_KEY for operator tooling that already uses
 * it. Same header set and timing-safe comparison as requireAgentApiKey.
 */
export function requireRobotArmAgentKey(request: Request): void {
	const key = extractKey(request);
	if (!key) throw error(401, 'Invalid or missing API key');

	const accepted = [env.ROBOT_ARM_AGENT_KEY, env.AGENT_API_KEY].filter(
		(k): k is string => Boolean(k)
	);
	if (!accepted.some((expected) => timingSafeEqual(expected, key))) {
		throw error(401, 'Invalid or missing API key');
	}
}
