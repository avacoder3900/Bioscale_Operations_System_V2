import { requirePermission } from '$lib/server/permissions';
import { connectDB, mongoose } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();
	const db = mongoose.connection.db;

	const cartridges = await db
		.collection('cartridge_records')
		.find({ assayCategory: 'optical_test' })
		.project({ _id: 1, assayId: 1, status: 1 })
		.sort({ assayCategorizedAt: -1 })
		.limit(200)
		.toArray();

	return {
		cartridges: JSON.parse(JSON.stringify(cartridges)),
		dbName: db.databaseName
	};
};

export const config = { maxDuration: 60 };
