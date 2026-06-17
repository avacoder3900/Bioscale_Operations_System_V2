import { requirePermission } from '$lib/server/permissions';
import { connectDB, mongoose, CartridgeGroup } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();

	const groups = await CartridgeGroup.find().select('name color').sort({ name: 1 }).limit(50).lean();

	// Cartridges made runnable as optical-test (research/SPU shape: status linked + assayId set).
	const col = mongoose.connection.db.collection('cartridge_records');
	const cartridges = await col
		.find({ assayCategory: 'optical_test' })
		.project({ _id: 1, status: 1, assayId: 1, serialNumber: 1, validationGroupId: 1 })
		.sort({ statusUpdatedOn: -1 })
		.limit(200)
		.toArray();

	return {
		groups: JSON.parse(JSON.stringify(groups)),
		cartridges: JSON.parse(JSON.stringify(cartridges)),
		dbName: mongoose.connection.db.databaseName
	};
};

export const config = { maxDuration: 60 };
