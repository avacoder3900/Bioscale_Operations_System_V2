import { requirePermission } from '$lib/server/permissions';
import { connectDB, CartridgeRecord } from '$lib/server/db';
import { getR2Url } from '$lib/server/services/r2';
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

		results = (cartridges as any[]).map((c) => {
			const photoRefs = (c.photos || []) as Array<{ imageId: string; capturedAt: Date; r2Key?: string; r2Url?: string }>;
			let previewUrl: string | null = null;

			if (photoRefs.length > 0) {
				const newest = [...photoRefs].sort((a, b) =>
					new Date(b.capturedAt || 0).getTime() - new Date(a.capturedAt || 0).getTime()
				)[0];

				// photos[] carries the R2 pointer directly (truth) — no cv_images lookup.
				if (newest.r2Url) previewUrl = newest.r2Url;
				else if (newest.r2Key) previewUrl = getR2Url(newest.r2Key);
			}

			return {
				cartridgeId: c._id,
				status: c.status ?? 'unknown',
				assayType: c.reagentFilling?.assayType?.name ?? null,
				photoCount: photoRefs.length,
				previewUrl,
				createdAt: c.createdAt
			};
		});
	}

	return {
		search,
		results: JSON.parse(JSON.stringify(results))
	};
};

export const config = { maxDuration: 60 };
