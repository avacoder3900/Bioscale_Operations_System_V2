import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

/**
 * Consumer-app API key (CONSUMER_API_KEY) — a separate trust domain from the
 * agent key: the bioscale consumer app is public-facing and its key must be
 * rotatable without touching the lab-side agents. Same timing-safe comparison
 * as src/lib/server/api-auth.ts (SECURITY.md, "API Key Authentication").
 * Accepts `x-consumer-api-key` or `Authorization: Bearer <key>`.
 */
export function requireConsumerApiKey(request: Request): void {
	const key = request.headers.get('x-consumer-api-key')
		|| request.headers.get('authorization')?.replace('Bearer ', '');
	const expected = env.CONSUMER_API_KEY;

	if (!expected || !key || key.length !== expected.length) {
		throw error(401, 'Invalid or missing consumer API key');
	}
	let mismatch = 0;
	for (let i = 0; i < expected.length; i++) {
		mismatch |= expected.charCodeAt(i) ^ key.charCodeAt(i);
	}
	if (mismatch !== 0) throw error(401, 'Invalid or missing consumer API key');
}
