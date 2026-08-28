import { redirect, fail } from '@sveltejs/kit';
import {
	connectDB,
	OpentronsRobot,
	OpentronsScannerPositionSet,
	AuditLog,
	generateId
} from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

export const config = { maxDuration: 60 };

/**
 * Barcode scan positions — the taught deck XYZ points the gantry-mounted
 * scanner visits during wax/reagent cartridge sweeps. Moved out of the wax
 * page's "Teach Positions" tab and under Deck Calibration (2026-08-28):
 * teaching scanner positions is deck/robot calibration, not a wax setting.
 */
export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();
	const [robots, positionSets] = await Promise.all([
		OpentronsRobot.find({ isActive: { $ne: false } })
			.select('_id name ip port robotSide robotModel')
			.sort({ name: 1 })
			.lean(),
		OpentronsScannerPositionSet.find({})
			.sort({ robotId: 1, isDefault: -1, title: 1 })
			.lean()
	]);
	return {
		robots: JSON.parse(JSON.stringify(robots)),
		positionSets: JSON.parse(JSON.stringify(positionSets))
	};
};

export const actions: Actions = {
	createPositionSet: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Not signed in' });
		requirePermission(locals.user, 'manufacturing:write');

		const data = await request.formData();
		const robotId = data.get('robotId')?.toString().trim();
		const title = data.get('title')?.toString().trim();
		const positionCountRaw = data.get('positionCount')?.toString().trim();
		const pipetteMountRaw = data.get('pipetteMount')?.toString().trim();
		const pipetteName = data.get('pipetteName')?.toString().trim() || undefined;

		if (!robotId) return fail(400, { error: 'robotId required' });
		if (!title) return fail(400, { error: 'title required' });
		const positionCount = Number(positionCountRaw);
		if (!Number.isInteger(positionCount) || positionCount < 1 || positionCount > 96) {
			return fail(400, { error: 'positionCount must be 1–96' });
		}
		const pipetteMount = pipetteMountRaw === 'right' ? 'right' : 'left';

		await connectDB();
		const robot = await OpentronsRobot.findById(robotId).lean();
		if (!robot) return fail(404, { error: 'Robot not found' });

		const dupe = await OpentronsScannerPositionSet.findOne({ robotId, title }).lean();
		if (dupe) return fail(409, { error: `A set named "${title}" already exists for this robot` });

		const _id = generateId();
		const now = new Date();
		await OpentronsScannerPositionSet.create({
			_id,
			robotId,
			title,
			positionCount,
			positions: [],
			isDefault: false,
			pipetteMount,
			pipetteName,
			calibratedBy: { _id: locals.user._id, username: locals.user.username },
			calibratedAt: now,
			updatedBy: { _id: locals.user._id, username: locals.user.username }
		});

		await AuditLog.create({
			_id: generateId(),
			tableName: 'opentrons_scanner_position_sets',
			recordId: _id,
			action: 'create',
			newData: { robotId, title, positionCount, pipetteMount, pipetteName },
			changedAt: now,
			changedBy: locals.user.username
		});

		throw redirect(303, `/manufacturing/cart-mfg/deck-calibration/scanner-positions/${_id}`);
	}
};
