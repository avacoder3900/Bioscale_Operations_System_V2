/**
 * Scanner bridge daemon → BIMS trigger queue claim.
 *
 * Daemon polls this every ~500ms with its deviceId. Returns any
 * pending triggers and atomically marks them consumed so a second
 * poller can't double-fire. Authenticated by AGENT_API_KEY.
 *
 * Request:
 *   POST /api/agent/scanner/triggers
 *   { deviceId: string, max?: number }
 *
 * Response:
 *   { success: true, triggers: [{ _id, deviceId, source, contextRef, requestedAt }] }
 */
import { json, error } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, ScannerTrigger } from '$lib/server/db';
import type { RequestHandler } from './$types';

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

	const max = Math.max(1, Math.min(20, Number(body?.max) || 5));

	await connectDB();

	// Claim up to `max` pending triggers atomically. findOneAndUpdate in a
	// loop avoids the read-then-write race; with the (deviceId, consumedAt,
	// requestedAt) index, claims are O(log n) per call.
	const claimed: any[] = [];
	for (let i = 0; i < max; i++) {
		const doc = await ScannerTrigger.findOneAndUpdate(
			{ deviceId, consumedAt: null },
			{ $set: { consumedAt: new Date() } },
			{ new: true, sort: { requestedAt: 1 } }
		).lean();
		if (!doc) break;
		claimed.push(doc);
	}

	return json({
		success: true,
		triggers: JSON.parse(JSON.stringify(claimed))
	});
};
