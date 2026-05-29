/**
 * GET /api/cv/stations/[id]/token — mint a 5-min HS256 JWT signed with the
 * station's jwtSecret. The browser passes it in the wss://<station>/ws
 * query string; the Pi verifies the signature with the same secret it
 * received at registration.
 *
 * The signing secret never leaves BIMS after registration. JWT carries
 * operator identity claims so the Pi can attribute the connection in its
 * own logs.
 */
import { json, error } from '@sveltejs/kit';
import jwt from 'jsonwebtoken';
import { connectDB } from '$lib/server/db/connection.js';
import { CaptureStation } from '$lib/server/db/models/capture-station.js';
import { AuditLog } from '$lib/server/db/models/audit-log.js';
import { generateId } from '$lib/server/db/utils.js';
import { hasPermission } from '$lib/server/permissions';
import type { RequestHandler } from './$types';

const JWT_TTL_MINUTES = 5;

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const station = await CaptureStation.findById(params.id).select('jwtSecret').lean() as any;
	if (!station) return json({ error: 'Station not found' }, { status: 404 });
	if (!station.jwtSecret) {
		return json({ error: 'Station has no signing secret — re-register the Pi' }, { status: 409 });
	}

	// Story F2: admin: true is asserted in the claim only when the user has
	// cv:admin. The Pi gates remote-control commands (story F1 admin_restart)
	// on this claim; ordinary capture sessions ignore it.
	const isAdmin = hasPermission(locals.user, 'cv:admin');

	const token = jwt.sign(
		{
			stationId: station._id,
			operatorId: locals.user._id,
			operatorUsername: locals.user.username,
			...(isAdmin ? { admin: true } : {})
		},
		station.jwtSecret,
		{ algorithm: 'HS256', expiresIn: `${JWT_TTL_MINUTES}m` }
	);

	await AuditLog.create({
		_id: generateId(),
		tableName: 'capture_stations',
		recordId: params.id,
		action: 'READ',
		changedAt: new Date(),
		changedBy: locals.user.username,
		reason: 'jwt_mint',
		newData: { ttlMinutes: JWT_TTL_MINUTES, admin: isAdmin }
	});

	return json({ token });
};
