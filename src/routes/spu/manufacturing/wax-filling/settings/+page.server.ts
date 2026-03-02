import { redirect } from '@sveltejs/kit';
import { connectDB, ManufacturingSettings, OpentronsRobot } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:admin');
	await connectDB();

	const [settingsDoc, robots] = await Promise.all([
		ManufacturingSettings.findById('default').lean(),
		OpentronsRobot.find({ isActive: true }, { _id: 1, name: 1 }).lean()
	]);

	const wax = (settingsDoc as any)?.waxFilling ?? {};

	return {
		settings: {
			ovenDurationMinutes: wax.minOvenTimeMin ?? 60,
			defaultRobotId: null,
			runDurationMin: wax.runDurationMin ?? null,
			removeDeckWarningMin: wax.removeDeckWarningMin ?? null,
			coolingWarningMin: wax.coolingWarningMin ?? null,
			deckLockoutMin: wax.deckLockoutMin ?? null,
			incubatorTempC: wax.incubatorTempC ?? null,
			heaterTempC: wax.heaterTempC ?? null,
			waxPerDeckUl: wax.waxPerDeckUl ?? null,
			tubeCapacityUl: wax.tubeCapacityUl ?? null,
			waxPerCartridgeUl: wax.waxPerCartridgeUl ?? null,
			cartridgesPerColumn: wax.cartridgesPerColumn ?? null
		},
		robots: robots.map((r: any) => ({ robotId: r._id, name: r.name }))
	};
};

export const actions: Actions = {
	update: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:admin');
		await connectDB();

		const data = await request.formData();
		const update: Record<string, any> = {};

		for (const key of ['minOvenTimeMin', 'runDurationMin', 'removeDeckWarningMin', 'coolingWarningMin',
			'deckLockoutMin', 'incubatorTempC', 'heaterTempC', 'waxPerDeckUl', 'tubeCapacityUl',
			'waxPerCartridgeUl', 'cartridgesPerColumn']) {
			const val = data.get(key);
			if (val !== null && val !== '') update[`waxFilling.${key}`] = Number(val);
		}

		await ManufacturingSettings.findByIdAndUpdate('default', { $set: { ...update, updatedAt: new Date() } }, { upsert: true });
		return { success: true };
	}
};
