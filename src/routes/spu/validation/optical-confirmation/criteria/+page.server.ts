import { requirePermission } from '$lib/server/permissions';
import { connectDB, ManufacturingSettings, AssayDefinition } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'manufacturing:admin');
	await connectDB();

	const settings = await ManufacturingSettings.findById('default')
		.select('opticalConfirmation')
		.lean();

	const assays = await AssayDefinition.find({ isActive: { $ne: false } })
		.select('name skuCode')
		.sort({ name: 1 })
		.lean();

	return {
		opticalConfirmation: JSON.parse(
			JSON.stringify((settings as { opticalConfirmation?: unknown } | null)?.opticalConfirmation ?? null)
		),
		assays: JSON.parse(JSON.stringify(assays))
	};
};

export const config = { maxDuration: 60 };
