/**
 * POST /api/cv/stations/[id]/heartbeat — Pi liveness + health report.
 *
 * Called every HEARTBEAT_INTERVAL_S (default 30 s) by the agent timer
 * added in story C3. Authenticated via STATION_AGENT_KEY (story A1).
 *
 * Updates lastSeenAt, agentReportedAt, agentVersion, and the health
 * subdocument. Derives status:
 *   - 'online'   if cameraOk && scannerOk
 *   - 'degraded' if reachable but at least one peripheral failed
 * The read-time deriveStatus helper (story C4) further coerces this
 * to 'offline' if lastSeenAt drifts beyond the stale threshold.
 *
 * Idempotent — repeated calls converge on the same state. No audit log
 * entry per heartbeat to keep the log readable; status transitions are
 * captured by the sweep job (story C5) instead.
 *
 * Per docs/prds/PI-STATION-ADMIN-AND-LIFECYCLE.md story C2.
 */
import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CaptureStation } from '$lib/server/db/models/capture-station.js';
import { requireStationAgentKey } from '$lib/server/auth/station-agent-key';
import type { RequestHandler } from './$types';
import type { HeartbeatRequest } from '$lib/types/capture-station';

export const POST: RequestHandler = async ({ params, request }) => {
	requireStationAgentKey(request);

	const stationId = params.id;
	if (!stationId) throw error(400, 'station id required');

	let body: Partial<HeartbeatRequest>;
	try {
		body = (await request.json()) as Partial<HeartbeatRequest>;
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	const cameraOk = body.cameraOk === true;
	const scannerOk = body.scannerOk === true;
	const ledOk = body.ledOk === true;
	const uptimeS = typeof body.uptimeS === 'number' ? body.uptimeS : 0;
	const agentVersion =
		typeof body.agentVersion === 'string' ? body.agentVersion : undefined;

	const status: 'online' | 'degraded' =
		cameraOk && scannerOk ? 'online' : 'degraded';

	await connectDB();

	const now = new Date();
	const result = await CaptureStation.updateOne(
		{ _id: stationId },
		{
			$set: {
				lastSeenAt: now,
				agentReportedAt: now,
				status,
				agentVersion,
				health: {
					cameraOk,
					scannerOk,
					ledOk,
					uptimeS,
					agentVersion
				}
			}
		}
	);

	if (result.matchedCount === 0) {
		throw error(404, 'station not found');
	}

	return new Response(null, { status: 204 });
};
