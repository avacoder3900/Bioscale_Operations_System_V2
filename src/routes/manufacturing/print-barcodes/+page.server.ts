import { fail } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection';
import { AuditLog, BarcodeSheetBatch, BarcodeInventory, CartridgeRecord } from '$lib/server/db/models';
import { generateId } from '$lib/server/db/utils';
import { requirePermission } from '$lib/server/permissions';
import { mintCartridgeBarcodes } from '$lib/server/services/barcode-generator';
import type { Actions, PageServerLoad } from './$types';

const TEMPLATE_VERSION = 'avery-94102-v1';
const LABELS_PER_SHEET = 80;

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const inventory = await BarcodeInventory.findById('default').lean() as
		| { avery94102SheetsOnHand?: number; alertThreshold?: number }
		| null;

	const recent = await BarcodeSheetBatch.find({})
		.select('firstBarcodeId lastBarcodeId totalLabels sheetsUsed printedAt printedBy')
		.sort({ printedAt: -1 })
		.limit(10)
		.lean();

	return {
		sheetsOnHand: inventory?.avery94102SheetsOnHand ?? 0,
		alertThreshold: inventory?.alertThreshold ?? 5,
		labelsPerSheet: LABELS_PER_SHEET,
		recent: JSON.parse(JSON.stringify(recent))
	};
};

export const actions: Actions = {
	print: async ({ request, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const sheetsToPrint = Number(data.get('sheetsToPrint') ?? 1);
		const count = Number(data.get('count') ?? LABELS_PER_SHEET);
		const skip = Number(data.get('skip') ?? 0);

		if (!Number.isInteger(sheetsToPrint) || sheetsToPrint < 1 || sheetsToPrint > 10) {
			return fail(400, { error: `Sheets to print must be 1–10` });
		}
		if (!Number.isInteger(count) || count < 1 || count > LABELS_PER_SHEET) {
			return fail(400, { error: `Count must be 1–${LABELS_PER_SHEET}` });
		}
		if (!Number.isInteger(skip) || skip < 0 || skip >= LABELS_PER_SHEET) {
			return fail(400, { error: `Skip must be 0–${LABELS_PER_SHEET - 1}` });
		}
		if (skip + count > LABELS_PER_SHEET) {
			return fail(400, { error: `Skip + count cannot exceed ${LABELS_PER_SHEET}` });
		}

		// First sheet has `count` labels (after `skip` blanks); each subsequent
		// sheet is a full 80. Total mint = count + (sheetsToPrint - 1) * 80.
		const totalLabels = count + (sheetsToPrint - 1) * LABELS_PER_SHEET;

		let barcodes: string[];
		try {
			barcodes = await mintCartridgeBarcodes(totalLabels);
		} catch (e) {
			return fail(409, { error: e instanceof Error ? e.message : 'Mint failed' });
		}

		// Visible spot-check: sample 5 random barcodes from the minted batch and
		// query cartridge_records for any matches. mintCartridgeBarcodes already
		// runs an exhaustive check internally, so this is belt-and-suspenders —
		// surfaces a separate visible verification line in the UI.
		const sampleSize = Math.min(5, barcodes.length);
		const shuffled = [...barcodes].sort(() => Math.random() - 0.5);
		const sample = shuffled.slice(0, sampleSize);
		const sampleCollisions = await CartridgeRecord.find({ barcode: { $in: sample } })
			.select('barcode')
			.lean();
		const spotCheck = {
			sampleSize,
			collisions: (sampleCollisions as Array<{ barcode: string }>).map((c) => c.barcode),
			sample
		};

		const sheetsBefore = (await BarcodeInventory.findById('default').lean() as
			| { avery94102SheetsOnHand?: number }
			| null)?.avery94102SheetsOnHand ?? 0;
		const sheetsAfter = Math.max(0, sheetsBefore - sheetsToPrint);

		const batchId = generateId();
		const printedAt = new Date();
		const user = locals.user!;

		await BarcodeSheetBatch.create({
			_id: batchId,
			sheetsUsed: sheetsToPrint,
			labelsPerSheet: LABELS_PER_SHEET,
			totalLabels,
			barcodeIds: barcodes,
			firstBarcodeId: barcodes[0],
			lastBarcodeId: barcodes[barcodes.length - 1],
			printedAt,
			printedBy: { _id: user._id, username: user.username },
			printerName: 'browser-avery-94102',
			templateVersion: TEMPLATE_VERSION,
			sheetsRemainingBefore: sheetsBefore,
			sheetsRemainingAfter: sheetsAfter,
			status: 'printed',
			labelsUsed: totalLabels
		});

		await BarcodeInventory.findByIdAndUpdate(
			'default',
			{ $set: { avery94102SheetsOnHand: sheetsAfter } },
			{ upsert: true }
		);

		await AuditLog.create({
			_id: generateId(),
			tableName: 'barcode_sheet_batches',
			recordId: batchId,
			action: 'INSERT',
			newData: {
				sheetsToPrint,
				count,
				skip,
				totalLabels,
				firstBarcodeId: barcodes[0],
				lastBarcodeId: barcodes[barcodes.length - 1],
				templateVersion: TEMPLATE_VERSION
			},
			changedAt: printedAt,
			changedBy: user.username
		});

		return {
			success: true,
			batchId,
			barcodes,
			skip,
			firstSheetCount: count,
			sheetsToPrint,
			printedAt: printedAt.toISOString(),
			sheetsRemainingAfter: sheetsAfter,
			spotCheck
		};
	}
};
