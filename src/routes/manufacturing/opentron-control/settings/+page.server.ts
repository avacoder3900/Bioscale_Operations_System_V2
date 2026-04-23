import { redirect } from '@sveltejs/kit';
import { connectDB, ManufacturingSettings } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

export const config = { maxDuration: 60 };

const waxDefaults = {
	minOvenTimeMin: 60,
	runDurationMin: 45,
	removeDeckWarningMin: 5,
	coolingWarningMin: 30,
	deckLockoutMin: 60,
	incubatorTempC: 37,
	heaterTempC: 65,
	waxPerDeckUl: 5000,
	tubeCapacityUl: 20000,
	waxPerCartridgeUl: 100,
	cartridgesPerColumn: 8
};

const reagentDefaults = {
	minCoolingTimeMin: 30,
	fillTimePerCartridgeMin: 0.5,
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

		return {
			wax: {
				minOvenTimeMin: wax.minOvenTimeMin ?? waxDefaults.minOvenTimeMin,
				runDurationMin: wax.runDurationMin ?? waxDefaults.runDurationMin,
				removeDeckWarningMin: wax.removeDeckWarningMin ?? waxDefaults.removeDeckWarningMin,
				coolingWarningMin: wax.coolingWarningMin ?? waxDefaults.coolingWarningMin,
				deckLockoutMin: wax.deckLockoutMin ?? waxDefaults.deckLockoutMin,
				incubatorTempC: wax.incubatorTempC ?? waxDefaults.incubatorTempC,
				heaterTempC: wax.heaterTempC ?? waxDefaults.heaterTempC,
				waxPerDeckUl: wax.waxPerDeckUl ?? waxDefaults.waxPerDeckUl,
				tubeCapacityUl: wax.tubeCapacityUl ?? waxDefaults.tubeCapacityUl,
				waxPerCartridgeUl: wax.waxPerCartridgeUl ?? waxDefaults.waxPerCartridgeUl,
				cartridgesPerColumn: wax.cartridgesPerColumn ?? waxDefaults.cartridgesPerColumn
			},
			reagent: {
				minCoolingTimeMin: reagent.minCoolingTimeMin ?? reagentDefaults.minCoolingTimeMin,
				fillTimePerCartridgeMin: reagent.fillTimePerCartridgeMin ?? reagentDefaults.fillTimePerCartridgeMin,
				maxTimeBeforeSealMin: reagent.maxTimeBeforeSealMin ?? reagentDefaults.maxTimeBeforeSealMin
			},
			lastUpdatedAt: doc?.updatedAt ? new Date(doc.updatedAt).toISOString() : null
		};
	} catch (err) {
		console.error('[OPENTRON-CONTROL SETTINGS] load error:', err instanceof Error ? err.message : err);
		return {
			wax: waxDefaults,
			reagent: reagentDefaults,
			lastUpdatedAt: null
		};
	}
};
