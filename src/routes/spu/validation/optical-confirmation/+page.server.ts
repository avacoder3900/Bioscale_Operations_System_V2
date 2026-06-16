import { requirePermission, hasPermission } from '$lib/server/permissions';
import { connectDB, ManufacturingSettings, AssayDefinition, CartridgeGroup, LabCartridge } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();

	const settings = await ManufacturingSettings.findById('default').select('opticalConfirmation').lean();
	const presetAssay = (settings as { opticalConfirmation?: { assay?: unknown } } | null)?.opticalConfirmation?.assay ?? null;

	const canSetAssay = hasPermission(locals.user, 'manufacturing:admin');
	const assays = canSetAssay
		? await AssayDefinition.find({ isActive: { $ne: false } }).select('name skuCode').sort({ name: 1 }).lean()
		: [];

	const groups = await CartridgeGroup.find().select('name color').sort({ name: 1 }).limit(50).lean();

	const cartridges = await LabCartridge.find({ cartridgeType: 'optical_test' })
		.select('barcode assay status expirationDate groupId createdAt')
		.sort({ createdAt: -1 })
		.limit(200)
		.lean();

	return {
		presetAssay: JSON.parse(JSON.stringify(presetAssay)),
		assays: JSON.parse(JSON.stringify(assays)),
		groups: JSON.parse(JSON.stringify(groups)),
		cartridges: JSON.parse(JSON.stringify(cartridges)),
		canSetAssay
	};
};

export const config = { maxDuration: 60 };
