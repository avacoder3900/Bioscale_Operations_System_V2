/**
 * GET  /api/cv/stations — list registered capture stations.
 * POST /api/cv/stations — register a station (called by the Pi on first boot).
 *
 * See PRD §6.2.
 */
import { json, error } from '@sveltejs/kit';
import { randomBytes } from 'node:crypto';
import { connectDB } from '$lib/server/db/connection.js';
import { CaptureStation } from '$lib/server/db/models/capture-station.js';
import { AuditLog } from '$lib/server/db/models/audit-log.js';
import { generateId } from '$lib/server/db/utils.js';
import { hasPermission } from '$lib/server/permissions';
import type { RequestHandler } from './$types';
import type { RegisterStationRequest, RegisterStationResponse } from '$lib/types/capture-station';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const stations = await CaptureStation.find()
		.select('-jwtSecret')
		.sort({ name: 1 })
		.lean();

	return json({ data: JSON.parse(JSON.stringify(stations)) });
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	if (!hasPermission(locals.user, 'cv:write') && !hasPermission(locals.user, 'manufacturing:write')) {
		throw error(403, 'Forbidden');
	}

	await connectDB();

	const body = (await request.json()) as Partial<RegisterStationRequest>;
	const name = body.name?.trim();
	const hostname = body.hostname?.trim();
	if (!name) return json({ error: 'name is required' }, { status: 400 });
	if (!hostname) return json({ error: 'hostname is required' }, { status: 400 });

	const capabilities = body.capabilities ?? { camera: false, scanner: false, led: false, robotArm: false };

	const now = new Date();
	const existing = await CaptureStation.findOne({ hostname }).lean() as any;

	if (existing) {
		// Re-register: bump heartbeat metadata, do NOT mint a new token.
		await CaptureStation.updateOne(
			{ _id: existing._id },
			{
				$set: {
					lastSeenAt: now,
					agentVersion: body.agentVersion,
					capabilities,
					ipAddress: body.ipAddress ?? existing.ipAddress,
					status: 'online'
				}
			}
		);

		await AuditLog.create({
			_id: generateId(),
			tableName: 'capture_stations',
			recordId: existing._id,
			action: 'UPDATE',
			newData: { hostname, agentVersion: body.agentVersion, capabilities, ipAddress: body.ipAddress, source: 'register' },
			changedAt: now,
			changedBy: locals.user.username,
			reason: 're-register'
		});

		// Existing station — no jwtSecret returned. Pi keeps the one it has on disk.
		return json({ _id: existing._id } satisfies Pick<RegisterStationResponse, '_id'>);
	}

	// First-time registration — mint a fresh HS256 signing secret. Plaintext at
	// rest: the Pi holds the same secret and uses it to verify the short-lived
	// JWTs that the browser mints on demand via /api/cv/stations/[id]/token.
	// The secret is .select('-jwtSecret')-excluded from list responses and
	// never returned again after this registration call.
	const jwtSecret = randomBytes(32).toString('base64');

	const _id = generateId();
	await CaptureStation.create({
		_id,
		name,
		hostname,
		ipAddress: body.ipAddress,
		agentVersion: body.agentVersion,
		capabilities,
		status: 'online',
		mode: 'free',
		lastSeenAt: now,
		jwtSecret,
		createdBy: { _id: locals.user._id, username: locals.user.username },
		createdAt: now
	});

	await AuditLog.create({
		_id: generateId(),
		tableName: 'capture_stations',
		recordId: _id,
		action: 'INSERT',
		newData: { name, hostname, capabilities, agentVersion: body.agentVersion, ipAddress: body.ipAddress, source: 'register' },
		changedAt: now,
		changedBy: locals.user.username,
		reason: 'register'
	});

	const payload: RegisterStationResponse = { _id, jwtSecret };
	return json(payload, { status: 201 });
};
