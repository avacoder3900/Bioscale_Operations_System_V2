/**
 * POST /api/agent/ask/feedback
 *
 * Records an operator signal on a specific Ask BIMS answer. Two kinds of
 * signal, can coexist on one POST:
 *
 *   1. rating: 'up' | 'down'   — thumbs verdict ("this answer was wrong/right")
 *   2. flagged: true            — "Claude, look at this later" (review queue)
 *
 * At least ONE of (rating, flagged) must be present. comment/flagReason are
 * optional free-text — the widget should let the operator type a one-liner
 * for either signal.
 *
 * Session-cookie auth — same surface as POST /api/agent/ask.
 *
 * Body shape:
 *   {
 *     responseId: string,           // from AskBimsResult.responseId
 *     rating?: 'up' | 'down',       // optional if flagged=true
 *     comment?: string,             // optional free-text on rating
 *     flagged?: boolean,            // optional, true to add to review queue
 *     flagReason?: string,          // optional free-text on flag
 *     question: string,             // the user message that produced the answer
 *     answer: string,               // the assistant's final text
 *     toolsUsed?: string[],         // tool names from result.toolCalls
 *     model?: 'claude-haiku-4-5' | 'claude-sonnet-4-6' | 'claude-opus-4-7',
 *     confidence?: 'high' | 'partial' | 'degraded'
 *   }
 *
 * Returns: { ok: true, id: <row _id>, flagged: boolean, rating: 'up'|'down'|null }
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
	const flagged = body.flagged === true;
	const question = typeof body.question === 'string' ? body.question : '';
	const answer = typeof body.answer === 'string' ? body.answer : '';

	if (!responseId) return json({ error: 'responseId required' }, { status: 400 });
	if (!rating && !flagged) {
		return json({ error: "at least one of rating ('up'|'down') or flagged (true) required" }, { status: 400 });
	}
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
	const flagReason = typeof body.flagReason === 'string' && body.flagReason.trim()
		? body.flagReason.trim()
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
		comment,
		flagged,
		flagReason
	});

	return json({ ok: true, id: row._id, flagged, rating });
};
