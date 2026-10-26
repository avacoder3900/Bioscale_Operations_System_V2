/**
 * Scanner bridge daemon → BIMS event ingestion.
 *
 * The Lab Mac runs scripts/scanner-bridge.py, which POSTs every scan,
 * heartbeat, and error here. Authenticated by AGENT_API_KEY (same key
 * used by mocreo, openclaw, etc.).
 *
 * Body shape:
 *   {
 *     deviceId: string,                                  // required
 *     eventType: 'scan' | 'heartbeat' | 'error' | 'trigger_consumed',
 *     barcode?: string,                                  // for 'scan'
 *     rawPayload?: string,                               // raw bytes hex
 *     source?: 'test' | 'wax_filling' | 'reagent_filling' | 'manual' | 'unknown',
 *     contextRef?: string,                               // e.g. cartridgeId
 *     errorMessage?: string,                             // for 'error'
 *     metadata?: object
 *   }
 */
import { json, error } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, ScannerEvent } from '$lib/server/db';
import { sampleHeartbeatLink } from '$lib/server/services/robot-link/heartbeat-sample';
import type { RequestHandler } from './$types';

const VALID_TYPES = new Set(['scan', 'heartbeat', 'error', 'trigger_consumed']);
const VALID_SOURCES = new Set(['test', 'wax_filling', 'reagent_filling', 'manual', 'unknown']);

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);

	let body: any;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	const deviceId = typeof body?.deviceId === 'string' ? body.deviceId.trim() : '';
	const eventType = typeof body?.eventType === 'string' ? body.eventType : '';

	if (!deviceId) throw error(400, 'deviceId is required');
	if (!VALID_TYPES.has(eventType)) {
		throw error(400, `eventType must be one of: ${[...VALID_TYPES].join(', ')}`);
	}

	const source = VALID_SOURCES.has(body?.source) ? body.source : 'unknown';

	await connectDB();
	const now = new Date();

	// Heartbeats are liveness signals, not history: ONE doc per device,
	// overwritten in place. Storing every ping as a permanent row grew this
	// collection to 1.5M docs (Atlas incident, 2026-07-31). Consumers only
	// ever read the latest heartbeat per device, so the shape is unchanged.
	if (eventType === 'heartbeat') {
		const hbId = `hb:${deviceId}`;
		const metadata = body?.metadata && typeof body.metadata === 'object' ? body.metadata : undefined;
		// Same one-doc upsert; findOneAndUpdate (new:false) hands back the doc it
		// replaced so the heartbeat age at receipt costs no extra read.
		const prev = (await ScannerEvent.findOneAndUpdate(
			{ _id: hbId },
			{
				$set: {
					deviceId,
					eventType: 'heartbeat',
					source,
					metadata,
					receivedAt: now
				}
			},
			{ upsert: true, new: false, projection: { receivedAt: 1 } }
		).lean()) as { receivedAt?: Date } | null;
		const prevReceivedAt = prev?.receivedAt ? new Date(prev.receivedAt) : null;

		// OT2-LOG-1 L2a: ≤ 1 connectivity sample per minute from metadata.link.
		// Never fails the heartbeat (the sampler catches its own errors).
		const { sampled, ageMs } = await sampleHeartbeatLink({ deviceId, metadata, now, prevReceivedAt });
		console.log('[robot-link] hb', JSON.stringify({ deviceId, ageMs, sampled }));

		return json({ success: true, eventId: hbId, receivedAt: now });
	}

	const doc = await ScannerEvent.create({
		deviceId,
		eventType,
		barcode: typeof body?.barcode === 'string' ? body.barcode : undefined,
		rawPayload: typeof body?.rawPayload === 'string' ? body.rawPayload : undefined,
		source,
		contextRef: typeof body?.contextRef === 'string' ? body.contextRef : undefined,
		errorMessage: typeof body?.errorMessage === 'string' ? body.errorMessage : undefined,
		metadata: body?.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
		receivedAt: now
	});

	return json({ success: true, eventId: doc._id, receivedAt: doc.receivedAt });
};
