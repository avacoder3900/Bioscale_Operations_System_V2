/**
 * /cv/stations/[id] — admin detail + actions for a single capture station.
 *
 * Form actions:
 *   rename            — PATCH name + location via /api/cv/stations/[id]
 *   forceRelease      — DELETE /api/cv/stations/[id]/lock?force=true
 *   rotateSecret      — POST /api/cv/stations/[id]/rotate-secret
 *   deregister        — DELETE /api/cv/stations/[id]
 *
 * Per docs/prds/PI-STATION-ADMIN-AND-LIFECYCLE.md stories D2 + D4.
 */
import { error, fail, redirect } from '@sveltejs/kit';
import { randomBytes } from 'node:crypto';
import { connectDB } from '$lib/server/db/connection.js';
import {
	CaptureStation,
	deriveStatus
} from '$lib/server/db/models/capture-station.js';
import { AuditLog } from '$lib/server/db/models/audit-log.js';
import { generateId } from '$lib/server/db/utils.js';
import { hasPermission } from '$lib/server/permissions';
import type { Actions, PageServerLoad } from './$types';

function requireCvOrManufacturing(user: any) {
	if (
		!hasPermission(user, 'cv:write') &&
		!hasPermission(user, 'manufacturing:write')
	) {
		throw error(403, 'Forbidden');
	}
}

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) redirect(302, '/login');
	requireCvOrManufacturing(locals.user);

	await connectDB();

	const raw = (await CaptureStation.findById(params.id)
		.select('-jwtSecret')
		.lean()) as Record<string, any> | null;
	if (!raw) throw error(404, 'Station not found');

	const audit = (await AuditLog.find({
		tableName: 'capture_stations',
		recordId: params.id
	})
		.sort({ changedAt: -1 })
		.limit(50)
		.lean()) as Array<Record<string, any>>;

	return {
		station: {
			id: raw._id,
			name: raw.name ?? '',
			hostname: raw.hostname ?? '',
			ipAddress: raw.ipAddress ?? null,
			location: raw.location ?? null,
			agentVersion: raw.agentVersion ?? null,
			status: deriveStatus(raw),
			storedStatus: raw.status ?? null,
			lastSeenAt: raw.lastSeenAt ? new Date(raw.lastSeenAt).toISOString() : null,
			agentReportedAt: raw.agentReportedAt
				? new Date(raw.agentReportedAt).toISOString()
				: null,
			capabilities: raw.capabilities ?? {
				camera: false,
				scanner: false,
				led: false,
				robotArm: false
			},
			mode: raw.mode ?? 'free',
			assignedPhase: raw.assignedPhase ?? null,
			currentOperator: raw.currentOperator
				? {
						_id: raw.currentOperator._id ?? '',
						username: raw.currentOperator.username ?? '',
						since: raw.currentOperator.since
							? new Date(raw.currentOperator.since).toISOString()
							: null
					}
				: null,
			health: raw.health
				? {
						cameraOk: !!raw.health.cameraOk,
						scannerOk: !!raw.health.scannerOk,
						ledOk: !!raw.health.ledOk,
						uptimeS: raw.health.uptimeS ?? 0,
						agentVersion: raw.health.agentVersion ?? null
					}
				: null,
			createdAt: raw.createdAt ? new Date(raw.createdAt).toISOString() : null,
			updatedAt: raw.updatedAt ? new Date(raw.updatedAt).toISOString() : null
		},
		audit: audit.map((a) => ({
			id: a._id,
			action: a.action ?? '',
			reason: a.reason ?? null,
			changedBy: a.changedBy ?? '',
			changedAt: a.changedAt ? new Date(a.changedAt).toISOString() : null,
			changedFields: a.changedFields ?? null,
			newData: a.newData ?? null,
			oldData: a.oldData ?? null
		}))
	};
};

export const actions: Actions = {
	rename: async ({ params, request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requireCvOrManufacturing(locals.user);
		await connectDB();

		const form = await request.formData();
		const name = form.get('name')?.toString().trim();
		const location = form.get('location')?.toString().trim() ?? '';
		if (!name) return fail(400, { error: 'Name is required' });

		const previous = (await CaptureStation.findById(params.id)
			.select('name location')
			.lean()) as Record<string, any> | null;
		if (!previous) return fail(404, { error: 'Station not found' });

		await CaptureStation.updateOne(
			{ _id: params.id },
			{ $set: { name, location: location || undefined } }
		);

		await AuditLog.create({
			_id: generateId(),
			tableName: 'capture_stations',
			recordId: params.id,
			action: 'UPDATE',
			oldData: { name: previous.name, location: previous.location ?? null },
			newData: { name, location: location || null },
			changedFields: ['name', 'location'],
			changedAt: new Date(),
			changedBy: locals.user.username,
			reason: 'admin-rename'
		});

		return { ok: true, action: 'rename' };
	},

	forceRelease: async ({ params, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requireCvOrManufacturing(locals.user);
		await connectDB();

		const station = (await CaptureStation.findById(params.id)
			.select('currentOperator')
			.lean()) as Record<string, any> | null;
		if (!station) return fail(404, { error: 'Station not found' });

		const holder = station.currentOperator;
		if (!holder?._id) return { ok: true, action: 'forceRelease' };

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
			reason: 'admin-force-release'
		});

		return { ok: true, action: 'forceRelease' };
	},

	rotateSecret: async ({ params, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requireCvOrManufacturing(locals.user);
		await connectDB();

		const existing = (await CaptureStation.findById(params.id)
			.select('_id')
			.lean()) as { _id: string } | null;
		if (!existing) return fail(404, { error: 'Station not found' });

		const jwtSecret = randomBytes(32).toString('base64');

		await CaptureStation.updateOne({ _id: params.id }, { $set: { jwtSecret } });

		await AuditLog.create({
			_id: generateId(),
			tableName: 'capture_stations',
			recordId: params.id,
			action: 'UPDATE',
			newData: { rotated: true, source: 'admin-rotate-secret' },
			changedFields: ['jwtSecret'],
			changedAt: new Date(),
			changedBy: locals.user.username,
			reason: 'admin-rotate-secret'
		});

		return { ok: true, action: 'rotateSecret', jwtSecret };
	},

	deregister: async ({ params, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requireCvOrManufacturing(locals.user);
		await connectDB();

		const previous = (await CaptureStation.findById(params.id)
			.select('-jwtSecret')
			.lean()) as Record<string, any> | null;
		if (!previous) return fail(404, { error: 'Station not found' });

		await CaptureStation.deleteOne({ _id: params.id });

		await AuditLog.create({
			_id: generateId(),
			tableName: 'capture_stations',
			recordId: params.id,
			action: 'DELETE',
			oldData: previous,
			changedAt: new Date(),
			changedBy: locals.user.username,
			reason: 'admin-deregister'
		});

		redirect(303, '/cv/stations');
	}
};

export const config = { maxDuration: 60 };
