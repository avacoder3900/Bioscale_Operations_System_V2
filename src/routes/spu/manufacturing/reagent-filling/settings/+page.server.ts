import { redirect } from '@sveltejs/kit';
import { connectDB, ManufacturingSettings, OpentronsRobot, AssayDefinition } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:admin');
	await connectDB();

	const [settingsDoc, robots, assayDefs] = await Promise.all([
		ManufacturingSettings.findById('default').lean(),
		OpentronsRobot.find({ isActive: true }, { _id: 1, name: 1 }).lean(),
		AssayDefinition.find({}, { _id: 1, name: 1, skuCode: 1, isActive: 1, reagents: 1 }).sort({ name: 1 }).lean()
	]);

	const reagent = (settingsDoc as any)?.reagentFilling ?? {};
	const rejectionReasons: { id: string; code: string; label: string; sortOrder: number }[] =
		((settingsDoc as any)?.rejectionReasons ?? []).map((r: any, i: number) => ({
			id: r._id ?? String(i),
			code: r.code ?? '',
			label: r.label ?? '',
			sortOrder: r.sortOrder ?? i
		}));

	return {
		settings: {
			minCoolingTimeMin: reagent.minCoolingTimeMin ?? 30,
			coolingDurationMinutes: reagent.minCoolingTimeMin ?? 30,
			defaultRobotId: null,
			fillTimePerCartridgeMin: reagent.fillTimePerCartridgeMin ?? null
		},
		robots: robots.map((r: any) => ({ robotId: r._id, name: r.name })),
		assayTypes: assayDefs.map((a: any) => ({
			id: a._id,
			name: a.name,
			skuCode: a.skuCode ?? null,
			isActive: a.isActive ?? true,
			reagents: (a.reagents ?? []).map((r: any) => ({
				id: r._id,
				reagentName: r.reagentName ?? '',
				wellPosition: r.wellPosition ?? null,
				volumeMicroliters: r.volumeMicroliters ?? null,
				isActive: r.isActive ?? true
			}))
		})),
		rejectionReasons
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
