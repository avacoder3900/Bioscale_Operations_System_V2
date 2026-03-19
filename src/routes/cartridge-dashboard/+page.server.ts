import { redirect } from '@sveltejs/kit';
import { connectDB, LabCartridge, CartridgeGroup } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'cartridge:read');

	await connectDB();

	const [statusCounts, typeCounts, groups, recentActivity] = await Promise.all([
		LabCartridge.aggregate([
			{ $group: { _id: '$status', count: { $sum: 1 } } }
		]),
		LabCartridge.aggregate([
			{ $group: { _id: '$cartridgeType', count: { $sum: 1 } } }
		]),
		CartridgeGroup.find().lean(),
		LabCartridge.find()
			.sort({ updatedAt: -1 })
			.limit(20)
			.lean()
	]);

	const groupCounts = await LabCartridge.aggregate([
		{ $match: { groupId: { $ne: null } } },
		{ $group: { _id: '$groupId', count: { $sum: 1 } } }
	]);

	const groupMap = new Map(groups.map((g: any) => [g._id, g]));

	return {
		statusCounts: statusCounts.map((s: any) => ({ status: s._id, count: s.count })),
		typeCounts: typeCounts.map((t: any) => ({ type: t._id, count: t.count })),
		groupSummary: groupCounts.map((g: any) => {
			const group = groupMap.get(g._id) as any;
			return { groupId: g._id, groupName: group?.name ?? 'Unknown', color: group?.color, count: g.count };
		}),
		recentActivity: recentActivity.map((c: any) => ({
			id: c._id,
			barcode: c.barcode,
			status: c.status,
			cartridgeType: c.cartridgeType,
			updatedAt: c.updatedAt
		})),
		totalCartridges: await LabCartridge.countDocuments()
	};
};
