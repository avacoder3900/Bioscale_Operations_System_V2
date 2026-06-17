import { requirePermission } from '$lib/server/permissions';
import { connectDB, mongoose, CartridgeGroup } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();

	const groups = await CartridgeGroup.find().select('name color').sort({ name: 1 }).limit(50).lean();

	// Cartridges that have been categorized as optical-test (assayId set on the cartridge_records doc).
	const col = mongoose.connection.db.collection('cartridge_records');
	const cartridges = await col
		.find({ assayId: { $exists: true, $ne: null } })
		.project({ _id: 1, assayId: 1, validationGroupId: 1, currentPhase: 1, assayCategorizedAt: 1 })
		.sort({ assayCategorizedAt: -1 })
		.limit(200)
		.toArray();

	return {
		groups: JSON.parse(JSON.stringify(groups)),
		cartridges: JSON.parse(JSON.stringify(cartridges)),
		dbName: mongoose.connection.db.databaseName
	};
};

export const config = { maxDuration: 60 };
