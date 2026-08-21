import { redirect, fail } from '@sveltejs/kit';
import {
	connectDB,
	ManufacturingSettings,
	OpentronsRobot,
	OpentronsScannerPositionSet,
	AuditLog,
	generateId
} from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { estimateReagentRunSeconds } from '$lib/manufacturing/reagent-run-estimate';
import type { PageServerLoad, Actions } from './$types';

export const config = { maxDuration: 60 };

const waxDefaults = {
	minOvenTimeMin: 60,
	runDurationMin: 45,
	removeDeckWarningMin: 5,
	coolingWarningMin: 30,
	deckLockoutMin: 60,
	minCoolingBeforeQcMin: 2,
	incubatorTempC: 37,
	heaterTempC: 65,
	waxPerDeckUl: 5000,
	tubeCapacityUl: 20000,
	waxPerCartridgeUl: 100,
	cartridgesPerColumn: 8
};

/** The shape this read-only card quotes an estimate for: a full deck, all four rows. */
const FULL_DECK_CARTRIDGES = 24;
const FULL_DECK_PARAMS = { well_2: true, well_3: true, well_4: true, well_5: true };

const reagentDefaults = {
	minCoolingTimeMin: 30,
	fullDeckEstimateMin: Math.round(
		estimateReagentRunSeconds(FULL_DECK_PARAMS, FULL_DECK_CARTRIDGES, null).seconds / 60
	),
	maxTimeBeforeSealMin: 60
};

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');

	try {
		await connectDB();
		const doc = (await ManufacturingSettings.findById('default').lean()) as any;
		const wax = doc?.waxFilling ?? {};
		const reagent = doc?.reagentFilling ?? {};

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
			positionSets: JSON.parse(JSON.stringify(positionSets)),
			wax: {
				minOvenTimeMin: wax.minOvenTimeMin ?? waxDefaults.minOvenTimeMin,
				runDurationMin: wax.runDurationMin ?? waxDefaults.runDurationMin,
				removeDeckWarningMin: wax.removeDeckWarningMin ?? waxDefaults.removeDeckWarningMin,
				coolingWarningMin: wax.coolingWarningMin ?? waxDefaults.coolingWarningMin,
				deckLockoutMin: wax.deckLockoutMin ?? waxDefaults.deckLockoutMin,
				minCoolingBeforeQcMin: wax.minCoolingBeforeQcMin ?? waxDefaults.minCoolingBeforeQcMin,
				incubatorTempC: wax.incubatorTempC ?? waxDefaults.incubatorTempC,
				heaterTempC: wax.heaterTempC ?? waxDefaults.heaterTempC,
				waxPerDeckUl: wax.waxPerDeckUl ?? waxDefaults.waxPerDeckUl,
				tubeCapacityUl: wax.tubeCapacityUl ?? waxDefaults.tubeCapacityUl,
				waxPerCartridgeUl: wax.waxPerCartridgeUl ?? waxDefaults.waxPerCartridgeUl,
				cartridgesPerColumn: wax.cartridgesPerColumn ?? waxDefaults.cartridgesPerColumn
			},
			reagent: {
				minCoolingTimeMin: reagent.minCoolingTimeMin ?? reagentDefaults.minCoolingTimeMin,
				fullDeckEstimateMin: Math.round(
					estimateReagentRunSeconds(FULL_DECK_PARAMS, FULL_DECK_CARTRIDGES, reagent).seconds / 60
				),
				maxTimeBeforeSealMin: reagent.maxTimeBeforeSealMin ?? reagentDefaults.maxTimeBeforeSealMin
			},
			lastUpdatedAt: doc?.updatedAt ? new Date(doc.updatedAt).toISOString() : null
		};
	} catch (err) {
		console.error('[OPENTRON-CONTROL SETTINGS] load error:', err instanceof Error ? err.message : err);
		return {
			robots: [],
			positionSets: [],
			wax: waxDefaults,
			reagent: reagentDefaults,
			lastUpdatedAt: null
		};
	}
};

export const actions: Actions = {
	/**
	 * Create a new scanner position set, then redirect into its teach page.
	 * Form fields: robotId, title, positionCount, pipetteMount?, pipetteName?
	 */
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

		throw redirect(303, `/manufacturing/cart-mfg/opentron-control/settings/scanner-positions/${_id}`);
	}
};
