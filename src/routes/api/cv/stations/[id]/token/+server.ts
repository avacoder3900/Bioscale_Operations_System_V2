/**
 * GET /api/cv/stations/[id]/token — reveal the station auth token to an
 * authenticated operator so the browser can pass it in the WSS query string
 * when connecting to the Pi.
 *
 * Token is plaintext-at-rest (see refactor at a35d48da). Any logged-in
 * operator can fetch it — the upstream operator-lock on the station
 * prevents two browsers from claiming the same station concurrently.
 */
import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CaptureStation } from '$lib/server/db/models/capture-station.js';
import { AuditLog } from '$lib/server/db/models/audit-log.js';
import { generateId } from '$lib/server/db/utils.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const station = await CaptureStation.findById(params.id).select('token').lean() as any;
	if (!station) return json({ error: 'Station not found' }, { status: 404 });

	await AuditLog.create({
		_id: generateId(),
		tableName: 'capture_stations',
		recordId: params.id,
		action: 'READ',
		changedAt: new Date(),
		changedBy: locals.user.username,
		reason: 'token_fetch'
	});

	return json({ token: station.token });
};
