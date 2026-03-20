import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

/**
 * Validates the agent API key from request headers.
 * Uses timing-safe comparison to prevent key extraction via timing attacks.
 * Accepts: x-api-key, x-agent-api-key, or Authorization: Bearer <key>
 */
export function requireAgentApiKey(request: Request): void {
	const key = request.headers.get('x-api-key')
		|| request.headers.get('x-agent-api-key')
		|| request.headers.get('authorization')?.replace('Bearer ', '');

	if (!env.AGENT_API_KEY || !key) {
		throw error(401, 'Invalid or missing API key');
	}

	// Timing-safe comparison: compare character-by-character but always check all characters
	const expected = env.AGENT_API_KEY;
	if (key.length !== expected.length) {
		throw error(401, 'Invalid or missing API key');
	}

	let mismatch = 0;
	for (let i = 0; i < expected.length; i++) {
		mismatch |= expected.charCodeAt(i) ^ key.charCodeAt(i);
	}

	if (mismatch !== 0) {
		throw error(401, 'Invalid or missing API key');
	}
}
