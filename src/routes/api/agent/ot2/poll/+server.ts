/**
 * OT-2 bridge daemon → BIMS command long-poll (OT2-BRIDGE-1).
 *
 * The on-robot daemon calls this with its deviceId; BIMS atomically claims
 * the oldest pending command for that device and returns it. If none is
 * pending, the request is held open (re-checking every 250ms) for up to
 * waitMs so command pickup is near-instant without hammering the queue.
 *
 * Request:
 *   POST /api/agent/ot2/poll
 *   { deviceId: string, waitMs?: number }   // waitMs capped at 20s
 *
 * Response:
 *   { success: true, command: { _id, kind, request?, payload? } | null }
 */
import { json, error } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, Ot2BridgeCommand } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const config = { maxDuration: 60 };

const RECHECK_MS = 250;
const MAX_WAIT_MS = 20_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);

	let body: any;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	const deviceId = typeof body?.deviceId === 'string' ? body.deviceId.trim() : '';
	if (!deviceId) throw error(400, 'deviceId is required');
	const waitMs = Math.max(0, Math.min(MAX_WAIT_MS, Number(body?.waitMs) || 0));

	await connectDB();

	// Expire overdue pending commands for this device so a caller waiting on
	// one of them gets a terminal status instead of silence. completedAt is
	// set so the TTL index ages them out.
	const now = new Date();
	await Ot2BridgeCommand.updateMany(
		{
			deviceId,
			status: 'pending',
			$expr: { $lt: ['$createdAt', { $subtract: [now, '$ttlMs'] }] }
		},
		{ $set: { status: 'expired', error: 'Not claimed by bridge daemon within ttlMs', completedAt: now } }
	);

	const deadline = Date.now() + waitMs;
	do {
		const doc = await Ot2BridgeCommand.findOneAndUpdate(
			{ deviceId, status: 'pending' },
			{ $set: { status: 'claimed', claimedAt: new Date() } },
			{ new: true, sort: { createdAt: 1 } }
		).lean() as any;

		if (doc) {
			return json({
				success: true,
				command: JSON.parse(JSON.stringify({
					_id: String(doc._id),
					kind: doc.kind,
					request: doc.request ?? null,
					payload: doc.payload ?? null
				}))
			});
		}
		if (Date.now() + RECHECK_MS > deadline) break;
		await sleep(RECHECK_MS);
	} while (Date.now() < deadline);

	return json({ success: true, command: null });
};
