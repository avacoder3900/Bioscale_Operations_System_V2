import { requirePermission } from '$lib/server/permissions';
import { connectDB, ReceivingLot } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'inventory:read');
	await connectDB();

	const lots = await ReceivingLot.find()
		.sort({ createdAt: -1 })
		.lean();

	return {
		lots: JSON.parse(JSON.stringify(lots))
	};
};
