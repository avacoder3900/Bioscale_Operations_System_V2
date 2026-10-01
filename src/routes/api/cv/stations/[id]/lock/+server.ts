/**
 * POST   /api/cv/stations/[id]/lock — claim the operator lock for this station.
 * DELETE /api/cv/stations/[id]/lock — release the operator lock.
 *
 * Multi-tenant rule (PRD §6.3): one operator per station at a time. One
 * operator may hold sessions on multiple stations simultaneously, so the
 * same-user re-claim is a no-op success. Second-operator claim returns
 * 409 with the current holder identified so the /capture page can show
 * "in use by {username} since {since}".
 *
 * One DEVICE per station: callers pass ?device=<per-tab id>. Two tablets
 * signed in as the same user each opened their own MJPEG stream, doubling the
 * Pi's encode load (it then dropped scanner keystrokes). So the same user on a
 * different device also gets a 409 (sameUser: true) unless it passes
 * ?takeover=1, which moves the lock to the new device. The old device notices
 * on its next lock refresh. Callers without ?device= (pages not yet updated)
 * keep the old per-user behaviour. DELETE with a device that no longer holds
 * the lock is a no-op, so a closing tab can't release its successor's lock.
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

export const POST: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const station = await CaptureStation.findById(params.id).select('currentOperator').lean() as any;
	if (!station) return json({ error: 'Station not found' }, { status: 404 });

	const holder = station.currentOperator;
	const userId = locals.user._id;
	const deviceId = deviceParam(url);
	const takeover = url.searchParams.get('takeover') === '1';

	if (holder?._id && holder._id !== userId) {
		const body: LockStationResponse = {
			ok: false,
			heldBy: { username: holder.username, since: holder.since }
		};
		return json(body, { status: 409 });
	}

	// Same user, different device (both known) → busy unless taking over.
	const otherDevice =
		holder?._id === userId && !!holder.deviceId && !!deviceId && holder.deviceId !== deviceId;
	if (otherDevice && !takeover) {
		const body: LockStationResponse = {
			ok: false,
			heldBy: { username: `${holder.username} (another device)`, since: holder.since },
			sameUser: true
		};
		return json(body, { status: 409 });
	}

	// Free, same device, or takeover — claim / refresh. Reuse `since` only when
	// the same device is refreshing; a claim or takeover stamps a new one.
	const sameHolder = holder?._id === userId && !otherDevice;
	const since = sameHolder && holder.since ? holder.since : new Date();
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

	// Audit claims and takeovers only — same-device refreshes would flood the log.
	if (!sameHolder) {
		await AuditLog.create({
			_id: generateId(),
			tableName: 'capture_stations',
			recordId: params.id,
			action: 'UPDATE',
			oldData: otherDevice ? { currentOperator: holder } : undefined,
			newData: { currentOperator: { _id: userId, username: locals.user.username, since, deviceId } },
			changedFields: ['currentOperator'],
			changedAt: new Date(),
			changedBy: locals.user.username,
			reason: otherDevice ? 'lock-takeover' : 'lock-claim'
		});
	}

	const body: LockStationResponse = { ok: true };
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
