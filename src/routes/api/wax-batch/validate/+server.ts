import { json, error } from '@sveltejs/kit';
import { connectDB, WaxBatch, ReceivingLot, generateId } from '$lib/server/db';
import type { RequestHandler } from './$types';

const FULL_TUBE_VOLUME_UL = 12000;
const WAX_TUBE_PART_NUMBER = 'PT-CT-110';

/**
 * Validate a scanned 15ml wax tube batch barcode.
 * Accepts either:
 *  - a WaxBatch.lotBarcode (created via Wax Creation), or
 *  - a ReceivingLot.lotId / bagBarcode for part PT-CT-110 (accessioned inventory).
 * In the ReceivingLot case, a WaxBatch is auto-created (and cached by
 * sourceReceivingLotId) so downstream volume tracking works unchanged.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const barcode = url.searchParams.get('barcode')?.trim();
	if (!barcode) {
		return json({ error: 'barcode query param is required' }, { status: 400 });
	}

	let batch = await WaxBatch.findOne({ lotBarcode: barcode })
		.select('_id lotNumber lotBarcode initialVolumeUl remainingVolumeUl fullTubeCount partialTubeMl createdAt')
		.lean() as any;

	if (!batch) {
		const lot = await ReceivingLot.findOne({
			$or: [{ lotId: barcode }, { bagBarcode: barcode }]
		}).lean() as any;

		if (!lot) {
			return json({
				error: `No wax batch or accessioned lot found for barcode "${barcode}". Create it via Wax Creation or accession a ${WAX_TUBE_PART_NUMBER} lot.`
			}, { status: 404 });
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
		if (tubeCount <= 0) {
			return json({ error: `Lot "${barcode}" is depleted (quantity 0).` }, { status: 400 });
		}

		batch = await WaxBatch.findOne({ sourceReceivingLotId: String(lot._id) })
			.select('_id lotNumber lotBarcode initialVolumeUl remainingVolumeUl fullTubeCount partialTubeMl createdAt')
			.lean() as any;

		if (!batch) {
			const initialVolumeUl = tubeCount * FULL_TUBE_VOLUME_UL;
			const lotNumber = lot.lotNumber || `ACC-${lot.lotId}`;
			const created = await WaxBatch.create({
				_id: generateId(),
				lotNumber,
				lotBarcode: barcode,
				initialVolumeUl,
				remainingVolumeUl: initialVolumeUl,
				fullTubeCount: tubeCount,
				partialTubeMl: 0,
				sourceReceivingLotId: String(lot._id),
				createdBy: { _id: locals.user._id, username: locals.user.username }
			});
			batch = created.toObject();
		}
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
