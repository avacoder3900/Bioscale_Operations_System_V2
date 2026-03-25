import { json, error } from '@sveltejs/kit';
import { connectDB, ReceivingLot, PartDefinition } from '$lib/server/db';
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

	// First check if it's a lot barcode
	const lot = await ReceivingLot.findOne({
		$or: [{ lotId: barcode }, { bagBarcode: barcode }]
	}).lean() as any;

	if (lot) {
		// Enrich with full part data
		let partDetail = null;
		if (lot.part?._id) {
			const part = await PartDefinition.findById(lot.part._id).lean() as any;
			if (part) {
				partDetail = {
					_id: part._id,
					partNumber: part.partNumber,
					name: part.name,
					category: part.category,
					inventoryCount: part.inventoryCount,
					barcode: part.barcode
				};
			}
		}

		return json({
			found: true,
			type: 'lot',
			lot: {
				_id: lot._id,
				lotId: lot.lotId,
				lotNumber: lot.lotNumber,
				part: lot.part,
				quantity: lot.quantity,
				status: lot.status,
				bagBarcode: lot.bagBarcode,
				createdAt: lot.createdAt
			},
			partDetail
		});
	}

	// If not a lot, check if it's a part barcode
	const part = await PartDefinition.findOne({ barcode }).lean() as any;
	if (part) {
		return json({
			found: true,
			type: 'part',
			lot: null,
			partDetail: {
				_id: part._id,
				partNumber: part.partNumber,
				name: part.name,
				category: part.category,
				inventoryCount: part.inventoryCount,
				barcode: part.barcode
			}
		});
	}

	return json({ found: false }, { status: 404 });
};
