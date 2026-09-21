import { createMcpHandler } from '@modelcontextprotocol/server';
import { buildBimsMcpServer } from '$lib/server/mcp/bims-mcp';
import { requireMcpKey } from '$lib/server/mcp/auth';
import type { RequestHandler } from './$types';

/**
 * Remote MCP endpoint (Streamable HTTP) for BIMS.
 *
 * Deployed with the app on Vercel, so it is publicly reachable over HTTPS —
 * a requirement for Claude custom connectors, which connect from Anthropic's
 * cloud, never from localhost.
 *
 * Stateless: createMcpHandler builds a fresh server (via buildBimsMcpServer)
 * for every request, so this scales across serverless instances with no
 * session affinity. The server is constructed per-request anyway, which lets
 * the tools use event.fetch for zero-round-trip internal calls to /api/agent/*.
 *
 * Auth: requireMcpKey — Bearer header, x-api-key header, or ?key= query param
 * (the query form exists because the Claude connector UI only accepts a URL).
 */
const handleMcp: RequestHandler = async (event) => {
	requireMcpKey(event);
	const handler = createMcpHandler(() => buildBimsMcpServer(event.fetch));
	return handler.fetch(event.request);
};

export const POST = handleMcp;
export const GET = handleMcp;
export const DELETE = handleMcp;
