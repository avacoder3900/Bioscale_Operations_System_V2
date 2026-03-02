import { redirect } from '@sveltejs/kit';
import { connectDB, AssayDefinition, CartridgeRecord } from '$lib/server/db';
import { hasPermission, requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	// Parse filter params
	const search = url.searchParams.get('search') || null;
	const status = url.searchParams.get('status') || null;

	// Build query
	const query: any = {};
	if (search) {
		query.$or = [
			{ name: { $regex: search, $options: 'i' } },
			{ skuCode: { $regex: search, $options: 'i' } }
		];
	}
	if (status === 'active') query.isActive = true;
	if (status === 'inactive') query.isActive = false;

	const [assays, linkedCounts] = await Promise.all([
		AssayDefinition.find(query).sort({ name: 1 }).lean(),
		CartridgeRecord.aggregate([
			{ $match: { 'reagentFilling.assayType._id': { $exists: true } } },
			{ $group: { _id: '$reagentFilling.assayType._id', count: { $sum: 1 } } }
		])
	]);

	// Build linked cartridge count map
	const linkedMap = new Map(linkedCounts.map((c: any) => [c._id, c.count]));

	// Compute stats from full list (before any future pagination)
	const allAssays = await AssayDefinition.find().lean();
	const totalLinked = linkedCounts.reduce((sum: number, c: any) => sum + c.count, 0);

	return {
		assays: assays.map((a: any) => ({
			assayId: a._id,
			name: a.name,
			duration: a.duration ?? null,
			bcodeLength: a.bcodeLength ?? null,
			version: a.versionHistory?.length ?? 0,
			linkedCartridges: linkedMap.get(a._id) ?? 0,
			isActive: a.isActive ?? true,
			updatedAt: a.updatedAt ?? null
		})),
		stats: {
			total: allAssays.length,
			active: allAssays.filter((a: any) => a.isActive).length,
			inactive: allAssays.filter((a: any) => !a.isActive).length,
			totalLinkedCartridges: totalLinked
		},
		filters: { search, status },
		canWrite: hasPermission(locals.user, 'assay:write'),
		canDelete: hasPermission(locals.user, 'assay:write')
	};
};
