import { requirePermission } from '$lib/server/permissions';
import { connectDB, Spu, LabCartridge, ManufacturingSettings } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const spus = await Spu.find({ status: { $in: ['assembled', 'assembling', 'validating'] } })
		.select('udi status validation.opticalConfirmation')
		.sort({ updatedAt: -1 })
		.limit(100)
		.lean();

	const cartridges = await LabCartridge.find({ cartridgeType: 'optical_test', status: 'available' })
		.select('barcode assay status expirationDate')
		.lean();

	const settings = await ManufacturingSettings.findById('default')
		.select('opticalConfirmation')
		.lean();
	const criteria = settings?.opticalConfirmation ?? null;

	return {
		spus: JSON.parse(JSON.stringify(spus)),
		cartridges: JSON.parse(JSON.stringify(cartridges)),
		criteria: JSON.parse(JSON.stringify(criteria))
	};
};

export const config = { maxDuration: 60 };
