/**
 * In-run service session — open / read / close (WAX-SERVICE-1).
 *
 * GET  /api/opentrons-lab/robots/:id/runs/:rid/service
 *   UI poll. → { session: null } or the live session (status, location,
 *   pendingCommand, lastResult).
 *
 * POST /api/opentrons-lab/robots/:id/runs/:rid/service
 *   { action: 'open' }   ask the fill protocol to park at the next well
 *   { action: 'close' }  abort the request / force-close a stuck session
 *
 * This never touches the OT-2 run engine. The engine's own Pause must NOT be
 * used for this: a paused engine stops executing the protocol, so the service
 * loop could neither move the gantry nor poll — it would deadlock.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot } from '$lib/server/opentrons/proxy';
import { connectDB, Ot2ServiceSession, AuditLog, generateId } from '$lib/server/db';

const LIVE = { $in: ['requested', 'active'] };

function view(doc: any) {
	if (!doc) return null;
	return JSON.parse(JSON.stringify({
		_id: String(doc._id),
		opentronsRunId: doc.opentronsRunId,
		status: doc.status,
		location: doc.location ?? null,
		pendingCommand: doc.pendingCommand ?? null,
		lastResult: doc.lastResult ?? null,
		requestedBy: doc.requestedBy ?? null,
		createdAt: doc.createdAt ?? null,
		updatedAt: doc.updatedAt ?? null
	}));
}

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');

	await connectDB();
	const session = await Ot2ServiceSession
		.findOne({ opentronsRunId: params.rid, status: LIVE })
		.lean() as any;

	return json({ session: view(session) });
};

export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	const body = await request.json().catch(() => ({} as any));
	const action = body?.action;
	if (action !== 'open' && action !== 'close') {
		error(400, "action must be 'open' or 'close'");
	}

	await connectDB();
	const now = new Date();
	const existing = await Ot2ServiceSession
		.findOne({ opentronsRunId: params.rid, status: LIVE })
		.lean() as any;

	if (action === 'open') {
		// Idempotent: a second click returns the session already in flight rather
		// than racing a second one into the same run.
		if (existing) return json({ session: view(existing), alreadyOpen: true });

		const session = await Ot2ServiceSession.create({
			_id: generateId(),
			opentronsRunId: params.rid,
			robotId: String(robot._id ?? ''),
			processType: 'wax-filling',
			status: 'requested',
			requestedBy: locals.user.username,
			createdAt: now,
			updatedAt: now
		});

		await AuditLog.create({
			_id: generateId(),
			tableName: 'ot2_service_sessions',
			recordId: String(session._id),
			action: 'service_session_open',
			changedBy: locals.user.username,
			changedAt: now,
			newData: { opentronsRunId: params.rid, robotId: String(robot._id ?? '') }
		});

		return json({ session: view(session.toObject()) });
	}

	// close
	if (!existing) return json({ session: null });

	await Ot2ServiceSession.updateOne(
		{ _id: existing._id },
		{
			$set: {
				status: 'closed',
				closedReason: `closed by ${locals.user.username}`,
				pendingCommand: null,
				closedAt: now,
				updatedAt: now
			}
		}
	);

	await AuditLog.create({
		_id: generateId(),
		tableName: 'ot2_service_sessions',
		recordId: String(existing._id),
		action: 'service_session_close',
		changedBy: locals.user.username,
		changedAt: now,
		newData: { opentronsRunId: params.rid }
	});

	return json({ session: null, closed: true });
};
