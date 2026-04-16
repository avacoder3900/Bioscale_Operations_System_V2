import { json, error } from '@sveltejs/kit';
import { connectDB, ReceivingLot } from '$lib/server/db';
import type { RequestHandler } from './$types';

const FULL_TUBE_VOLUME_UL = 12000;
const WAX_TUBE_PART_NUMBER = 'PT-CT-110';

/**
 * Validate a scanned 15ml wax tube lot barcode against receiving inventory.
 * Accepts ReceivingLot.lotId or ReceivingLot.bagBarcode. Returns a batch-shaped
 * payload so the existing wax-filling UI keeps working. Remaining volume is
 * computed from lot.quantity × 12000 μL minus lot.consumedUl (partial wax
 * consumption tracked on the lot itself).
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const barcode = url.searchParams.get('barcode')?.trim();
	if (!barcode) {
		return json({ error: 'barcode query param is required' }, { status: 400 });
	}

	const lot = await ReceivingLot.findOne({
		$or: [{ lotId: barcode }, { bagBarcode: barcode }]
	}).lean() as any;

	if (!lot) {
		return json({ error: `No receiving lot found for barcode "${barcode}".` }, { status: 404 });
	}

	if (lot.part?.partNumber !== WAX_TUBE_PART_NUMBER) {
		return json({
			error: `Lot "${barcode}" is for part ${lot.part?.partNumber ?? 'unknown'}, expected ${WAX_TUBE_PART_NUMBER} (15ml wax tube).`
		}, { status: 400 });
	}

	if (lot.status !== 'accepted' && lot.status !== 'in_progress') {
		return json({
			error: `Lot "${barcode}" has status "${lot.status}" — not available for wax filling.`
		}, { status: 400 });
	}

	const tubeCount = Number(lot.quantity ?? 0);
	const consumedUl = Number(lot.consumedUl ?? 0);
	const totalUl = tubeCount * FULL_TUBE_VOLUME_UL;
	const remainingVolumeUl = Math.max(0, totalUl - consumedUl);

	if (tubeCount <= 0 || remainingVolumeUl <= 0) {
		return json({ error: `Lot "${barcode}" is depleted.` }, { status: 400 });
	}

	return json({
		success: true,
		batch: {
			_id: String(lot._id),
			lotNumber: lot.lotNumber || lot.lotId,
			lotBarcode: barcode,
			initialVolumeUl: totalUl,
			remainingVolumeUl,
			fullTubeCount: tubeCount,
			partialTubeMl: 0,
			createdAt: lot.createdAt
		}
	});
};
