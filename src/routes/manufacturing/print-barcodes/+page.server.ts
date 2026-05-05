import { fail } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection';
import { AuditLog, BarcodeSheetBatch, BarcodeInventory, CartridgeRecord, PartDefinition, InventoryTransaction } from '$lib/server/db/models';
import { generateId } from '$lib/server/db/utils';
import { requirePermission } from '$lib/server/permissions';
import { mintCartridgeBarcodes } from '$lib/server/services/barcode-generator';
import type { Actions, PageServerLoad } from './$types';

const TEMPLATE_VERSION = 'avery-94102-v1';
const LABELS_PER_SHEET = 80;

// Inventory part numbers wired to the print flow:
//   - TEMPLATE_SHEET_PART_NUMBER: blank Avery 94102 sheets the operator
//     loads into the printer. One sheet is consumed per page printed.
//     Auto-upserted on first "Add to inventory" so the part exists in
//     the catalog without a manual seed step. Mirrors
//     BarcodeInventory.avery94102SheetsOnHand (kept in sync below) so
//     the cart-mfg-dev dashboard's existing readers don't break.
//   - PRINTED_BARCODE_PART_NUMBER: the printed barcode label (1 per
//     cartridge), already wired into WI-01 cartridge-back as a consumed
//     material. Each printed label increments this part's inventory.
const TEMPLATE_SHEET_PART_NUMBER = 'PT-CT-115';
const PRINTED_BARCODE_PART_NUMBER = 'PT-CT-106';

async function ensureTemplateSheetPart(): Promise<{ _id: string; inventoryCount: number }> {
	const existing = await PartDefinition.findOne({ partNumber: TEMPLATE_SHEET_PART_NUMBER }).lean() as any;
	if (existing) return existing;
	const inv = await BarcodeInventory.findById('default').lean() as { avery94102SheetsOnHand?: number } | null;
	const seedQty = inv?.avery94102SheetsOnHand ?? 0;
	const created = await PartDefinition.create({
		_id: generateId(),
		partNumber: TEMPLATE_SHEET_PART_NUMBER,
		name: 'Barcode Template Sheets',
		description: 'Avery 94102 blank sticker sheets (80 labels/sheet) used to print cartridge barcodes',
		category: 'consumable',
		bomType: 'cartridge',
		unitOfMeasure: 'sheet',
		inventoryCount: seedQty,
		isActive: true
	});
	return created.toObject();
}

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
	// Generate UUIDs and a preview. Intentionally does NOT persist a
	// BarcodeSheetBatch or decrement template sheets — those happen only
	// when the operator confirms "Add to inventory" after printing
	// (?/addToInventory below). If they cancel the print or click "No",
	// the minted UUIDs are simply discarded; UUID v4 has 122 bits of
	// entropy, so the small "wasted" allocation is harmless.
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
		const sampleCollisions = await CartridgeRecord.find({ _id: { $in: sample } })
			.select('_id')
			.lean();
		const spotCheck = {
			sampleSize,
			collisions: (sampleCollisions as Array<{ _id: string }>).map((c) => c._id),
			sample
		};

		const sheetsBefore = (await BarcodeInventory.findById('default').lean() as
			| { avery94102SheetsOnHand?: number }
			| null)?.avery94102SheetsOnHand ?? 0;
		const sheetsAfter = Math.max(0, sheetsBefore - sheetsToPrint);

		return {
			success: true,
			barcodes,
			skip,
			firstSheetCount: count,
			sheetsToPrint,
			totalLabels,
			// Display only — actual deduction happens on confirm.
			sheetsRemainingAfter: sheetsAfter,
			spotCheck
		};
	},

	// Operator confirmed "Add to inventory" after the print dialog closed.
	// Persists the BarcodeSheetBatch, decrements blank sheets (PT-CT-115 +
	// BarcodeInventory mirror), and increments printed-label stock
	// (PT-CT-106) — the part WI-01 cartridge-back consumes. Each step
	// gets an InventoryTransaction for the audit trail.
	addToInventory: async ({ request, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const sheetsToPrint = Number(data.get('sheetsToPrint') ?? 0);
		const totalLabels = Number(data.get('totalLabels') ?? 0);
		const skip = Number(data.get('skip') ?? 0);
		const firstSheetCount = Number(data.get('firstSheetCount') ?? 0);
		const barcodesStr = (data.get('barcodes') as string | null)?.trim() ?? '';
		const barcodes = barcodesStr.split(',').filter(Boolean);

		if (!Number.isInteger(sheetsToPrint) || sheetsToPrint < 1) {
			return fail(400, { addError: 'Invalid sheetsToPrint' });
		}
		if (barcodes.length === 0 || barcodes.length !== totalLabels) {
			return fail(400, { addError: 'Missing or mismatched barcodes' });
		}

		// Re-check collisions at commit time. mintCartridgeBarcodes ran the
		// same checks at preview, but a concurrent print could have landed
		// the same UUIDs in between (vanishingly unlikely with 122-bit
		// entropy, but cheap to verify).
		const cartCollisions = await CartridgeRecord.find({ _id: { $in: barcodes } }).select('_id').lean();
		if (cartCollisions.length > 0) {
			const dupes = (cartCollisions as Array<{ _id: string }>).map((c) => c._id).join(', ');
			return fail(409, { addError: `Barcodes already used on cartridges: ${dupes}` });
		}
		const priorBatchCollisions = await BarcodeSheetBatch.find({ barcodeIds: { $in: barcodes } }).select('_id').lean();
		if (priorBatchCollisions.length > 0) {
			return fail(409, { addError: 'Barcodes were already added to inventory in another batch' });
		}

		const printedAt = new Date();
		const user = locals.user!;
		const batchId = generateId();

		// Read current inventory levels (for transaction record + audit)
		const templatePart = await ensureTemplateSheetPart();
		const printedPart = await PartDefinition.findOne({ partNumber: PRINTED_BARCODE_PART_NUMBER }).lean() as
			| { _id: string; inventoryCount?: number }
			| null;

		const inv = await BarcodeInventory.findById('default').lean() as
			| { avery94102SheetsOnHand?: number }
			| null;
		const sheetsBefore = inv?.avery94102SheetsOnHand ?? templatePart.inventoryCount ?? 0;
		const sheetsAfter = Math.max(0, sheetsBefore - sheetsToPrint);
		const templateBefore = templatePart.inventoryCount ?? sheetsBefore;
		const templateAfter = Math.max(0, templateBefore - sheetsToPrint);
		const labelsBefore = printedPart?.inventoryCount ?? 0;
		const labelsAfter = labelsBefore + totalLabels;

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
			labelsUsed: 0
		});

		// Decrement blank-sheet stock — both the BarcodeInventory mirror
		// (still read by cart-mfg-dev) and the PT-CT-115 part definition.
		await BarcodeInventory.findByIdAndUpdate(
			'default',
			{ $set: { avery94102SheetsOnHand: sheetsAfter } },
			{ upsert: true }
		);
		await PartDefinition.findByIdAndUpdate(
			templatePart._id,
			{ $set: { inventoryCount: templateAfter } }
		);

		// Increment printed-label stock (PT-CT-106) so WI-01 cartridge-back
		// has labels to consume. Skip silently if the part isn't in the
		// catalog (unusual — it's a core BOM part — but we don't want to
		// brick the print flow over it).
		if (printedPart) {
			await PartDefinition.findByIdAndUpdate(
				printedPart._id,
				{ $set: { inventoryCount: labelsAfter } }
			);
		}

		// InventoryTransactions for the paper trail
		const baseTx = {
			performedBy: user._id,
			performedAt: printedAt,
			operatorId: user._id,
			operatorUsername: user.username,
			manufacturingStep: 'backing' as const
		};
		await InventoryTransaction.create({
			_id: generateId(),
			partDefinitionId: templatePart._id,
			transactionType: 'consumption',
			quantity: -sheetsToPrint,
			previousQuantity: templateBefore,
			newQuantity: templateAfter,
			reason: `Printed barcode batch ${batchId} (${sheetsToPrint} sheet${sheetsToPrint === 1 ? '' : 's'})`,
			...baseTx
		});
		if (printedPart) {
			await InventoryTransaction.create({
				_id: generateId(),
				partDefinitionId: printedPart._id,
				transactionType: 'creation',
				quantity: totalLabels,
				previousQuantity: labelsBefore,
				newQuantity: labelsAfter,
				reason: `Printed barcode batch ${batchId} (${totalLabels} label${totalLabels === 1 ? '' : 's'})`,
				...baseTx
			});
		}

		await AuditLog.create({
			_id: generateId(),
			tableName: 'barcode_sheet_batches',
			recordId: batchId,
			action: 'INSERT',
			newData: {
				sheetsToPrint,
				totalLabels,
				skip,
				firstSheetCount,
				firstBarcodeId: barcodes[0],
				lastBarcodeId: barcodes[barcodes.length - 1],
				templateVersion: TEMPLATE_VERSION,
				templateSheetsBefore: templateBefore,
				templateSheetsAfter: templateAfter,
				printedLabelsBefore: labelsBefore,
				printedLabelsAfter: labelsAfter
			},
			changedAt: printedAt,
			changedBy: user.username
		});

		return {
			added: true,
			batchId,
			sheetsRemainingAfter: sheetsAfter,
			labelsAfter,
			totalLabels
		};
	}
};
