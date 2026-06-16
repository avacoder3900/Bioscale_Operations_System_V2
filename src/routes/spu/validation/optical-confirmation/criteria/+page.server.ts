import { requirePermission } from '$lib/server/permissions';
import { connectDB, ManufacturingSettings } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'manufacturing:admin');
	await connectDB();

	const settings = await ManufacturingSettings.findById('default')
		.select('opticalConfirmation')
		.lean();

	return {
		opticalConfirmation: JSON.parse(
			JSON.stringify((settings as { opticalConfirmation?: unknown } | null)?.opticalConfirmation ?? null)
		)
	};
};

export const config = { maxDuration: 60 };
