import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationGroup, OpticalTestCartridge } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();

	const groups = await ValidationGroup.find().select('name color').sort({ name: 1 }).limit(50).lean();

	const cartridges = await OpticalTestCartridge.find()
		.select('barcode assay status groupId createdAt')
		.sort({ createdAt: -1 })
		.limit(200)
		.lean();

	return {
		groups: JSON.parse(JSON.stringify(groups)),
		cartridges: JSON.parse(JSON.stringify(cartridges))
	};
};

export const config = { maxDuration: 60 };
