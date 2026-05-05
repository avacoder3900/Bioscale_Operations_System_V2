import { fail } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection';
import { AuditLog, BarcodeSheetBatch, BarcodeInventory, CartridgeRecord, PartDefinition } from '$lib/server/db/models';
import { generateId } from '$lib/server/db/utils';
import { requirePermission } from '$lib/server/permissions';
import { mintCartridgeBarcodes } from '$lib/server/services/barcode-generator';
import { recordTransaction } from '$lib/server/services/inventory-transaction';
import type { Actions, PageServerLoad } from './$types';

const TEMPLATE_VERSION = 'avery-94102-v1';
const LABELS_PER_SHEET = 80;

// Inventory wiring:
//   PT-CT-106 "Barcodes" is the single existing part with all the ROG /
//   accessioning / lot-tracking / cart-mfg-dev alert plumbing already
//   wired up. Both sides of the print operation hit it:
//     - input  (sheetsToPrint sheets fed in)  → consumption
//     - output (totalLabels printed labels)   → creation
//   Net change per print: +(totalLabels − sheetsToPrint), i.e. +79 per
//   full sheet — the sheet → 80 labels conversion expressed in a single
//   inventory line. WI-01 cartridge-back continues to consume 1 unit per
//   cartridge and its `if (have < quantity)` check is unaffected because
//   a confirmed print only ever increases PT-CT-106 inventory net.
const BARCODE_PART_NUMBER = 'PT-CT-106';

async function ensureBarcodePart(): Promise<{ _id: string; inventoryCount: number; partNumber: string; name: string }> {
	const existing = await PartDefinition.findOne({ partNumber: BARCODE_PART_NUMBER }).lean() as any;
	if (existing) return existing;
	// Defensive auto-upsert: PT-CT-106 should already exist (WI-01 reads
	// it as a consumed material), but if a fresh environment hasn't been
	// seeded, create it here so the print flow doesn't 500. Seed inventory
	// from the legacy BarcodeInventory.avery94102SheetsOnHand counter so
	// existing on-hand sheets aren't dropped on the floor.
	const inv = await BarcodeInventory.findById('default').lean() as { avery94102SheetsOnHand?: number } | null;
	const seedQty = inv?.avery94102SheetsOnHand ?? 0;
	const created = await PartDefinition.create({
		_id: generateId(),
		partNumber: BARCODE_PART_NUMBER,
		name: 'Barcodes',
		description: 'Avery 94102 barcode stickers — printed in-house and consumed 1-per-cartridge at WI-01 cartridge back',
		category: 'consumable',
		bomType: 'cartridge',
		unitOfMeasure: 'label',
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
	// Single-part accounting on PT-CT-106 "Barcodes": the sheet input is
	// recorded as `consumption` and the printed-label output as `creation`,
	// both against the same part. Net effect on inventoryCount per sheet is
	// +(LABELS_PER_SHEET − 1) so WI-01 cartridge-back's `if (have < quantity)`
	// availability check is never starved by a confirmed print. Uses the
	// shared recordTransaction helper (same path as WI-01, ROG, etc.) so
	// transaction rows + low-inventory notifications stay consistent.
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

		// Resolve PT-CT-106 (creates it on first run if a fresh env hasn't
		// been seeded) and snapshot current inventory levels.
		const barcodePart = await ensureBarcodePart();
		const partInvBefore = barcodePart.inventoryCount ?? 0;
		const inv = await BarcodeInventory.findById('default').lean() as
			| { avery94102SheetsOnHand?: number }
			| null;
		const sheetsBefore = inv?.avery94102SheetsOnHand ?? 0;
		const sheetsAfter = Math.max(0, sheetsBefore - sheetsToPrint);

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

		// Keep the legacy avery94102SheetsOnHand counter in step so the
		// cart-mfg-dev "Barcode sheets low" alert continues to fire.
		await BarcodeInventory.findByIdAndUpdate(
			'default',
			{ $set: { avery94102SheetsOnHand: sheetsAfter } },
			{ upsert: true }
		);

		// Two transactions on the same part — recordTransaction handles
		// previousQuantity/newQuantity walk + inventoryCount $set + low-
		// inventory notification, so this matches the path WI-01 and ROG
		// already use.
		await recordTransaction({
			transactionType: 'consumption',
			partDefinitionId: barcodePart._id,
			quantity: sheetsToPrint,
			manufacturingStep: 'backing',
			manufacturingRunId: batchId,
			operatorId: user._id,
			operatorUsername: user.username,
			notes: `Print barcode batch ${batchId}: ${sheetsToPrint} sheet${sheetsToPrint === 1 ? '' : 's'} consumed`
		});
		await recordTransaction({
			transactionType: 'creation',
			partDefinitionId: barcodePart._id,
			quantity: totalLabels,
			manufacturingStep: 'backing',
			manufacturingRunId: batchId,
			operatorId: user._id,
			operatorUsername: user.username,
			notes: `Print barcode batch ${batchId}: ${totalLabels} label${totalLabels === 1 ? '' : 's'} printed`
		});

		// Read back the post-update inventory for the audit log.
		const partAfterDoc = await PartDefinition.findById(barcodePart._id).select('inventoryCount').lean() as
			| { inventoryCount?: number }
			| null;
		const partInvAfter = partAfterDoc?.inventoryCount ?? partInvBefore - sheetsToPrint + totalLabels;

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
				partNumber: barcodePart.partNumber,
				partInventoryBefore: partInvBefore,
				partInventoryAfter: partInvAfter,
				sheetsOnHandBefore: sheetsBefore,
				sheetsOnHandAfter: sheetsAfter
			},
			changedAt: printedAt,
			changedBy: user.username
		});

		return {
			added: true,
			batchId,
			sheetsRemainingAfter: sheetsAfter,
			labelsAfter: partInvAfter,
			totalLabels
		};
	}
};
