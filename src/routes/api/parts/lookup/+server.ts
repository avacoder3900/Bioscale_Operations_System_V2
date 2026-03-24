import { json, error } from '@sveltejs/kit';
import { connectDB, ReceivingLot } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) {
		throw error(401, 'Unauthorized');
	}

	const barcode = url.searchParams.get('barcode')?.trim();
	if (!barcode) {
		return json({ error: 'barcode query parameter is required' }, { status: 400 });
	}

	await connectDB();

	const lot = await ReceivingLot.findOne({
		$or: [{ lotId: barcode }, { bagBarcode: barcode }]
	}).lean() as any;

	if (!lot) {
		return json({ found: false }, { status: 404 });
	}

	return json({
		found: true,
		lot: {
			_id: lot._id,
			lotId: lot.lotId,
			lotNumber: lot.lotNumber,
			part: lot.part,
			quantity: lot.quantity,
			status: lot.status,
			bagBarcode: lot.bagBarcode,
			createdAt: lot.createdAt
		}
	});
};
