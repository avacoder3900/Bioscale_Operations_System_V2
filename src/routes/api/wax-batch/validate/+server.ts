import { json, error } from '@sveltejs/kit';
import { connectDB, ReceivingLot, WaxBatch } from '$lib/server/db';
import type { RequestHandler } from './$types';

const FULL_TUBE_VOLUME_UL = 12000;
const WAX_TUBE_PART_NUMBER = 'PT-CT-114';

/**
 * Validate a scanned 15ml wax tube lot barcode. Two sources are checked:
 *
 *   1. ReceivingLot — purchased / received tubes. Remaining volume is computed
 *      from lot.quantity × 12000 μL minus lot.consumedUl. Must be PT-CT-114.
 *   2. WaxBatch — in-house wax produced via /manufacturing/cart-mfg/wax-creation.
 *      Used only when no ReceivingLot matches the barcode. Remaining volume
 *      comes directly from the WaxBatch document (kept in sync by completeRun).
 *
 * Both branches return the same batch-shaped payload so the wax-filling UI
 * doesn't need to know which source matched.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const barcode = url.searchParams.get('barcode')?.trim();
	if (!barcode) {
		return json({ error: 'barcode query param is required' }, { status: 400 });
	}

	const lot = await ReceivingLot.findOne({
		$or: [{ lotId: barcode }, { bagBarcode: barcode }, { lotNumber: barcode }]
	}).lean() as any;

	if (lot) {
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
				createdAt: lot.createdAt,
				source: 'receiving_lot'
			}
		});
	}

	// Fall back to in-house WaxBatch (created via wax-creation). lotBarcode is
	// the scannable label printed at creation time; lotNumber is the WAX-YYYY-
	// NNNN sequential id — accept either since operators may scan whichever
	// label is on the tube.
	const batch = await WaxBatch.findOne({
		$or: [{ lotBarcode: barcode }, { lotNumber: barcode }]
	}).lean() as any;

	if (!batch) {
		return json({ error: `No wax tube lot or in-house batch found for barcode "${barcode}".` }, { status: 404 });
	}

	const remainingVolumeUl = Number(batch.remainingVolumeUl ?? 0);
	if (remainingVolumeUl <= 0) {
		return json({ error: `Wax batch "${barcode}" is depleted.` }, { status: 400 });
	}

	return json({
		success: true,
		batch: {
			_id: String(batch._id),
			lotNumber: batch.lotNumber,
			lotBarcode: batch.lotBarcode,
			initialVolumeUl: Number(batch.initialVolumeUl ?? 0),
			remainingVolumeUl,
			fullTubeCount: Number(batch.fullTubeCount ?? 0),
			partialTubeMl: Number(batch.partialTubeMl ?? 0),
			createdAt: batch.createdAt,
			source: 'wax_batch'
		}
	});
};
