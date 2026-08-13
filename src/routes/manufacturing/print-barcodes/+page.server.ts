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

// How long a minted preview stays claimable. UUID v4 collisions are not the
// risk here — the risk is a browser tab left open on an already-printed
// preview, which an operator can re-print (Ctrl+P) to produce a second
// physical sheet carrying UUIDs identical to a sheet already in inventory.
// Bounding the window bounds that exposure. The client shows a countdown and
// auto-re-mints while unprinted, but THIS constant is the real gate: the
// browser timer can be frozen by laptop sleep or edited in devtools, so
// ?/addToInventory refuses any claim past expiresAt regardless.
// (Surfaced to the client via load(); SvelteKit rejects unknown exports here.)
const PREVIEW_TTL_MS = 5 * 60 * 1000;

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

	// Lazy sweep: retire reservations whose window closed. Their barcodeIds
	// stay in the collection on purpose — mintCartridgeBarcodes scans this
	// field, so an abandoned reservation's UUIDs are burned permanently and
	// can never be re-issued to a future print.
	await BarcodeSheetBatch.updateMany(
		{ status: 'reserved', expiresAt: { $lte: new Date() } },
		{ $set: { status: 'expired' } }
	);

	// Only committed batches belong in the operator-facing history; reserved
	// and expired rows are bookkeeping, and have no printedAt to sort on.
	const recent = await BarcodeSheetBatch.find({
		status: { $nin: ['reserved', 'expired'] }
	})
		.select('firstBarcodeId lastBarcodeId totalLabels sheetsUsed printedAt printedBy')
		.sort({ printedAt: -1 })
		.limit(10)
		.lean();

	return {
		sheetsOnHand: inventory?.avery94102SheetsOnHand ?? 0,
		alertThreshold: inventory?.alertThreshold ?? 5,
		labelsPerSheet: LABELS_PER_SHEET,
		previewTtlMs: PREVIEW_TTL_MS,
		recent: JSON.parse(JSON.stringify(recent))
	};
};

export const actions: Actions = {
	// Generate UUIDs and a preview, and persist them as a `reserved`
	// BarcodeSheetBatch. Inventory is still NOT touched here — sheet
	// deduction and the PT-CT-106 transactions happen only when the operator
	// confirms "Add to inventory" after printing (?/addToInventory below).
	//
	// The reservation exists for two reasons:
	//   1. It timestamps the mint server-side, so preview staleness can be
	//      enforced somewhere the browser can't lie about.
	//   2. It makes minted-but-abandoned UUIDs visible. Previously a
	//      cancelled print discarded them silently, which meant labels that
	//      physically came out of the printer had no record anywhere. Now
	//      every minted UUID is burned in barcodeIds forever, so
	//      mintCartridgeBarcodes can never re-issue one.
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

		// Reserve the batch. Written before the UUIDs reach the browser so
		// there is no window where a printed label exists without a record.
		const mintedAt = new Date();
		const expiresAt = new Date(mintedAt.getTime() + PREVIEW_TTL_MS);
		const batchId = generateId();
		await BarcodeSheetBatch.create({
			_id: batchId,
			status: 'reserved',
			mintedAt,
			expiresAt,
			sheetsUsed: sheetsToPrint,
			labelsPerSheet: LABELS_PER_SHEET,
			totalLabels,
			barcodeIds: barcodes,
			firstBarcodeId: barcodes[0],
			lastBarcodeId: barcodes[barcodes.length - 1],
			printerName: 'browser-avery-94102',
			templateVersion: TEMPLATE_VERSION
		});

		return {
			success: true,
			batchId,
			barcodes,
			skip,
			firstSheetCount: count,
			sheetsToPrint,
			totalLabels,
			// Epoch ms so the client can run a countdown without timezone or
			// clock-format parsing games.
			expiresAtMs: expiresAt.getTime(),
			previewTtlMs: PREVIEW_TTL_MS,
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
		const batchId = (data.get('batchId') as string | null)?.trim() ?? '';

		if (!Number.isInteger(sheetsToPrint) || sheetsToPrint < 1) {
			return fail(400, { addError: 'Invalid sheetsToPrint' });
		}
		if (!batchId) {
			// Pre-TTL page left open across the deploy, or a hand-rolled POST.
			return fail(400, {
				addError: 'This preview predates the reservation system. Re-generate the barcodes and print again.'
			});
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
		// `_id: { $ne: batchId }` is load-bearing: this batch's own reservation
		// row now lives in this collection and holds exactly these barcodeIds,
		// so without the exclusion every confirm would collide with itself.
		const priorBatchCollisions = await BarcodeSheetBatch.find({
			_id: { $ne: batchId },
			barcodeIds: { $in: barcodes }
		}).select('_id').lean();
		if (priorBatchCollisions.length > 0) {
			return fail(409, { addError: 'Barcodes were already added to inventory in another batch' });
		}

		const printedAt = new Date();
		const user = locals.user!;

		// Resolve PT-CT-106 (creates it on first run if a fresh env hasn't
		// been seeded) and snapshot current inventory levels.
		const barcodePart = await ensureBarcodePart();
		const partInvBefore = barcodePart.inventoryCount ?? 0;
		const inv = await BarcodeInventory.findById('default').lean() as
			| { avery94102SheetsOnHand?: number }
			| null;
		const sheetsBefore = inv?.avery94102SheetsOnHand ?? 0;
		const sheetsAfter = Math.max(0, sheetsBefore - sheetsToPrint);

		// Atomically claim the reservation. The filter is the whole safety
		// property: a single findOneAndUpdate that matches only a still-open
		// `reserved` row means a stale tab, a double-submit, a replayed POST
		// and a second browser window all lose the race and get a clean 409 —
		// none of them can reach the inventory writes below. Do NOT split this
		// into a read-then-write; the gap is the bug.
		const claimed = await BarcodeSheetBatch.findOneAndUpdate(
			{ _id: batchId, status: 'reserved', expiresAt: { $gt: new Date() } },
			{
				$set: {
					status: 'printed',
					printedAt,
					printedBy: { _id: user._id, username: user.username },
					sheetsRemainingBefore: sheetsBefore,
					sheetsRemainingAfter: sheetsAfter,
					labelsUsed: 0
				}
			},
			{ new: true }
		).lean();

		if (!claimed) {
			// Losing the race is expected operator behaviour, not an error
			// state — say which case it was so the UI can tell the operator
			// whether their physical labels are already accounted for.
			const existing = await BarcodeSheetBatch.findById(batchId)
				.select('status expiresAt')
				.lean() as { status?: string; expiresAt?: Date } | null;

			if (!existing) {
				return fail(409, {
					addError: 'This print batch no longer exists. Re-generate the barcodes and print again.'
				});
			}
			if (existing.status === 'reserved' || existing.status === 'expired') {
				return fail(409, {
					addError:
						'This preview sat open too long and expired, so it can no longer be added to inventory. ' +
						'Discard the printed sheet — its labels were never recorded and must not be used — then generate and print a fresh batch.',
					addExpired: true
				});
			}
			return fail(409, {
				addError: 'These barcodes were already added to inventory. No second batch was created.'
			});
		}

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
