import { requirePermission } from '$lib/server/permissions';
import { connectDB, AssayDefinition, LabCartridge } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();

	const assays = await AssayDefinition.find({ isActive: { $ne: false } })
		.select('name skuCode')
		.sort({ name: 1 })
		.lean();

	const cartridges = await LabCartridge.find({ cartridgeType: 'optical_test' })
		.select('barcode assay status expirationDate createdAt')
		.sort({ createdAt: -1 })
		.limit(200)
		.lean();

	return {
		assays: JSON.parse(JSON.stringify(assays)),
		cartridges: JSON.parse(JSON.stringify(cartridges))
	};
};

export const config = { maxDuration: 60 };
