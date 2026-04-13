import { requirePermission } from '$lib/server/permissions';
import { connectDB, CartridgeRecord } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	requirePermission(locals.user, 'cartridgeAdmin:read');
	await connectDB();

	const search = url.searchParams.get('q')?.trim() || '';

	// If a search term is provided, find matching cartridges
	let results: any[] = [];
	if (search) {
		const cartridges = await CartridgeRecord.find({
			$or: [
				{ _id: { $regex: search, $options: 'i' } },
				{ 'backing.lotQrCode': { $regex: search, $options: 'i' } },
				{ 'backing.lotId': { $regex: search, $options: 'i' } }
			]
		})
			.select('_id status photos reagentFilling.assayType.name createdAt')
			.sort({ createdAt: -1 })
			.limit(20)
			.lean();

		results = (cartridges as any[]).map(c => ({
			cartridgeId: c._id,
			status: c.status ?? 'unknown',
			assayType: c.reagentFilling?.assayType?.name ?? null,
			photoCount: (c.photos || []).length,
			createdAt: c.createdAt
		}));
	}

	return {
		search,
		results: JSON.parse(JSON.stringify(results))
	};
};

export const config = { maxDuration: 60 };
