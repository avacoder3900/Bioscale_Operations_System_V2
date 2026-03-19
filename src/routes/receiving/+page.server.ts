import { requirePermission } from '$lib/server/permissions';
import { connectDB, ReceivingLot } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	requirePermission(locals.user, 'inventory:read');
	await connectDB();

	// S8: Dashboard filters
	const statusFilter = url.searchParams.get('status') ?? '';
	const partFilter = url.searchParams.get('part') ?? '';
	const startDate = url.searchParams.get('startDate') ?? '';
	const endDate = url.searchParams.get('endDate') ?? '';
	const operatorFilter = url.searchParams.get('operator') ?? '';
	const search = url.searchParams.get('search') ?? '';

	const filter: Record<string, any> = {};

	if (statusFilter) filter.status = statusFilter;
	if (partFilter) filter['part._id'] = partFilter;
	if (operatorFilter) filter['operator.username'] = { $regex: operatorFilter, $options: 'i' };
	if (startDate || endDate) {
		filter.createdAt = {};
		if (startDate) filter.createdAt.$gte = new Date(startDate);
		if (endDate) filter.createdAt.$lte = new Date(endDate + 'T23:59:59.999Z');
	}
	if (search) {
		filter.$or = [
			{ lotId: { $regex: search, $options: 'i' } },
			{ lotNumber: { $regex: search, $options: 'i' } },
			{ 'part.partNumber': { $regex: search, $options: 'i' } },
			{ 'part.name': { $regex: search, $options: 'i' } },
			{ poReference: { $regex: search, $options: 'i' } }
		];
	}

	const lots = await ReceivingLot.find(filter)
		.sort({ createdAt: -1 })
		.limit(200)
		.lean();

	return {
		lots: JSON.parse(JSON.stringify(lots)),
		filters: { status: statusFilter, part: partFilter, startDate, endDate, operator: operatorFilter, search }
	};
};

export const config = { maxDuration: 60 };
