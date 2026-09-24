import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { forwardToResearch, researchPathAllowed } from '$lib/server/research-proxy';
import type { RequestHandler } from './$types';

/**
 * /api/agent/research/<path> — transparent proxy to brevitest-research-v2's
 * /api/agent/<path> for the analysis + calibration surface, so the BIMS MCP
 * connector can drive research analysis with the same key/actor conventions.
 *
 * Allowlisted prefixes only (analysis/, calibration/). The research app enforces
 * its own validation and records `agent:<actor>` on writes; BIMS's machineWrite
 * records the machine_activity row. Responses are passed through verbatim.
 */
const proxy: RequestHandler = async ({ request, params, url }) => {
	requireAgentApiKey(request);
	const path = params.path ?? '';
	if (!researchPathAllowed(path)) {
		return json({ success: false, error: `Path not proxied: ${path}` }, { status: 404 });
	}
	const method = request.method === 'POST' ? 'POST' : 'GET';
	const body = method === 'POST' ? await request.text() : undefined;
	const result = await forwardToResearch(path, { method, query: url.searchParams, body });
	return new Response(result.body, { status: result.status, headers: { 'content-type': 'application/json' } });
};

export const GET = proxy;
export const POST = proxy;
