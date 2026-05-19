/**
 * GET    /api/cv/stations/[id] — one station detail.
 * PATCH  /api/cv/stations/[id] — update name / location / mode / assignedPhase.
 * DELETE /api/cv/stations/[id] — unregister.
 *
 * See PRD §6.2.
 */
import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CaptureStation } from '$lib/server/db/models/capture-station.js';
import { AuditLog } from '$lib/server/db/models/audit-log.js';
import { generateId } from '$lib/server/db/utils.js';
import { hasPermission } from '$lib/server/permissions';
import type { RequestHandler } from './$types';

const EDITABLE_FIELDS = ['name', 'location', 'mode', 'assignedPhase'] as const;

function requireCvOrManufacturing(user: any) {
	if (!hasPermission(user, 'cv:write') && !hasPermission(user, 'manufacturing:write')) {
		throw error(403, 'Forbidden');
	}
}

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const station = await CaptureStation.findById(params.id).select('-token').lean();
	if (!station) return json({ error: 'Station not found' }, { status: 404 });

	return json({ data: JSON.parse(JSON.stringify(station)) });
};

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	requireCvOrManufacturing(locals.user);
	await connectDB();

	const body = await request.json();
	const update: Record<string, unknown> = {};
	for (const key of EDITABLE_FIELDS) {
		if (body[key] !== undefined) update[key] = body[key];
	}

	if (update.mode !== undefined && update.mode !== 'free' && update.mode !== 'assigned') {
		return json({ error: 'mode must be "free" or "assigned"' }, { status: 400 });
	}

	// Resolve the effective mode + assignedPhase after this PATCH to check
	// the assigned-requires-phase invariant, even when only one of the two
	// fields is being changed.
	if (update.mode === 'assigned' || (update.mode === undefined && update.assignedPhase !== undefined)) {
		const current = await CaptureStation.findById(params.id).select('mode assignedPhase').lean() as any;
		if (!current) return json({ error: 'Station not found' }, { status: 404 });

		const effectiveMode = (update.mode as string | undefined) ?? current.mode;
		const effectivePhase = (update.assignedPhase as string | undefined) ?? current.assignedPhase;

		if (effectiveMode === 'assigned' && (!effectivePhase || !effectivePhase.trim())) {
			return json({ error: 'assignedPhase is required when mode is "assigned"' }, { status: 400 });
		}
	}

	const previous = await CaptureStation.findById(params.id).select('-token').lean() as any;
	if (!previous) return json({ error: 'Station not found' }, { status: 404 });

	const station = await CaptureStation.findByIdAndUpdate(params.id, update, { new: true })
		.select('-token')
		.lean();
	if (!station) return json({ error: 'Station not found' }, { status: 404 });

	await AuditLog.create({
		_id: generateId(),
		tableName: 'capture_stations',
		recordId: params.id,
		action: 'UPDATE',
		oldData: Object.fromEntries(Object.keys(update).map((k) => [k, previous[k]])),
		newData: update,
		changedFields: Object.keys(update),
		changedAt: new Date(),
		changedBy: locals.user.username
	});

	return json({ data: JSON.parse(JSON.stringify(station)) });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	requireCvOrManufacturing(locals.user);
	await connectDB();

	const station = await CaptureStation.findById(params.id).select('-token').lean() as any;
	if (!station) return json({ error: 'Station not found' }, { status: 404 });

	await CaptureStation.deleteOne({ _id: params.id });

	await AuditLog.create({
		_id: generateId(),
		tableName: 'capture_stations',
		recordId: params.id,
		action: 'DELETE',
		oldData: station,
		changedAt: new Date(),
		changedBy: locals.user.username,
		reason: 'unregister'
	});

	return json({ success: true });
};
