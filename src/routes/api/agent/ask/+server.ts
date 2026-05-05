import { json, error } from '@sveltejs/kit';
import { askBims, ALLOWED_MODELS, DEFAULT_MODEL, type AskBimsMessage, type AskBimsModel } from '$lib/server/ask-bims';
import { hasPermission } from '$lib/server/permissions';
import type { RequestHandler } from './$types';

const ADMIN_ONLY_MODELS: AskBimsModel[] = ['claude-opus-4-7'];

/**
 * POST /api/agent/ask
 * Body: { history: [{ role, content }, ...], model?: 'claude-haiku-4-5' | 'claude-sonnet-4-6' | 'claude-opus-4-7' }
 * Returns: { answer, toolCalls, usage, model, error? }
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');

	const body = await request.json().catch(() => null);
	if (!body?.history || !Array.isArray(body.history)) {
		return json({ error: 'history array required' }, { status: 400 });
	}

	const requestedModel = typeof body.model === 'string' ? body.model : DEFAULT_MODEL;
	const model: AskBimsModel = (ALLOWED_MODELS as string[]).includes(requestedModel)
		? (requestedModel as AskBimsModel)
		: DEFAULT_MODEL;

	if (ADMIN_ONLY_MODELS.includes(model) && !hasPermission(locals.user, 'admin:full')) {
		return json({ error: `Model ${model} requires admin:full permission.` }, { status: 403 });
	}

	const history: AskBimsMessage[] = body.history.map((m: any) => ({
		role: m.role === 'assistant' ? 'assistant' : 'user',
		content: String(m.content ?? '')
	}));

	try {
		const result = await askBims(history, { model });
		return json(result);
	} catch (err: any) {
		console.error('[ASK-BIMS] error:', err);
		return json({ answer: '', toolCalls: [], error: err?.message ?? String(err) }, { status: 500 });
	}
};
