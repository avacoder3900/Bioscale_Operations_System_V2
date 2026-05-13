/**
 * Scanner position sets — list / create.
 * GET  /api/scanner-position-sets?robotId=...
 * POST /api/scanner-position-sets
 *   { robotId, title, positionCount, isDefault?, pipetteMount?, pipetteName?, notes? }
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, OpentronsScannerPositionSet, AuditLog, generateId } from '$lib/server/db';

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');

	const robotId = url.searchParams.get('robotId')?.trim();
	await connectDB();

	const query = robotId ? { robotId } : {};
	const sets = await OpentronsScannerPositionSet.find(query)
		.sort({ isDefault: -1, title: 1 })
		.lean();
	return json({ sets: JSON.parse(JSON.stringify(sets)) });
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const body = await request.json().catch(() => ({} as any));
	const robotId = body?.robotId?.trim();
	const title = body?.title?.trim();
	const positionCount = Number(body?.positionCount);
	const isDefault = !!body?.isDefault;
	const pipetteMount = body?.pipetteMount === 'right' ? 'right' : 'left';
	const pipetteName = body?.pipetteName?.toString().trim() || undefined;
	const notes = body?.notes?.toString() || undefined;

	if (!robotId) error(400, 'robotId required');
	if (!title) error(400, 'title required');
	if (!Number.isInteger(positionCount) || positionCount < 1 || positionCount > 96)
		error(400, 'positionCount must be an integer between 1 and 96');

	await connectDB();

	// If this set is being marked default, clear other defaults for the same robot.
	if (isDefault) {
		await OpentronsScannerPositionSet.updateMany(
			{ robotId, isDefault: true },
			{ $set: { isDefault: false } }
		);
	}

	const _id = generateId();
	const now = new Date();
	try {
		const set = await OpentronsScannerPositionSet.create({
			_id,
			robotId,
			title,
			positionCount,
			positions: [],
			isDefault,
			pipetteMount,
			pipetteName,
			notes,
			calibratedBy: { _id: locals.user._id, username: locals.user.username },
			calibratedAt: now,
			updatedBy: { _id: locals.user._id, username: locals.user.username }
		});

		await AuditLog.create({
			_id: generateId(),
			tableName: 'opentrons_scanner_position_sets',
			recordId: _id,
			action: 'create',
			newData: { robotId, title, positionCount, isDefault, pipetteMount, pipetteName },
			changedAt: now,
			changedBy: locals.user.username
		});

		return json(JSON.parse(JSON.stringify(set)), { status: 201 });
	} catch (e: any) {
		if (e?.code === 11000) error(409, `A position set named "${title}" already exists for this robot`);
		throw e;
	}
};
