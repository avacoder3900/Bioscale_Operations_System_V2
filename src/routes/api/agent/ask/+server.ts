import Anthropic from '@anthropic-ai/sdk';
import { json, error } from '@sveltejs/kit';
import {
	askBims, ALLOWED_MODELS, DEFAULT_MODEL,
	checkDailyCap, type AskBimsMessage, type AskBimsModel
} from '$lib/server/ask-bims';
import { hasPermission } from '$lib/server/permissions';
import type { RequestHandler } from './$types';

const ADMIN_ONLY_MODELS: AskBimsModel[] = ['claude-opus-4-7'];

/**
 * POST /api/agent/ask
 * Body: { history: [{ role, content }, ...], model?: ... }
 * Returns: { answer, toolCalls, usage, model, error?, errorClass?, retryable? }
 *
 * Error classes:
 *   - 'auth' (permanent — bad API key)
 *   - 'rate_limit' (retryable, with retry-after hint)
 *   - 'service_unavailable' (retryable — Anthropic 5xx, network)
 *   - 'bad_request' (permanent — malformed request)
 *   - 'permission' (permanent — user lacks admin:full for Opus etc.)
 *   - 'daily_cap' (permanent until midnight — user or workspace daily cap hit)
 *   - 'internal' (uncategorized server error)
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');

	const body = await request.json().catch(() => null);
	if (!body?.history || !Array.isArray(body.history)) {
		return json({
			answer: '', toolCalls: [],
			error: 'history array required',
			errorClass: 'bad_request',
			retryable: false
		}, { status: 400 });
	}

	const requestedModel = typeof body.model === 'string' ? body.model : DEFAULT_MODEL;
	const model: AskBimsModel = (ALLOWED_MODELS as string[]).includes(requestedModel)
		? (requestedModel as AskBimsModel)
		: DEFAULT_MODEL;

	if (ADMIN_ONLY_MODELS.includes(model) && !hasPermission(locals.user, 'admin:full')) {
		return json({
			answer: '', toolCalls: [],
			error: `Model ${model} requires admin:full permission.`,
			errorClass: 'permission',
			retryable: false
		}, { status: 403 });
	}

	// Daily cap check — runs BEFORE the (potentially expensive) Anthropic call.
	const userId = locals.user._id as string;
	const username = locals.user.username as string;
	const cap = await checkDailyCap(userId, model);
	if (cap) {
		const message = cap.scope === 'workspace'
			? `Workspace daily cap of $${cap.capUsd.toFixed(2)} reached ($${cap.spentUsd.toFixed(2)} spent). Resets at midnight UTC.`
			: `Your daily cap on ${cap.model} of $${cap.capUsd.toFixed(2)} is reached ($${cap.spentUsd.toFixed(2)} spent). Try a cheaper model or wait until midnight UTC.`;
		return json({
			answer: '', toolCalls: [],
			error: message,
			errorClass: 'daily_cap',
			retryable: false,
			cap
		}, { status: 429 });
	}

	const history: AskBimsMessage[] = body.history.map((m: any) => ({
		role: m.role === 'assistant' ? 'assistant' : 'user',
		content: String(m.content ?? '')
	}));

	try {
		const isAdmin = hasPermission(locals.user, 'admin:full');
		const result = await askBims(history, { model, userId, username, isAdmin });
		return json(result);
	} catch (err: any) {
		console.error('[ASK-BIMS] error:', err);

		// Classify the error so the widget can decide whether to retry, hide,
		// or show a banner.
		if (err instanceof Anthropic.AuthenticationError) {
			return json({
				answer: '', toolCalls: [],
				error: 'ANTHROPIC_API_KEY is invalid or expired. Contact your admin.',
				errorClass: 'auth',
				retryable: false
			}, { status: 502 });
		}
		if (err instanceof Anthropic.RateLimitError) {
			const retryAfter = (err as any)?.headers?.['retry-after'];
			return json({
				answer: '', toolCalls: [],
				error: 'Anthropic rate limit hit. Please wait and retry.',
				errorClass: 'rate_limit',
				retryable: true,
				retryAfterSeconds: retryAfter ? Number(retryAfter) : 30
			}, { status: 429 });
		}
		if (err instanceof Anthropic.APIConnectionError || err instanceof Anthropic.InternalServerError) {
			return json({
				answer: '', toolCalls: [],
				error: 'Anthropic service is unavailable right now. Please try again shortly.',
				errorClass: 'service_unavailable',
				retryable: true
			}, { status: 503 });
		}
		if (err instanceof Anthropic.BadRequestError) {
			return json({
				answer: '', toolCalls: [],
				error: err?.message ?? 'Bad request to Anthropic.',
				errorClass: 'bad_request',
				retryable: false
			}, { status: 400 });
		}
		return json({
			answer: '', toolCalls: [],
			error: err?.message ?? String(err),
			errorClass: 'internal',
			retryable: false
		}, { status: 500 });
	}
};
