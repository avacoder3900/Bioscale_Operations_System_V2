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

	const reagent = (settingsDoc as any)?.reagentFilling ?? {};

	return {
		settings: {
			coolingDurationMinutes: reagent.minCoolingTimeMin ?? 30,
			defaultRobotId: null,
			fillTimePerCartridgeMin: reagent.fillTimePerCartridgeMin ?? null
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

		for (const key of ['minCoolingTimeMin', 'fillTimePerCartridgeMin']) {
			const val = data.get(key);
			if (val !== null && val !== '') update[`reagentFilling.${key}`] = Number(val);
		}

		await ManufacturingSettings.findByIdAndUpdate('default', { $set: { ...update, updatedAt: new Date() } }, { upsert: true });
		return { success: true };
	}
};
