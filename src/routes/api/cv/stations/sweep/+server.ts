/**
 * POST /api/cv/stations/sweep — materialize derived status to Mongo.
 *
 * Called periodically (Vercel cron or an external pinger; see RUNBOOK
 * "Day 2" section once it lands). For every station, computes deriveStatus
 * and writes it back if it differs from the stored value. Counters in the
 * response (`scanned`, `mutated`) make it easy to verify the job is
 * actually doing work.
 *
 * Why bother materializing when read-time derivation already exists?
 *   - Admin filters (e.g. "show only offline stations") run faster against
 *     a stored field than a computed one.
 *   - Status transitions become first-class audit-log events, so we can
 *     trace "when did this station go offline?" without reconstructing
 *     it from heartbeat absence.
 *
 * Auth: STATION_AGENT_KEY (deferred to Open Question 13.1 — chose to
 * reuse the fleet key rather than mint a separate sweep key. Sweep is
 * read-mostly and idempotent, and a leaked key buys an attacker only the
 * ability to write the same value back to Mongo.)
 *
 * Per docs/prds/PI-STATION-ADMIN-AND-LIFECYCLE.md story C5.
 */
import { json } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import {
	CaptureStation,
	deriveStatus
} from '$lib/server/db/models/capture-station.js';
import { AuditLog } from '$lib/server/db/models/audit-log.js';
import { generateId } from '$lib/server/db/utils.js';
import { requireStationAgentKey } from '$lib/server/auth/station-agent-key';
import type { RequestHandler } from './$types';

const SWEEPER = '<status-sweep>';

export const POST: RequestHandler = async ({ request }) => {
	requireStationAgentKey(request);

	await connectDB();

	const stations = (await CaptureStation.find()
		.select('_id status lastSeenAt')
		.lean()) as Array<{ _id: string; status?: string; lastSeenAt?: Date }>;

	const now = new Date();
	let mutated = 0;

	for (const s of stations) {
		const derived = deriveStatus(s);
		if (derived === s.status) continue;

		await CaptureStation.updateOne(
			{ _id: s._id },
			{ $set: { status: derived } }
		);

		await AuditLog.create({
			_id: generateId(),
			tableName: 'capture_stations',
			recordId: s._id,
			action: 'UPDATE',
			oldData: { status: s.status ?? null },
			newData: { status: derived },
			changedFields: ['status'],
			changedAt: now,
			changedBy: SWEEPER,
			reason: 'health-sweep'
		});

		mutated += 1;
	}

	return json({ scanned: stations.length, mutated });
};
