import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestEvent } from '@sveltejs/kit';

/**
 * Validates the MCP connector key for the /api/mcp endpoint.
 *
 * Accepts, in order of preference:
 *   - Authorization: Bearer <key>   (MCP clients that support headers, e.g. mcp-remote)
 *   - x-api-key: <key>
 *   - ?key=<key> query parameter    (claude.ai / Claude Desktop custom connectors,
 *                                    whose UI only accepts a URL — the key rides in the URL)
 *
 * Compares against MCP_API_KEY, falling back to AGENT_API_KEY when MCP_API_KEY is
 * unset. Keep MCP_API_KEY distinct in production so the connector key can rotate
 * independently of the device/IoT fleet key.
 */
export function requireMcpKey(event: RequestEvent): void {
	const expected = env.MCP_API_KEY || env.AGENT_API_KEY;
	const presented =
		event.request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ||
		event.request.headers.get('x-api-key') ||
		event.url.searchParams.get('key');

	if (!expected || !presented || presented.length !== expected.length) {
		throw error(401, 'Invalid or missing MCP key');
	}

	let mismatch = 0;
	for (let i = 0; i < expected.length; i++) {
		mismatch |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
	}

	if (mismatch !== 0) {
		throw error(401, 'Invalid or missing MCP key');
	}
}
