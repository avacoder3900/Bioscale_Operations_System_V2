import { fail } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection';
import { BarcodeSheetBatch, PartDefinition } from '$lib/server/db/models';
import { requirePermission } from '$lib/server/permissions';
import {
	BARCODE_PART_NUMBER,
	PREVIEW_TTL_MS,
	confirmBatch,
	expireStaleReservations,
	reserveBatch
} from '$lib/server/services/barcode-print-batch';
import { ZEBRA_TEMPLATE_VERSION, ZT230_2X_075_DEFAULTS } from '$lib/zebra/cartridge-label-zpl';
import type { Actions, PageServerLoad } from './$types';

// Zebra ZT230 roll surface (2-across ¾" labels, delivered to the printer by
// the operator's Browser Print agent — see $lib/zebra/browser-print.ts).
//
// Same UUID minting, same BarcodeSheetBatch reserve → confirm lifecycle, same
// PT-CT-106 label accounting and audit as the Avery sheet page; the only
// differences are (a) no sheet consumption — labels come off a roll — and
// (b) the ZPL is generated client-side from the minted list and pushed to the
// local agent instead of window.print().
const MAX_LABELS_PER_JOB = 400;
const COLUMNS = ZT230_2X_075_DEFAULTS.columns;

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	await expireStaleReservations();

	const [recent, part] = await Promise.all([
		BarcodeSheetBatch.find({
			status: { $nin: ['reserved', 'expired'] },
			templateVersion: { $regex: /^zebra-/ }
		})
			.select('firstBarcodeId lastBarcodeId totalLabels printedAt printedBy printerName')
			.sort({ printedAt: -1 })
			.limit(10)
			.lean(),
		PartDefinition.findOne({ partNumber: BARCODE_PART_NUMBER }).select('inventoryCount').lean() as Promise<{ inventoryCount?: number } | null>
	]);

	return {
		labelsOnHand: part?.inventoryCount ?? 0,
		previewTtlMs: PREVIEW_TTL_MS,
		maxLabelsPerJob: MAX_LABELS_PER_JOB,
		columns: COLUMNS,
		recent: JSON.parse(JSON.stringify(recent))
	};
};

export const actions: Actions = {
	// Mint + reserve. Nothing is sent to the printer here — the client builds
	// the ZPL from the returned list and pushes it to Browser Print, then
	// confirms via ?/confirm once the operator has the labels in hand.
	mint: async ({ request, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const count = Number(data.get('count') ?? COLUMNS);
		const printerName = ((data.get('printerName') as string | null) ?? '').trim().slice(0, 120) || 'zebra-browser-print';

		if (!Number.isInteger(count) || count < 1 || count > MAX_LABELS_PER_JOB) {
			return fail(400, { error: `Label count must be 1–${MAX_LABELS_PER_JOB}` });
		}

		let reserved;
		try {
			reserved = await reserveBatch({
				totalLabels: count,
				sheetsUsed: 0,
				labelsPerSheet: COLUMNS,
				printerName,
				templateVersion: ZEBRA_TEMPLATE_VERSION
			});
		} catch (e) {
			return fail(409, { error: e instanceof Error ? e.message : 'Mint failed' });
		}

		return {
			success: true,
			batchId: reserved.batchId,
			barcodes: reserved.barcodes,
			totalLabels: count,
			expiresAtMs: reserved.expiresAt.getTime(),
			previewTtlMs: PREVIEW_TTL_MS,
			spotCheck: reserved.spotCheck
		};
	},

	// Operator confirmed the labels physically printed.
	confirm: async ({ request, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const totalLabels = Number(data.get('totalLabels') ?? 0);
		const barcodes = ((data.get('barcodes') as string | null) ?? '').trim().split(',').filter(Boolean);
		const batchId = ((data.get('batchId') as string | null) ?? '').trim();
		const printerName = ((data.get('printerName') as string | null) ?? '').trim().slice(0, 120) || undefined;
		const printerUid = ((data.get('printerUid') as string | null) ?? '').trim().slice(0, 120) || undefined;
		const calibration = ((data.get('calibration') as string | null) ?? '').trim().slice(0, 2000) || undefined;

		const result = await confirmBatch({
			batchId,
			barcodes,
			totalLabels,
			sheetsUsed: 0,
			medium: 'zebra-roll',
			templateVersion: ZEBRA_TEMPLATE_VERSION,
			printerName,
			user: { _id: locals.user!._id, username: locals.user!.username },
			auditExtra: { printerUid, calibration }
		});

		if (!result.ok) {
			return fail(result.status, { addError: result.error, ...(result.expired ? { addExpired: true } : {}) });
		}
		return {
			added: true,
			batchId: result.batchId,
			labelsAfter: result.labelsAfter,
			totalLabels: result.totalLabels
		};
	}
};
