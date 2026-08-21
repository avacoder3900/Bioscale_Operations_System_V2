import { error } from '@sveltejs/kit';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { env } from '$env/dynamic/private';
import { buildBimsMcpServer } from '$lib/server/mcp/bims-mcp';
import type { RequestHandler } from './$types';

/**
 * Path-embedded-key variant of the MCP endpoint (the Zapier-style pattern):
 *   https://<host>/api/mcp/k/<MCP_API_KEY>
 *
 * Exists for MCP clients whose connector UI accepts only a URL (no request
 * headers) — the key rides in the path, which survives any client-side URL
 * handling that might drop query strings. Same stateless handler as /api/mcp.
 */
function requireKeyParam(key: string | undefined): void {
	const expected = env.MCP_API_KEY || env.AGENT_API_KEY;
	if (!expected || !key || key.length !== expected.length) {
		throw error(401, 'Invalid or missing MCP key');
	}
	let mismatch = 0;
	for (let i = 0; i < expected.length; i++) {
		mismatch |= expected.charCodeAt(i) ^ key.charCodeAt(i);
	}
	if (mismatch !== 0) {
		throw error(401, 'Invalid or missing MCP key');
	}
}

const handleMcp: RequestHandler = async (event) => {
	requireKeyParam(event.params.key);
	const handler = createMcpHandler(() => buildBimsMcpServer(event.fetch));
	return handler.fetch(event.request);
};

export const POST = handleMcp;
export const GET = handleMcp;
export const DELETE = handleMcp;
