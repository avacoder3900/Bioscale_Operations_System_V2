import { json, error } from '@sveltejs/kit';
import { connectDB, WaxBatch } from '$lib/server/db';
import type { RequestHandler } from './$types';

/**
 * Validate a scanned 15ml wax tube batch barcode.
 * Returns batch info + remaining volume so the UI can show current stock.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const barcode = url.searchParams.get('barcode')?.trim();
	if (!barcode) {
		return json({ error: 'barcode query param is required' }, { status: 400 });
	}

	const batch = await WaxBatch.findOne({ lotBarcode: barcode })
		.select('_id lotNumber lotBarcode initialVolumeUl remainingVolumeUl fullTubeCount partialTubeMl createdAt')
		.lean() as any;

	if (!batch) {
		return json({ error: `No wax batch found for barcode "${barcode}". Create it via Wax Creation first.` }, { status: 404 });
	}

	return json({
		success: true,
		batch: {
			_id: String(batch._id),
			lotNumber: batch.lotNumber,
			lotBarcode: batch.lotBarcode,
			initialVolumeUl: batch.initialVolumeUl,
			remainingVolumeUl: batch.remainingVolumeUl,
			fullTubeCount: batch.fullTubeCount,
			partialTubeMl: batch.partialTubeMl,
			createdAt: batch.createdAt
		}
	});
};
