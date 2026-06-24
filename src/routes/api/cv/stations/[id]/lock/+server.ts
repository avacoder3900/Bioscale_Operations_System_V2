/**
 * POST   /api/cv/stations/[id]/lock — claim the operator lock for this station.
 * DELETE /api/cv/stations/[id]/lock — release the operator lock.
 *
 * Multi-tenant rule (PRD §6.3): one operator per station at a time. One
 * operator may hold sessions on multiple stations simultaneously, so the
 * same-user re-claim is a no-op success. Second-operator claim returns
 * 409 with the current holder identified so the /capture page can show
 * "in use by {username} since {since}".
 */
import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CaptureStation } from '$lib/server/db/models/capture-station.js';
import { AuditLog } from '$lib/server/db/models/audit-log.js';
import { generateId } from '$lib/server/db/utils.js';
import { hasPermission } from '$lib/server/permissions';
import type { RequestHandler } from './$types';
import type { LockStationResponse } from '$lib/types/capture-station';

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const station = await CaptureStation.findById(params.id).select('currentOperator').lean() as any;
	if (!station) return json({ error: 'Station not found' }, { status: 404 });

	const holder = station.currentOperator;
	const userId = locals.user._id;

	if (holder?._id && holder._id !== userId) {
		const body: LockStationResponse = {
			ok: false,
			heldBy: { username: holder.username, since: holder.since }
		};
		return json(body, { status: 409 });
	}

	// Free or same user — refresh / claim. Reuse `since` if the same operator
	// is already holding the lock; otherwise stamp a new one.
	const since = holder?._id === userId && holder.since ? holder.since : new Date();
	await CaptureStation.updateOne(
		{ _id: params.id },
		{
			$set: {
				currentOperator: {
					_id: userId,
					username: locals.user.username,
					since
				}
			}
		}
	);

	// Audit only the initial claim — same-user refreshes would flood the log.
	if (holder?._id !== userId) {
		await AuditLog.create({
			_id: generateId(),
			tableName: 'capture_stations',
			recordId: params.id,
			action: 'UPDATE',
			newData: { currentOperator: { _id: userId, username: locals.user.username, since } },
			changedFields: ['currentOperator'],
			changedAt: new Date(),
			changedBy: locals.user.username,
			reason: 'lock-claim'
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

	// Admin force-release path (story D2): the cv:write / manufacturing:write
	// admin override of the same-holder check. ?force=true unblocks the
	// detail page's "Force release" button so operators stuck holding a
	// dead browser tab can be unstuck without restarting the agent. Operators
	// on /capture take over a stuck station via /takeover (admin-password gated),
	// not this endpoint.
	const isForce = url.searchParams.get('force') === 'true';
	const isAdmin =
		hasPermission(locals.user, 'cv:write') ||
		hasPermission(locals.user, 'manufacturing:write');

	if (holder._id !== locals.user._id && !(isForce && isAdmin)) {
		return json({ error: 'Only the current holder can release this lock' }, { status: 403 });
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
		reason: isForce && holder._id !== locals.user._id ? 'admin-force-release' : 'lock-release'
	});

	return json({ ok: true } satisfies LockStationResponse);
};
