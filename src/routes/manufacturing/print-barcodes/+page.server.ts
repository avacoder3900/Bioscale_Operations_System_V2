import { fail } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection';
import { BarcodeSheetBatch, BarcodeInventory } from '$lib/server/db/models';
import { requirePermission } from '$lib/server/permissions';
import {
	PREVIEW_TTL_MS,
	confirmBatch,
	expireStaleReservations,
	reserveBatch
} from '$lib/server/services/barcode-print-batch';
import type { Actions, PageServerLoad } from './$types';

// Avery 94102 sheet surface. The reserve → confirm lifecycle, inventory
// wiring (PT-CT-106) and expiry safety live in
// $lib/server/services/barcode-print-batch.ts — shared with the Zebra ZT230
// surface at ./zebra. This file only owns sheet-specific validation and the
// response shapes the Avery page renders.
const TEMPLATE_VERSION = 'avery-94102-v1';
const LABELS_PER_SHEET = 80;

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const inventory = await BarcodeInventory.findById('default').lean() as
		| { avery94102SheetsOnHand?: number; alertThreshold?: number }
		| null;

	await expireStaleReservations();

	// Only committed batches belong in the operator-facing history; reserved
	// and expired rows are bookkeeping, and have no printedAt to sort on.
	const recent = await BarcodeSheetBatch.find({
		status: { $nin: ['reserved', 'expired'] }
	})
		.select('firstBarcodeId lastBarcodeId totalLabels sheetsUsed printedAt printedBy printerName')
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
	// BarcodeSheetBatch. Inventory is NOT touched here — sheet deduction and
	// the PT-CT-106 transactions happen only when the operator confirms
	// "Add to inventory" after printing (?/addToInventory below).
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

		let reserved;
		try {
			reserved = await reserveBatch({
				totalLabels,
				sheetsUsed: sheetsToPrint,
				labelsPerSheet: LABELS_PER_SHEET,
				printerName: 'browser-avery-94102',
				templateVersion: TEMPLATE_VERSION
			});
		} catch (e) {
			return fail(409, { error: e instanceof Error ? e.message : 'Mint failed' });
		}

		const sheetsBefore = (await BarcodeInventory.findById('default').lean() as
			| { avery94102SheetsOnHand?: number }
			| null)?.avery94102SheetsOnHand ?? 0;
		const sheetsAfter = Math.max(0, sheetsBefore - sheetsToPrint);

		return {
			success: true,
			batchId: reserved.batchId,
			barcodes: reserved.barcodes,
			skip,
			firstSheetCount: count,
			sheetsToPrint,
			totalLabels,
			// Epoch ms so the client can run a countdown without timezone or
			// clock-format parsing games.
			expiresAtMs: reserved.expiresAt.getTime(),
			previewTtlMs: PREVIEW_TTL_MS,
			// Display only — actual deduction happens on confirm.
			sheetsRemainingAfter: sheetsAfter,
			spotCheck: reserved.spotCheck
		};
	},

	// Operator confirmed "Add to inventory" after the print dialog closed.
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

		const result = await confirmBatch({
			batchId,
			barcodes,
			totalLabels,
			sheetsUsed: sheetsToPrint,
			medium: 'avery-sheet',
			templateVersion: TEMPLATE_VERSION,
			user: { _id: locals.user!._id, username: locals.user!.username },
			auditExtra: { skip, firstSheetCount }
		});

		if (!result.ok) {
			return fail(result.status, { addError: result.error, ...(result.expired ? { addExpired: true } : {}) });
		}

		return {
			added: true,
			batchId: result.batchId,
			sheetsRemainingAfter: result.sheetsRemainingAfter,
			labelsAfter: result.labelsAfter,
			totalLabels: result.totalLabels
		};
	}
};
