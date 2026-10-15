/**
 * GET    /api/cv/stations/[id]/lock — who holds this station, and is it me?
 * POST   /api/cv/stations/[id]/lock — claim the station (newest request wins).
 * DELETE /api/cv/stations/[id]/lock — release the station.
 *
 * Callers pass ?device=<per-tab id> (src/lib/station-device.ts).
 *
 * NEWEST REQUEST WINS: a claim always succeeds. If another user — or the same
 * user on another device — held the station, the lock moves to the caller
 * (audited as 'lock-takeover') and the response names who was displaced
 * (tookOverFrom). The displaced tab finds out through GET, which every station
 * page polls (watchStationLock): GET is read-only, so a displaced tab never
 * grabs the station back. Keeping one viewer per station matters because each
 * viewer gets its own MJPEG stream — two viewers doubled the Pi's encode load
 * and it dropped scanner keystrokes. One operator may still hold several
 * stations at once.
 *
 * DELETE only releases when the caller still holds the lock, so a displaced
 * tab closing can't release its successor's lock. ?force=true (station admin /
 * /capture "reset") clears it regardless and is audited.
 */
import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CaptureStation } from '$lib/server/db/models/capture-station.js';
import { AuditLog } from '$lib/server/db/models/audit-log.js';
import { generateId } from '$lib/server/db/utils.js';
import type { RequestHandler } from './$types';
import type { LockStationResponse } from '$lib/types/capture-station';

function deviceParam(url: URL): string | undefined {
	const raw = url.searchParams.get('device')?.trim();
	return raw ? raw.slice(0, 64) : undefined;
}

// The caller holds the lock if it's the same user on the same device. A lock
// without a deviceId (claimed by an older page) counts as the user's.
function heldByCaller(holder: any, userId: string, deviceId: string | undefined): boolean {
	if (!holder?._id || holder._id !== userId) return false;
	return !holder.deviceId || !deviceId || holder.deviceId === deviceId;
}

export const GET: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const station = await CaptureStation.findById(params.id).select('currentOperator').lean() as any;
	if (!station) return json({ error: 'Station not found' }, { status: 404 });

	const holder = station.currentOperator;
	return json({
		mine: heldByCaller(holder, locals.user._id, deviceParam(url)),
		holder: holder?._id ? { username: holder.username ?? null, since: holder.since ?? null } : null
	});
};

export const POST: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const station = await CaptureStation.findById(params.id).select('currentOperator').lean() as any;
	if (!station) return json({ error: 'Station not found' }, { status: 404 });

	const holder = station.currentOperator;
	const userId = locals.user._id;
	const deviceId = deviceParam(url);

	// Newest request wins: anyone else holding it is displaced.
	const refresh = heldByCaller(holder, userId, deviceId);
	const displaced = holder?._id && !refresh ? holder : null;

	// Reuse `since` only when the same holder is refreshing.
	const since = refresh && holder.since ? holder.since : new Date();
	await CaptureStation.updateOne(
		{ _id: params.id },
		{
			$set: {
				currentOperator: {
					_id: userId,
					username: locals.user.username,
					since,
					...(deviceId ? { deviceId } : {})
				}
			}
		}
	);

	// Audit claims and takeovers only — refreshes would flood the log.
	if (!refresh) {
		await AuditLog.create({
			_id: generateId(),
			tableName: 'capture_stations',
			recordId: params.id,
			action: 'UPDATE',
			oldData: displaced ? { currentOperator: displaced } : undefined,
			newData: { currentOperator: { _id: userId, username: locals.user.username, since, deviceId } },
			changedFields: ['currentOperator'],
			changedAt: new Date(),
			changedBy: locals.user.username,
			reason: displaced ? 'lock-takeover' : 'lock-claim'
		});
	}

	const body: LockStationResponse = displaced
		? { ok: true, tookOverFrom: { username: displaced.username, since: displaced.since } }
		: { ok: true };
	return json(body);
};

export const DELETE: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const station = await CaptureStation.findById(params.id).select('currentOperator').lean() as any;
	if (!station) return json({ error: 'Station not found' }, { status: 404 });

	const holder = station.currentOperator;
	if (!holder?._id) {
		// Nothing to release. Idempotent success.
		return json({ ok: true } satisfies LockStationResponse);
	}

	// Force-release path: ?force=true lets ANY authenticated operator clear the
	// lock, not just the holder. A browser tab that dies without firing
	// beforeunload leaves currentOperator set with no live session, pinning the
	// station as "in use" forever. Letting any operator reset it from the
	// /capture page (and the /cv/stations detail page) is the recovery path;
	// every force-release is audited below for accountability.
	const isForce = url.searchParams.get('force') === 'true';

	if (holder._id !== locals.user._id && !isForce) {
		return json({ error: 'Only the current holder can release this lock' }, { status: 403 });
	}

	// A device that was taken over must not release its successor's lock
	// (e.g. the old tablet's beforeunload firing after a takeover).
	const deviceId = deviceParam(url);
	if (!isForce && holder.deviceId && deviceId && holder.deviceId !== deviceId) {
		return json({ ok: true, released: false } satisfies LockStationResponse);
	}

	await CaptureStation.updateOne(
		{ _id: params.id },
		{ $unset: { currentOperator: '' } }
	);

	await AuditLog.create({
		_id: generateId(),
		tableName: 'capture_stations',
		recordId: params.id,
		action: 'UPDATE',
		oldData: { currentOperator: holder },
		changedFields: ['currentOperator'],
		changedAt: new Date(),
		changedBy: locals.user.username,
		reason: holder._id !== locals.user._id ? 'force-release' : 'lock-release'
	});

	return json({ ok: true } satisfies LockStationResponse);
};
