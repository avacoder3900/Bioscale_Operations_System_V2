import { connectDB, DeviceCrash } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, locals }) => {
	requirePermission(locals.user, 'device:read');
	await connectDB();

	const page = parseInt(url.searchParams.get('page') || '1');
	const limit = 50;
	const deviceId = url.searchParams.get('deviceId') || null;
	const category = url.searchParams.get('category') || null;
	const firmware = url.searchParams.get('firmware') || null;
	const from = url.searchParams.get('from') || null;
	const to = url.searchParams.get('to') || null;

	const filter: Record<string, any> = {};
	if (deviceId) filter.deviceId = deviceId;
	if (category) filter.crashCategory = category;
	if (firmware) filter.firmwareVersion = parseInt(firmware);
	if (from || to) {
		filter.detectedAt = {} as Record<string, Date>;
		if (from) filter.detectedAt.$gte = new Date(from);
		if (to) filter.detectedAt.$lte = new Date(to + 'T23:59:59Z');
	}

	// Date boundaries for stats
	const now = new Date();
	const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
	const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

	const [
		crashes,
		total,
		categoryAgg,
		checkpointAgg,
		deviceAgg,
		last7Days,
		last24Hours
	] = await Promise.all([
		DeviceCrash.find(filter)
			.sort({ detectedAt: -1 })
			.skip((page - 1) * limit)
			.limit(limit)
			.lean(),
		DeviceCrash.countDocuments(filter),
		DeviceCrash.aggregate([
			{ $group: { _id: '$crashCategory', count: { $sum: 1 } } },
			{ $sort: { count: -1 } }
		]),
		DeviceCrash.aggregate([
			{ $group: { _id: '$lastCheckpoint', name: { $first: '$lastCheckpointName' }, count: { $sum: 1 } } },
			{ $sort: { count: -1 } },
			{ $limit: 1 }
		]),
		DeviceCrash.aggregate([
			{ $group: { _id: '$deviceId', count: { $sum: 1 } } },
			{ $sort: { count: -1 } },
			{ $limit: 1 }
		]),
		DeviceCrash.countDocuments({ detectedAt: { $gte: sevenDaysAgo } }),
		DeviceCrash.countDocuments({ detectedAt: { $gte: oneDayAgo } })
	]);

	// Collect distinct values for filter dropdowns
	const [devices, categories, firmwareVersions] = await Promise.all([
		DeviceCrash.distinct('deviceId'),
		DeviceCrash.distinct('crashCategory'),
		DeviceCrash.distinct('firmwareVersion')
	]);

	return {
		crashes: JSON.parse(JSON.stringify(crashes)),
		pagination: {
			page,
			limit,
			total,
			hasNext: page * limit < total,
			hasPrev: page > 1
		},
		stats: {
			totalAllTime: await DeviceCrash.countDocuments(),
			last7Days,
			last24Hours,
			topCategory: categoryAgg[0] ? { name: categoryAgg[0]._id, count: categoryAgg[0].count } : null,
			topCheckpoint: checkpointAgg[0] ? { code: checkpointAgg[0]._id, name: checkpointAgg[0].name, count: checkpointAgg[0].count } : null,
			topDevice: deviceAgg[0] ? { deviceId: deviceAgg[0]._id, count: deviceAgg[0].count } : null
		},
		filterOptions: {
			devices,
			categories,
			firmwareVersions: firmwareVersions.filter((v: any) => v !== null).sort((a: number, b: number) => b - a)
		},
		currentFilters: { deviceId, category, firmware, from, to }
	};
};
