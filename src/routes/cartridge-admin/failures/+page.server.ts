import { redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, CartridgeRecord, AssayDefinition } from '$lib/server/db';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 50;

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();

	const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
	const search = url.searchParams.get('search') ?? '';
	const assayTypeId = url.searchParams.get('assayTypeId') ?? '';
	const sortBy = url.searchParams.get('sortBy') ?? 'createdAt';
	const sortDir = url.searchParams.get('sortDir') ?? 'desc';

	// Failures = cartridges rejected at any inspection step
	const filter: Record<string, any> = {
		$or: [
			{ 'reagentInspection.status': 'Rejected' },
			{ 'waxQc.status': 'Rejected' }
		]
	};
	if (assayTypeId) filter['reagentFilling.assayType._id'] = assayTypeId;
	if (search) filter._id = { $regex: search, $options: 'i' };

	const sortOrder = sortDir === 'asc' ? 1 : -1;

	const [rawCartridges, total, assayTypes] = await Promise.all([
		CartridgeRecord.find(filter)
			.sort({ [sortBy]: sortOrder })
			.skip((page - 1) * PAGE_SIZE)
			.limit(PAGE_SIZE)
			.lean(),
		CartridgeRecord.countDocuments(filter),
		AssayDefinition.find({ isActive: true, hidden: { $ne: true } }, { _id: 1, name: 1 }).lean()
	]);

	return {
		cartridges: (rawCartridges as any[]).map((c: any) => ({
			cartridgeId: c._id,
			currentLifecycleStage: c.status ?? 'unknown',
			assayTypeId: c.reagentFilling?.assayType?._id ?? null,
			assayTypeName: c.reagentFilling?.assayType?.name ?? null,
			reagentInspectionStatus: c.reagentInspection?.status ?? null,
			reagentInspectionReason: c.reagentInspection?.reason ?? null,
			waxQcStatus: (c as any).waxQc?.status ?? null,
			waxQcReason: (c as any).waxQc?.rejectionReason ?? null,
			createdAt: c.createdAt
		})),
		total,
		pageNum: page,
		pageSize: PAGE_SIZE,
		assayTypes: (assayTypes as any[]).map((a: any) => ({ id: a._id, name: a.name })),
		filters: { search, assayTypeId, sortBy, sortDir }
	};
};

export const config = { maxDuration: 60 };
