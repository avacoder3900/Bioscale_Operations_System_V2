import { json, error } from '@sveltejs/kit';
import { connectDB, ReceivingLot } from '$lib/server/db';
import type { RequestHandler } from './$types';

/**
 * Validate a scanned ReceivingLot barcode (lotId or bagBarcode).
 * Used by workflows (wax-filling 2ml tube scan, etc.) to confirm a lot exists
 * and has remaining quantity. Does NOT deduct — just returns current state.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const barcode = url.searchParams.get('barcode')?.trim();
	const partNumber = url.searchParams.get('partNumber')?.trim();
	if (!barcode) {
		return json({ error: 'barcode query param is required' }, { status: 400 });
	}

	const lot = await ReceivingLot.findOne({
		$or: [{ lotId: barcode }, { bagBarcode: barcode }]
	})
		.select('_id lotId lotNumber part quantity status expirationDate')
		.lean() as any;

	if (!lot) {
		return json({ error: `No receiving lot found for barcode "${barcode}".` }, { status: 404 });
	}

	if (lot.status !== 'accepted' && lot.status !== 'in_progress') {
		return json({ error: `Lot "${barcode}" has status "${lot.status}" — not available for consumption.` }, { status: 400 });
	}

	if (partNumber && lot.part?.partNumber !== partNumber) {
		return json({ error: `Lot "${barcode}" is for part ${lot.part?.partNumber}, expected ${partNumber}.` }, { status: 400 });
	}

	if ((lot.quantity ?? 0) <= 0) {
		return json({ error: `Lot "${barcode}" is depleted (quantity 0).` }, { status: 400 });
	}

	return json({
		success: true,
		lot: {
			_id: String(lot._id),
			lotId: lot.lotId,
			lotNumber: lot.lotNumber,
			part: lot.part,
			quantity: lot.quantity,
			status: lot.status,
			expirationDate: lot.expirationDate
		}
	});
};
