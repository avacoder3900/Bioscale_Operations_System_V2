/**
 * OT-2 bridge daemon → BIMS command completion (OT2-BRIDGE-1).
 *
 * Request:
 *   POST /api/agent/ot2/commands/<id>/result
 *   { ok: boolean, status?: number, body?: unknown, error?: string }
 *
 * ok=true  → command completed; result.{status,body} is the robot's HTTP
 *            response (kind 'http') or the routine outcome (sweep/deck_scan).
 * ok=false → command failed; error carries the daemon's reason.
 */
import { json, error } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, Ot2BridgeCommand } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, params }) => {
	requireAgentApiKey(request);

	let body: any;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	await connectDB();

	const now = new Date();
	const update = body?.ok
		? {
			status: 'completed',
			result: {
				status: Number(body?.status ?? 200),
				body: body?.body ?? null
			},
			completedAt: now
		}
		: {
			status: 'failed',
			error: typeof body?.error === 'string' ? body.error.slice(0, 2000) : 'Bridge daemon reported failure',
			completedAt: now
		};

	const doc = await Ot2BridgeCommand.findOneAndUpdate(
		{ _id: params.id, status: 'claimed' },
		{ $set: update },
		{ new: true }
	).select('_id status').lean() as any;

	if (!doc) {
		// Already terminal (e.g. expired by a waiting caller) or unknown id —
		// tell the daemon so it stops retrying, but don't 500.
		const existing = await Ot2BridgeCommand.findById(params.id).select('status').lean() as any;
		return json({ success: false, status: existing?.status ?? 'not_found' }, { status: existing ? 409 : 404 });
	}

	return json({ success: true, status: doc.status });
};
