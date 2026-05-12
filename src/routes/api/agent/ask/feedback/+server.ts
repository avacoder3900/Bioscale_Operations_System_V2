/**
 * POST /api/agent/ask/feedback
 *
 * Records a thumbs up/down rating on a specific Ask BIMS answer. The widget
 * sends the responseId from the AskBimsResult it's already showing, plus the
 * rating, plus an optional comment (for thumbs down). Session-cookie auth —
 * same surface as POST /api/agent/ask.
 *
 * The widget UI piece is a follow-up (.svelte change, out of scope for this
 * build). This endpoint is the server half — it's safe to wire buttons in
 * later without touching server code.
 *
 * Body shape:
 *   {
 *     responseId: string,           // from AskBimsResult.responseId
 *     rating: 'up' | 'down',
 *     comment?: string,             // optional, only meaningful on 'down'
 *     question: string,             // the user message that produced the answer
 *     answer: string,               // the assistant's final text
 *     toolsUsed?: string[],         // tool names from result.toolCalls
 *     model?: 'claude-haiku-4-5' | 'claude-sonnet-4-6' | 'claude-opus-4-7',
 *     confidence?: 'high' | 'partial' | 'degraded'
 *   }
 */
import { json, error } from '@sveltejs/kit';
import { connectDB, AskBimsFeedback } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');

	const body = await request.json().catch(() => null);
	if (!body) return json({ error: 'JSON body required' }, { status: 400 });

	const responseId = typeof body.responseId === 'string' ? body.responseId.trim() : '';
	const rating = body.rating === 'up' || body.rating === 'down' ? body.rating : null;
	const question = typeof body.question === 'string' ? body.question : '';
	const answer = typeof body.answer === 'string' ? body.answer : '';

	if (!responseId) return json({ error: 'responseId required' }, { status: 400 });
	if (!rating) return json({ error: "rating must be 'up' or 'down'" }, { status: 400 });
	if (!question || !answer) return json({ error: 'question and answer required' }, { status: 400 });

	const toolsUsed = Array.isArray(body.toolsUsed)
		? body.toolsUsed.filter((t: unknown) => typeof t === 'string')
		: [];
	const model = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-7'].includes(body.model)
		? body.model
		: undefined;
	const confidence = ['high', 'partial', 'degraded'].includes(body.confidence)
		? body.confidence
		: undefined;
	const comment = typeof body.comment === 'string' && body.comment.trim()
		? body.comment.trim()
		: null;

	await connectDB();
	const row = await AskBimsFeedback.create({
		timestamp: new Date(),
		userId: locals.user._id,
		username: locals.user.username,
		responseId,
		question,
		answer,
		toolsUsed,
		model,
		confidence,
		rating,
		comment
	});

	return json({ ok: true, id: row._id });
};
