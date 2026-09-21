/**
 * Cartridge barcode print batches — the reserve → confirm lifecycle shared by
 * every physical print surface (Avery 94102 sheets on an office printer,
 * Zebra ZT230 roll labels via Browser Print, and any future bridge/queue).
 *
 * Extracted from routes/manufacturing/print-barcodes/+page.server.ts so the
 * safety properties live in exactly one place:
 *
 *   1. UUIDs are minted AND persisted as a `reserved` BarcodeSheetBatch
 *      before they ever reach the browser, so a label that physically comes
 *      out of a printer always has a record — and mintCartridgeBarcodes can
 *      never re-issue it (it scans barcodeIds with no status filter).
 *   2. A reservation may be confirmed exactly once, and only before
 *      expiresAt, via a single atomic findOneAndUpdate. Stale tabs, double
 *      submits, replayed POSTs and second windows all lose that race and get
 *      a clean, distinguishable 409 — none can reach the inventory writes.
 *
 * Inventory semantics differ by medium and are expressed via `medium`:
 *   - 'avery-sheet': N sheets of PT-CT-106 consumed, totalLabels created,
 *     legacy BarcodeInventory.avery94102SheetsOnHand mirrored (cart-mfg-dev
 *     "sheets low" alert reads it).
 *   - 'zebra-roll': labels come off a continuous roll; no sheet consumption
 *     and no avery counter mirror. Only the `creation` of totalLabels on
 *     PT-CT-106 is recorded, because that is the part WI-01 cartridge-back
 *     consumes 1-per-cartridge regardless of how the label was printed.
 */
import { AuditLog, BarcodeSheetBatch, BarcodeInventory, CartridgeRecord, PartDefinition, ReceivingLot } from '$lib/server/db/models';
import { generateId } from '$lib/server/db/utils';
import { mintCartridgeBarcodes } from '$lib/server/services/barcode-generator';
import { recordTransaction } from '$lib/server/services/inventory-transaction';

export type PrintMedium = 'avery-sheet' | 'zebra-roll';

// How long a minted preview stays claimable. UUID v4 collisions are not the
// risk here — the risk is a browser tab left open on an already-printed
// preview, which an operator can re-print to produce a second physical set
// carrying UUIDs identical to labels already in inventory. Bounding the window
// bounds that exposure. Clients show a countdown, but THIS is the real gate:
// the browser timer can be frozen by laptop sleep or edited in devtools, so
// confirmBatch refuses any claim past expiresAt regardless.
export const PREVIEW_TTL_MS = 5 * 60 * 1000;

// PT-CT-106 "Barcodes" is the single existing part with all the ROG /
// accessioning / lot-tracking / cart-mfg-dev alert plumbing already wired up,
// and the part WI-01 cartridge-back consumes 1 unit per cartridge.
export const BARCODE_PART_NUMBER = 'PT-CT-106';

export async function ensureBarcodePart(): Promise<{ _id: string; inventoryCount: number; partNumber: string; name: string }> {
	const existing = await PartDefinition.findOne({ partNumber: BARCODE_PART_NUMBER }).lean() as any;
	if (existing) return existing;
	// Defensive auto-upsert: PT-CT-106 should already exist (WI-01 reads it as
	// a consumed material), but if a fresh environment hasn't been seeded,
	// create it here so the print flow doesn't 500. Seed inventory from the
	// legacy BarcodeInventory.avery94102SheetsOnHand counter so existing
	// on-hand sheets aren't dropped on the floor.
	const inv = await BarcodeInventory.findById('default').lean() as { avery94102SheetsOnHand?: number } | null;
	const seedQty = inv?.avery94102SheetsOnHand ?? 0;
	const created = await PartDefinition.create({
		_id: generateId(),
		partNumber: BARCODE_PART_NUMBER,
		name: 'Barcodes',
		description: 'Cartridge barcode stickers — printed in-house and consumed 1-per-cartridge at WI-01 cartridge back',
		category: 'consumable',
		bomType: 'cartridge',
		unitOfMeasure: 'label',
		inventoryCount: seedQty,
		isActive: true
	});
	return created.toObject();
}

/** Lazy sweep: retire reservations whose window closed. Their barcodeIds stay
 *  in the collection on purpose (burned forever). Call from load(). */
export async function expireStaleReservations(): Promise<void> {
	await BarcodeSheetBatch.updateMany(
		{ status: 'reserved', expiresAt: { $lte: new Date() } },
		{ $set: { status: 'expired' } }
	);
}

export interface ReserveInput {
	totalLabels: number;
	/** Physical sheets consumed (Avery) — 0 for roll media. */
	sheetsUsed: number;
	labelsPerSheet: number;
	printerName: string;
	templateVersion: string;
	ttlMs?: number;
}

export interface ReserveResult {
	batchId: string;
	barcodes: string[];
	mintedAt: Date;
	expiresAt: Date;
	spotCheck: { sampleSize: number; collisions: string[]; sample: string[] };
}

/**
 * Mint `totalLabels` UUIDs and persist them as a `reserved` batch. Throws on
 * mint failure (caller maps to a 409). Inventory is NOT touched here.
 */
export async function reserveBatch(input: ReserveInput): Promise<ReserveResult> {
	const barcodes = await mintCartridgeBarcodes(input.totalLabels);

	// Visible spot-check: sample 5 random barcodes and query cartridge_records
	// for matches. mintCartridgeBarcodes already ran an exhaustive check, so
	// this is belt-and-suspenders that surfaces a separate visible line in the UI.
	const sampleSize = Math.min(5, barcodes.length);
	const shuffled = [...barcodes].sort(() => Math.random() - 0.5);
	const sample = shuffled.slice(0, sampleSize);
	const sampleCollisions = await CartridgeRecord.find({ _id: { $in: sample } }).select('_id').lean();
	const spotCheck = {
		sampleSize,
		collisions: (sampleCollisions as Array<{ _id: string }>).map((c) => c._id),
		sample
	};

	const mintedAt = new Date();
	const expiresAt = new Date(mintedAt.getTime() + (input.ttlMs ?? PREVIEW_TTL_MS));
	const batchId = generateId();
	await BarcodeSheetBatch.create({
		_id: batchId,
		status: 'reserved',
		mintedAt,
		expiresAt,
		sheetsUsed: input.sheetsUsed,
		labelsPerSheet: input.labelsPerSheet,
		totalLabels: input.totalLabels,
		barcodeIds: barcodes,
		firstBarcodeId: barcodes[0],
		lastBarcodeId: barcodes[barcodes.length - 1],
		printerName: input.printerName,
		templateVersion: input.templateVersion
	});

	return { batchId, barcodes, mintedAt, expiresAt, spotCheck };
}

export interface ConfirmInput {
	batchId: string;
	barcodes: string[];
	totalLabels: number;
	sheetsUsed: number;
	medium: PrintMedium;
	templateVersion: string;
	user: { _id: string; username: string };
	/** Overrides the printerName recorded at reserve time (e.g. the actual
	 *  Browser Print device the job went to). */
	printerName?: string;
	/** Extra fields merged into the AuditLog newData (skip/firstSheetCount…). */
	auditExtra?: Record<string, unknown>;
}

export type ConfirmResult =
	| { ok: true; batchId: string; sheetsRemainingAfter: number; labelsAfter: number; totalLabels: number }
	| { ok: false; status: 400 | 409; error: string; expired?: boolean };

/**
 * Operator confirmed the labels physically printed. Re-checks collisions,
 * atomically claims the reservation, then records inventory + audit.
 */
export async function confirmBatch(input: ConfirmInput): Promise<ConfirmResult> {
	const { batchId, barcodes, totalLabels, sheetsUsed, medium, user } = input;

	if (!batchId) {
		return {
			ok: false, status: 400,
			error: 'This preview predates the reservation system. Re-generate the barcodes and print again.'
		};
	}
	if (barcodes.length === 0 || barcodes.length !== totalLabels) {
		return { ok: false, status: 400, error: 'Missing or mismatched barcodes' };
	}
	if (medium === 'avery-sheet' && (!Number.isInteger(sheetsUsed) || sheetsUsed < 1)) {
		return { ok: false, status: 400, error: 'Invalid sheetsToPrint' };
	}

	// Re-check collisions at commit time. A concurrent print could have landed
	// the same UUIDs in between (vanishingly unlikely, but cheap to verify).
	const cartCollisions = await CartridgeRecord.find({ _id: { $in: barcodes } }).select('_id').lean();
	if (cartCollisions.length > 0) {
		const dupes = (cartCollisions as Array<{ _id: string }>).map((c) => c._id).join(', ');
		return { ok: false, status: 409, error: `Barcodes already used on cartridges: ${dupes}` };
	}
	// `_id: { $ne: batchId }` is load-bearing: this batch's own reservation row
	// holds exactly these barcodeIds, so without the exclusion every confirm
	// would collide with itself.
	const priorBatchCollisions = await BarcodeSheetBatch.find({
		_id: { $ne: batchId },
		barcodeIds: { $in: barcodes }
	}).select('_id').lean();
	if (priorBatchCollisions.length > 0) {
		return { ok: false, status: 409, error: 'Barcodes were already added to inventory in another batch' };
	}

	const printedAt = new Date();
	const barcodePart = await ensureBarcodePart();
	const partInvBefore = barcodePart.inventoryCount ?? 0;
	const inv = await BarcodeInventory.findById('default').lean() as { avery94102SheetsOnHand?: number } | null;
	const sheetsBefore = inv?.avery94102SheetsOnHand ?? 0;
	const sheetsAfter = medium === 'avery-sheet' ? Math.max(0, sheetsBefore - sheetsUsed) : sheetsBefore;

	// Atomically claim the reservation. The filter is the whole safety
	// property. Do NOT split this into a read-then-write; the gap is the bug.
	const claimed = await BarcodeSheetBatch.findOneAndUpdate(
		{ _id: batchId, status: 'reserved', expiresAt: { $gt: new Date() } },
		{
			$set: {
				status: 'printed',
				printedAt,
				printedBy: { _id: user._id, username: user.username },
				sheetsRemainingBefore: sheetsBefore,
				sheetsRemainingAfter: sheetsAfter,
				labelsUsed: 0,
				...(input.printerName ? { printerName: input.printerName } : {})
			}
		},
		{ new: true }
	).lean();

	if (!claimed) {
		// Losing the race is expected operator behaviour, not an error state —
		// say which case it was so the UI can tell the operator whether their
		// physical labels are already accounted for.
		const existing = await BarcodeSheetBatch.findById(batchId)
			.select('status expiresAt')
			.lean() as { status?: string; expiresAt?: Date } | null;
		if (!existing) {
			return { ok: false, status: 409, error: 'This print batch no longer exists. Re-generate the barcodes and print again.' };
		}
		if (existing.status === 'reserved' || existing.status === 'expired') {
			return {
				ok: false, status: 409, expired: true,
				error:
					'This preview sat open too long and expired, so it can no longer be added to inventory. ' +
					'Discard the printed labels — they were never recorded and must not be used — then generate and print a fresh batch.'
			};
		}
		return { ok: false, status: 409, error: 'These barcodes were already added to inventory. No second batch was created.' };
	}

	if (medium === 'avery-sheet') {
		// Keep the legacy avery94102SheetsOnHand counter in step so the
		// cart-mfg-dev "Barcode sheets low" alert continues to fire.
		await BarcodeInventory.findByIdAndUpdate(
			'default',
			{ $set: { avery94102SheetsOnHand: sheetsAfter } },
			{ upsert: true }
		);
		await recordTransaction({
			transactionType: 'consumption',
			partDefinitionId: barcodePart._id,
			quantity: sheetsUsed,
			manufacturingStep: 'backing',
			manufacturingRunId: batchId,
			operatorId: user._id,
			operatorUsername: user.username,
			notes: `Print barcode batch ${batchId}: ${sheetsUsed} sheet${sheetsUsed === 1 ? '' : 's'} consumed`
		});
	}
	await recordTransaction({
		transactionType: 'creation',
		partDefinitionId: barcodePart._id,
		quantity: totalLabels,
		manufacturingStep: 'backing',
		manufacturingRunId: batchId,
		operatorId: user._id,
		operatorUsername: user.username,
		notes: `Print barcode batch ${batchId}: ${totalLabels} label${totalLabels === 1 ? '' : 's'} printed` +
			(medium === 'zebra-roll' ? ' (Zebra roll)' : '')
	});

	// WI-01 cartridge backing selects/validates its Barcode input against a
	// ReceivingLot (validateLotForPart), but in-house printed labels never had
	// one — inventory counted them while the backing gate couldn't see them
	// (2026-08-25: Jacob's 2,304-label Zebra run had to be backfilled by hand).
	// Upsert a per-day in-house lot per medium; same-day batches accumulate
	// into it, so the WI-01 dropdown shows one lot per print day.
	const d = printedAt;
	const dayStamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
	const inHouseLotId = `${medium === 'zebra-roll' ? 'ZEBRA' : 'AVERY'}-${dayStamp}-PTCT106`;
	try {
		await ReceivingLot.findOneAndUpdate(
			{ lotId: inHouseLotId },
			{
				$inc: { quantity: totalLabels },
				$setOnInsert: {
					_id: generateId(),
					lotId: inHouseLotId,
					lotNumber: `LOT-${dayStamp}-${medium === 'zebra-roll' ? 'ZBRA' : 'AVRY'}`,
					part: { _id: barcodePart._id, partNumber: barcodePart.partNumber, name: 'Barcode' },
					operator: { _id: user._id, username: user.username },
					inspectionPathway: 'coc',
					status: 'accepted',
					dispositionType: 'accepted',
					notes: `In-house printed barcode labels (${medium}); quantity accumulates across the day's confirmed print batches. Auto-created so WI-01 cartridge backing can consume this lot.`,
					createdAt: printedAt
				},
				$set: { updatedAt: printedAt }
			},
			{ upsert: true }
		);
	} catch (e) {
		// The print batch is already committed and counted — a lot upsert
		// failure must not fail the confirm. Surface it in the log instead.
		console.error(`[barcode-print-batch] in-house ReceivingLot upsert failed for ${inHouseLotId}:`, e instanceof Error ? e.message : e);
	}

	const partAfterDoc = await PartDefinition.findById(barcodePart._id).select('inventoryCount').lean() as
		| { inventoryCount?: number }
		| null;
	const partInvAfter = partAfterDoc?.inventoryCount ??
		(partInvBefore - (medium === 'avery-sheet' ? sheetsUsed : 0) + totalLabels);

	await AuditLog.create({
		_id: generateId(),
		tableName: 'barcode_sheet_batches',
		recordId: batchId,
		action: 'INSERT',
		newData: {
			medium,
			sheetsToPrint: sheetsUsed,
			totalLabels,
			firstBarcodeId: barcodes[0],
			lastBarcodeId: barcodes[barcodes.length - 1],
			templateVersion: input.templateVersion,
			printerName: input.printerName ?? (claimed as any).printerName,
			partNumber: barcodePart.partNumber,
			partInventoryBefore: partInvBefore,
			partInventoryAfter: partInvAfter,
			sheetsOnHandBefore: sheetsBefore,
			sheetsOnHandAfter: sheetsAfter,
			...(input.auditExtra ?? {})
		},
		changedAt: printedAt,
		changedBy: user.username
	});

	return { ok: true, batchId, sheetsRemainingAfter: sheetsAfter, labelsAfter: partInvAfter, totalLabels };
}
