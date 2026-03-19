import { json } from '@sveltejs/kit';
import { connectDB, CartridgeRecord } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	await connectDB();

	const query = url.searchParams.get('q')?.trim();
	if (!query || query.length < 2) {
		return json({ error: 'Search query must be at least 2 characters' }, { status: 400 });
	}

	// Search by cartridge ID, barcode, or lot QR code
	const cartridges = await CartridgeRecord.find({
		$or: [
			{ _id: { $regex: query, $options: 'i' } },
			{ 'backing.lotQrCode': { $regex: query, $options: 'i' } },
			{ 'backing.lotId': { $regex: query, $options: 'i' } },
			{ 'storage.containerBarcode': { $regex: query, $options: 'i' } }
		]
	})
		.select('_id currentPhase backing.lotId reagentFilling.assayType.name storage.fridgeName createdAt')
		.sort({ createdAt: -1 })
		.limit(20)
		.lean();

	return json({
		success: true,
		results: (cartridges as any[]).map(c => ({
			cartridgeId: c._id,
			currentPhase: c.currentPhase ?? 'unknown',
			lotId: c.backing?.lotId ?? null,
			assayType: c.reagentFilling?.assayType?.name ?? null,
			storageLocation: c.storage?.fridgeName ?? null,
			createdAt: c.createdAt
		}))
	});
};
