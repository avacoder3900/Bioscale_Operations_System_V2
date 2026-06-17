import { json } from '@sveltejs/kit';
import { ALLOWED_MODELS, DEFAULT_MODEL } from '$lib/server/ask-bims';
import type { RequestHandler } from './$types';

/**
 * GET /api/agent/ask/health
 * Widget-side health probe for Ask BIMS. Returns config validity without
 * calling Anthropic. Anthropic reachability is observed implicitly through
 * /api/agent/ask error responses.
 */
export const GET: RequestHandler = async ({ locals }) => {
	const authenticated = Boolean(locals.user);
	const apiKeyConfigured = Boolean(process.env.ANTHROPIC_API_KEY);

	return json({
		ok: authenticated && apiKeyConfigured,
		authenticated,
		apiKeyConfigured,
		defaultModel: DEFAULT_MODEL,
		allowedModels: ALLOWED_MODELS,
		timestamp: new Date().toISOString()
	});
};
