import { BarcodeSheetBatch } from '$lib/server/db/models/barcode-sheet-batch.js';

/**
 * Update barcode consumption tracking when CartridgeRecords are created.
 * Call this after WI-01 finishBatch creates CartridgeRecords with IDs
 * that were pre-generated from BarcodeSheetBatch.barcodeIds.
 */
export async function updateBarcodeConsumption(newCartridgeIds: string[]): Promise<void> {
	if (!newCartridgeIds.length) return;

	// Increment labelsUsed for each batch that contains these IDs
	for (const cid of newCartridgeIds) {
		await BarcodeSheetBatch.updateOne(
			{ barcodeIds: cid },
			{ $inc: { labelsUsed: 1 } }
		);
	}

	// Update status for fully consumed batches
	await BarcodeSheetBatch.updateMany(
		{ $expr: { $eq: ['$labelsUsed', '$totalLabels'] } },
		{ $set: { status: 'fully_consumed' } }
	);

	// Update status for partially used batches
	await BarcodeSheetBatch.updateMany(
		{
			$expr: {
				$and: [
					{ $gt: ['$labelsUsed', 0] },
					{ $lt: ['$labelsUsed', '$totalLabels'] }
				]
			}
		},
		{ $set: { status: 'partially_used' } }
	);
}
