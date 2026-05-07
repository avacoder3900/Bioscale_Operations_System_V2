/**
 * Teach panel for an OpentronsScannerPositionSet.
 *
 * Load: fetches the set + the robot it belongs to.
 * Actions: setDefault, rename, deleteSet — quick metadata edits. Per-slot
 * XYZ saves go through the JSON API (PUT /api/scanner-position-sets/...).
 */

import { redirect, fail, error as svelteError } from '@sveltejs/kit';
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

const DEFAULT_DEVICE_ID = 'lab-mac-scanner-1';

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');

	await connectDB();
	const set = (await OpentronsScannerPositionSet.findById(params.setId).lean()) as any;
	if (!set) svelteError(404, 'Position set not found');

	const robot = (await OpentronsRobot.findById(set.robotId)
		.select('_id name ip port robotSide robotModel')
		.lean()) as any;
	if (!robot) svelteError(404, 'Robot not found for this position set');

	return {
		set: JSON.parse(JSON.stringify(set)),
		robot: JSON.parse(JSON.stringify(robot)),
		defaultDeviceId: DEFAULT_DEVICE_ID
	};
};

export const actions: Actions = {
	setDefault: async ({ locals, params }) => {
		if (!locals.user) return fail(401, { error: 'Not signed in' });
		requirePermission(locals.user, 'manufacturing:write');

		await connectDB();
		const set = await OpentronsScannerPositionSet.findById(params.setId);
		if (!set) return fail(404, { error: 'Position set not found' });

		await OpentronsScannerPositionSet.updateMany(
			{ robotId: set.robotId, isDefault: true, _id: { $ne: set._id } },
			{ $set: { isDefault: false } }
		);
		await OpentronsScannerPositionSet.updateOne(
			{ _id: set._id },
			{
				$set: {
					isDefault: true,
					updatedBy: { _id: locals.user._id, username: locals.user.username }
				}
			}
		);

		await AuditLog.create({
			_id: generateId(),
			tableName: 'opentrons_scanner_position_sets',
			recordId: set._id,
			action: 'set_default',
			newData: { isDefault: true },
			changedAt: new Date(),
			changedBy: locals.user.username
		});

		return { success: true };
	},

	rename: async ({ request, locals, params }) => {
		if (!locals.user) return fail(401, { error: 'Not signed in' });
		requirePermission(locals.user, 'manufacturing:write');

		const data = await request.formData();
		const title = data.get('title')?.toString().trim();
		if (!title) return fail(400, { error: 'title required' });

		await connectDB();
		const set = await OpentronsScannerPositionSet.findById(params.setId);
		if (!set) return fail(404, { error: 'Position set not found' });

		const oldTitle = set.title;
		try {
			await OpentronsScannerPositionSet.updateOne(
				{ _id: set._id },
				{
					$set: {
						title,
						updatedBy: { _id: locals.user._id, username: locals.user.username }
					}
				}
			);
		} catch (e: any) {
			if (e?.code === 11000) return fail(409, { error: 'Title already in use for this robot' });
			throw e;
		}

		await AuditLog.create({
			_id: generateId(),
			tableName: 'opentrons_scanner_position_sets',
			recordId: set._id,
			action: 'rename',
			oldData: { title: oldTitle },
			newData: { title },
			changedAt: new Date(),
			changedBy: locals.user.username
		});

		return { success: true };
	},

	deleteSet: async ({ locals, params }) => {
		if (!locals.user) return fail(401, { error: 'Not signed in' });
		requirePermission(locals.user, 'manufacturing:write');

		await connectDB();
		const set = (await OpentronsScannerPositionSet.findById(params.setId).lean()) as any;
		if (!set) return fail(404, { error: 'Position set not found' });

		await OpentronsScannerPositionSet.deleteOne({ _id: params.setId });

		await AuditLog.create({
			_id: generateId(),
			tableName: 'opentrons_scanner_position_sets',
			recordId: params.setId,
			action: 'delete',
			oldData: { robotId: set.robotId, title: set.title, positionCount: set.positionCount },
			changedAt: new Date(),
			changedBy: locals.user.username
		});

		throw redirect(303, '/manufacturing/opentron-control/settings');
	}
};
