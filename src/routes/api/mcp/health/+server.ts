import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';

/**
 * TEMPORARY connector-setup diagnostic (safe: reports key presence + length only,
 * never values). Lets us verify the Vercel env actually contains MCP_API_KEY
 * without dashboard access. Remove (or session-gate) once the connector works.
 */
export const GET: RequestHandler = async () => {
	return json({
		ok: true,
		gitSha: env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) ?? null,
		gitBranch: env.VERCEL_GIT_COMMIT_REF ?? null,
		mcpKeySet: Boolean(env.MCP_API_KEY),
		mcpKeyLength: env.MCP_API_KEY?.length ?? 0,
		agentKeySet: Boolean(env.AGENT_API_KEY),
		agentKeyLength: env.AGENT_API_KEY?.length ?? 0
	});
};
