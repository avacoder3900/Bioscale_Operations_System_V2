/**
 * POST /api/cv/stations/[id]/rotate-secret — admin-initiated jwtSecret rotation.
 *
 * Session-authenticated counterpart to the regenerateSecret flag on
 * POST /api/cv/stations/register (story B1). Used by the admin detail page
 * (story D2) so an operator can rotate without needing the agent key.
 *
 * Side effect: any browser JWTs minted with the old secret stop validating
 * on the Pi as soon as the Pi reads the new secret (the JWT TTL is 5 min,
 * but the Pi typically reads STATION_JWT_SECRET only at process start —
 * an agent restart is required for the rotation to take effect on the Pi
 * side). Surface this in the admin UI when the action runs.
 *
 * Per docs/prds/PI-STATION-ADMIN-AND-LIFECYCLE.md story D3.
 */
import { json, error } from '@sveltejs/kit';
import { randomBytes } from 'node:crypto';
import { connectDB } from '$lib/server/db/connection.js';
import { CaptureStation } from '$lib/server/db/models/capture-station.js';
import { AuditLog } from '$lib/server/db/models/audit-log.js';
import { generateId } from '$lib/server/db/utils.js';
import { hasPermission } from '$lib/server/permissions';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	if (
		!hasPermission(locals.user, 'cv:write') &&
		!hasPermission(locals.user, 'manufacturing:write')
	) {
		throw error(403, 'Forbidden');
	}

	await connectDB();

	const stationId = params.id;
	if (!stationId) throw error(400, 'station id required');

	const existing = (await CaptureStation.findById(stationId)
		.select('_id')
		.lean()) as { _id: string } | null;
	if (!existing) return json({ error: 'Station not found' }, { status: 404 });

	const jwtSecret = randomBytes(32).toString('base64');
	const now = new Date();

	await CaptureStation.updateOne(
		{ _id: stationId },
		{ $set: { jwtSecret } }
	);

	await AuditLog.create({
		_id: generateId(),
		tableName: 'capture_stations',
		recordId: stationId,
		action: 'UPDATE',
		// Don't put the secret itself in the audit log — the secret should
		// flow through the response only.
		newData: { rotated: true, source: 'admin-rotate-secret' },
		changedFields: ['jwtSecret'],
		changedAt: now,
		changedBy: locals.user.username,
		reason: 'admin-rotate-secret'
	});

	return json({ jwtSecret });
};
