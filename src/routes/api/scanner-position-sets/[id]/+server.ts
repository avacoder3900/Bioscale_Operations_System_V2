/**
 * Scanner position set — fetch / update / delete.
 * GET    /api/scanner-position-sets/:id
 * PATCH  /api/scanner-position-sets/:id  { title?, isDefault?, notes?, pipetteMount?, pipetteName? }
 * DELETE /api/scanner-position-sets/:id
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, OpentronsScannerPositionSet, AuditLog, generateId } from '$lib/server/db';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');

	await connectDB();
	const set = await OpentronsScannerPositionSet.findById(params.id).lean();
	if (!set) error(404, 'Position set not found');
	return json(JSON.parse(JSON.stringify(set)));
};

export const PATCH: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const body = await request.json().catch(() => ({} as any));
	await connectDB();
	const existing = await OpentronsScannerPositionSet.findById(params.id);
	if (!existing) error(404, 'Position set not found');

	const updates: Record<string, unknown> = {};
	if (typeof body.title === 'string' && body.title.trim()) updates.title = body.title.trim();
	if (typeof body.notes === 'string') updates.notes = body.notes;
	if (body.pipetteMount === 'left' || body.pipetteMount === 'right') updates.pipetteMount = body.pipetteMount;
	if (typeof body.pipetteName === 'string') updates.pipetteName = body.pipetteName.trim() || undefined;
	if (typeof body.isDefault === 'boolean') updates.isDefault = body.isDefault;

	if (Object.keys(updates).length === 0) error(400, 'No updatable fields supplied');

	if (updates.isDefault === true) {
		await OpentronsScannerPositionSet.updateMany(
			{ robotId: existing.robotId, isDefault: true, _id: { $ne: existing._id } },
			{ $set: { isDefault: false } }
		);
	}

	updates.updatedBy = { _id: locals.user._id, username: locals.user.username };

	const now = new Date();
	try {
		const updated = await OpentronsScannerPositionSet.findByIdAndUpdate(
			params.id,
			{ $set: updates },
			{ new: true }
		).lean();

		await AuditLog.create({
			_id: generateId(),
			tableName: 'opentrons_scanner_position_sets',
			recordId: params.id,
			action: 'update',
			oldData: { title: existing.title, isDefault: existing.isDefault, notes: existing.notes, pipetteMount: existing.pipetteMount, pipetteName: existing.pipetteName },
			newData: updates,
			changedAt: now,
			changedBy: locals.user.username
		});

		return json(JSON.parse(JSON.stringify(updated)));
	} catch (e: any) {
		if (e?.code === 11000) error(409, 'Title already in use for this robot');
		throw e;
	}
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	await connectDB();
	const existing = await OpentronsScannerPositionSet.findById(params.id).lean();
	if (!existing) error(404, 'Position set not found');

	await OpentronsScannerPositionSet.deleteOne({ _id: params.id });

	await AuditLog.create({
		_id: generateId(),
		tableName: 'opentrons_scanner_position_sets',
		recordId: params.id,
		action: 'delete',
		oldData: { robotId: existing.robotId, title: existing.title, positionCount: existing.positionCount },
		changedAt: new Date(),
		changedBy: locals.user.username
	});

	return json({ ok: true });
};
