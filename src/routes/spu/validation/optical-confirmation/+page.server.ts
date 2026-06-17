import { requirePermission } from '$lib/server/permissions';
import { connectDB, mongoose } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();
	const db = mongoose.connection.db;

	// Experiments (with arms) — selecting an experiment + arm supplies the assay/folder/program context.
	const experiments = await db
		.collection('experiments')
		.find({ 'arms.0': { $exists: true } })
		.project({ _id: 1, name: 1, program: 1, folderId: 1, 'arms.name': 1, 'arms.assayId': 1, 'arms.assayName': 1 })
		.sort({ name: 1 })
		.limit(500)
		.toArray();

	const cartridges = await db
		.collection('cartridge_records')
		.find({ assayCategory: 'optical_test' })
		.project({ _id: 1, status: 1, assayId: 1, serialNumber: 1, experiment: 1, arm: 1 })
		.sort({ statusUpdatedOn: -1 })
		.limit(200)
		.toArray();

	return {
		experiments: JSON.parse(JSON.stringify(experiments)),
		cartridges: JSON.parse(JSON.stringify(cartridges)),
		dbName: db.databaseName
	};
};

export const config = { maxDuration: 60 };
