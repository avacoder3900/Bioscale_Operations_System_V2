/**
 * POST /api/cv/stations/register — Pi-side self-registration.
 *
 * Sits next to POST /api/cv/stations (the operator-facing register) but
 * authenticates via STATION_AGENT_KEY instead of a BIMS user session.
 * Called by services/bims-capture-agent/setup-station.sh on first boot
 * and (eventually) by the agent on subsequent restarts to bump
 * lastSeenAt + agentVersion.
 *
 * First-time (no station with this hostname) → 201 { _id, jwtSecret }.
 * Re-registration (existing hostname, no regenerateSecret) →
 *   200 { _id } — Pi keeps the secret it already has on disk.
 * Re-registration with regenerateSecret: true →
 *   201 { _id, jwtSecret } — admin-initiated rotation, replaces the
 *   on-disk secret and invalidates any browser JWTs minted with the old
 *   one.
 *
 * Per docs/prds/PI-STATION-ADMIN-AND-LIFECYCLE.md story B1.
 */
import { json, error } from '@sveltejs/kit';
import { randomBytes } from 'node:crypto';
import { connectDB } from '$lib/server/db/connection.js';
import {
	CaptureStation,
	normalizeStationCameras
} from '$lib/server/db/models/capture-station.js';
import { AuditLog } from '$lib/server/db/models/audit-log.js';
import { generateId } from '$lib/server/db/utils.js';
import { requireStationAgentKey } from '$lib/server/auth/station-agent-key';
import type { RequestHandler } from './$types';
import type { RegisterAgentRequest, RegisterAgentResponse } from '$lib/types/capture-station';

const AGENT_CHANGED_BY = '<station-agent-key>';

export const POST: RequestHandler = async ({ request }) => {
	requireStationAgentKey(request);

	let body: Partial<RegisterAgentRequest>;
	try {
		body = (await request.json()) as Partial<RegisterAgentRequest>;
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	const name = body.name?.trim();
	const hostname = body.hostname?.trim();
	if (!name) return json({ error: 'name is required' }, { status: 400 });
	if (!hostname) return json({ error: 'hostname is required' }, { status: 400 });

	const cameras = normalizeStationCameras(body.cameras);
	const activeCameraId =
		typeof body.activeCameraId === 'string' && body.activeCameraId.trim()
			? body.activeCameraId.trim()
			: undefined;

	// Derive the legacy capability booleans from cameras[] whenever the agent
	// reports one, so readers that predate CV-CAMERA-02 — the /capture sequence
	// panel gate, the stations table — keep working with no change.
	const cameraDerived = cameras
		? { camera: true, sequence: cameras.some((c) => c.sequence === true) }
		: null;

	// Only overwrite stored capabilities when the request actually carried them
	// (or we derived them). This previously $set an all-false default
	// unconditionally, which meant one reboot of an agent that omits
	// capabilities silently stripped the station of every capability it had.
	const capabilities =
		body.capabilities || cameraDerived
			? { ...(body.capabilities ?? {}), ...(cameraDerived ?? {}) }
			: null;

	const CAPABILITY_DEFAULTS = {
		camera: false,
		scanner: false,
		led: false,
		robotArm: false
	};
	const regenerate = body.regenerateSecret === true;

	await connectDB();

	const now = new Date();
	const existing = (await CaptureStation.findOne({ hostname }).lean()) as
		| { _id: string; ipAddress?: string }
		| null;

	if (existing) {
		// Re-register. Always bump heartbeat metadata. Rotate jwtSecret only
		// if the caller explicitly asked for it.
		const update: Record<string, unknown> = {
			lastSeenAt: now,
			agentVersion: body.agentVersion,
			ipAddress: body.ipAddress ?? existing.ipAddress,
			status: 'online',
			...(capabilities ? { capabilities } : {}),
			...(cameras ? { cameras } : {}),
			...(activeCameraId ? { activeCameraId } : {})
		};

		let mintedSecret: string | undefined;
		if (regenerate) {
			mintedSecret = randomBytes(32).toString('base64');
			update.jwtSecret = mintedSecret;
		}

		await CaptureStation.updateOne({ _id: existing._id }, { $set: update });

		await AuditLog.create({
			_id: generateId(),
			tableName: 'capture_stations',
			recordId: existing._id,
			action: 'UPDATE',
			newData: {
				hostname,
				agentVersion: body.agentVersion,
				capabilities: capabilities ?? undefined,
				cameras: cameras ?? undefined,
				activeCameraId,
				ipAddress: body.ipAddress,
				source: 'agent-self-register',
				rotated: regenerate
			},
			changedAt: now,
			changedBy: AGENT_CHANGED_BY,
			reason: regenerate ? 'agent-self-register-rotate' : 'agent-self-register'
		});

		const payload: RegisterAgentResponse = { _id: existing._id };
		if (mintedSecret) payload.jwtSecret = mintedSecret;
		return json(payload, { status: regenerate ? 201 : 200 });
	}

	// First-time registration. Mint a fresh jwtSecret; use the supplied
	// stationId as _id if the Pi hands one over (so the Pi's local STATION_ID
	// and BIMS' _id agree), otherwise generate one.
	const jwtSecret = randomBytes(32).toString('base64');
	const _id = body.stationId?.trim() || generateId();

	await CaptureStation.create({
		_id,
		name,
		hostname,
		ipAddress: body.ipAddress,
		agentVersion: body.agentVersion,
		capabilities: capabilities ?? CAPABILITY_DEFAULTS,
		...(cameras ? { cameras } : {}),
		...(activeCameraId ? { activeCameraId } : {}),
		status: 'online',
		mode: 'free',
		lastSeenAt: now,
		jwtSecret,
		createdAt: now
		// createdBy intentionally omitted — there's no user session here.
	});

	await AuditLog.create({
		_id: generateId(),
		tableName: 'capture_stations',
		recordId: _id,
		action: 'INSERT',
		newData: {
			name,
			hostname,
			capabilities,
			agentVersion: body.agentVersion,
			ipAddress: body.ipAddress,
			source: 'agent-self-register'
		},
		changedAt: now,
		changedBy: AGENT_CHANGED_BY,
		reason: 'agent-self-register'
	});

	const payload: RegisterAgentResponse = { _id, jwtSecret };
	return json(payload, { status: 201 });
};
