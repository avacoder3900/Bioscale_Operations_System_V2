import { json, error } from '@sveltejs/kit';
import { askBims, type AskBimsMessage } from '$lib/server/ask-bims';
import type { RequestHandler } from './$types';

/**
 * POST /api/agent/ask
 * Body: { history: [{ role, content }, ...] }
 * Returns: { answer, toolCalls, error? }
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');

	const body = await request.json().catch(() => null);
	if (!body?.history || !Array.isArray(body.history)) {
		return json({ error: 'history array required' }, { status: 400 });
	}

	const history: AskBimsMessage[] = body.history.map((m: any) => ({
		role: m.role === 'assistant' ? 'assistant' : 'user',
		content: String(m.content ?? '')
	}));

	try {
		const result = await askBims(history);
		return json(result);
	} catch (err: any) {
		console.error('[ASK-BIMS] error:', err);
		return json({ answer: '', toolCalls: [], error: err?.message ?? String(err) }, { status: 500 });
	}
};
