import { redirect, fail } from '@sveltejs/kit';
import {
	connectDB, BarcodeSheetBatch, BarcodeInventory, CartridgeRecord,
	AuditLog, generateId
} from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { nanoid } from 'nanoid';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const [inventory, recentBatches, allBatchBarcodeIds] = await Promise.all([
		BarcodeInventory.findById('default').lean(),
		BarcodeSheetBatch.find().sort({ printedAt: -1 }).limit(20).lean(),
		BarcodeSheetBatch.aggregate([
			{ $unwind: '$barcodeIds' },
			{ $group: { _id: null, ids: { $addToSet: '$barcodeIds' } } }
		])
	]);

	// Compute orphaned barcodes count
	let orphanedCount = 0;
	const allIds = allBatchBarcodeIds[0]?.ids ?? [];
	if (allIds.length > 0) {
		const usedCount = await CartridgeRecord.countDocuments({
			_id: { $in: allIds }
		});
		orphanedCount = allIds.length - usedCount;
	}

	const inv = inventory as any;

	return JSON.parse(JSON.stringify({
		inventory: {
			sheetsOnHand: inv?.avery94102SheetsOnHand ?? 0,
			alertThreshold: inv?.alertThreshold ?? 5,
			lastCountedAt: inv?.lastCountedAt ?? null,
			lastCountedBy: inv?.lastCountedBy?.username ?? null,
			labelsAvailable: (inv?.avery94102SheetsOnHand ?? 0) * 30
		},
		recentBatches: (recentBatches as any[]).map((b: any) => ({
			_id: b._id,
			printedAt: b.printedAt,
			printedBy: b.printedBy?.username ?? 'Unknown',
			sheetsUsed: b.sheetsUsed,
			totalLabels: b.totalLabels,
			labelsUsed: b.labelsUsed ?? 0,
			status: b.status
		})),
		orphanedCount
	}));
};

export const actions: Actions = {
	updateInventoryCount: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const sheetsOnHand = parseInt(data.get('sheetsOnHand')?.toString() ?? '', 10);
		if (isNaN(sheetsOnHand) || sheetsOnHand < 0) {
			return fail(400, { error: 'Valid sheets count is required' });
		}

		const alertThreshold = parseInt(data.get('alertThreshold')?.toString() ?? '5', 10);

		await BarcodeInventory.findByIdAndUpdate('default', {
			$set: {
				avery94102SheetsOnHand: sheetsOnHand,
				alertThreshold: isNaN(alertThreshold) ? 5 : alertThreshold,
				lastCountedAt: new Date(),
				lastCountedBy: { _id: locals.user._id, username: locals.user.username }
			}
		}, { upsert: true });

		await AuditLog.create({
			_id: generateId(),
			tableName: 'barcode_inventory',
			recordId: 'default',
			action: 'UPDATE',
			changedBy: locals.user.username,
			changedAt: new Date(),
			newData: { sheetsOnHand, alertThreshold },
			reason: 'Manual inventory count update'
		});

		return { success: true };
	},

	printBatch: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const sheetsUsed = parseInt(data.get('sheetsUsed')?.toString() ?? '', 10);
		if (isNaN(sheetsUsed) || sheetsUsed < 1) {
			return fail(400, { error: 'Sheets to print must be at least 1' });
		}

		const printerName = data.get('printerName')?.toString() || undefined;
		const notes = data.get('notes')?.toString() || undefined;
		const labelsPerSheet = 30;
		const totalLabels = sheetsUsed * labelsPerSheet;

		// Get current inventory
		const inv = await BarcodeInventory.findById('default').lean() as any;
		const sheetsRemainingBefore = inv?.avery94102SheetsOnHand ?? 0;

		if (sheetsUsed > sheetsRemainingBefore) {
			return fail(400, { error: `Not enough sheets. Have ${sheetsRemainingBefore}, requested ${sheetsUsed}` });
		}

		// Generate barcode IDs
		const barcodeIds: string[] = [];
		for (let i = 0; i < totalLabels; i++) {
			barcodeIds.push(nanoid());
		}

		const batchId = generateId();
		const sheetsRemainingAfter = sheetsRemainingBefore - sheetsUsed;

		// Create batch record
		await BarcodeSheetBatch.create({
			_id: batchId,
			sheetsUsed,
			labelsPerSheet,
			totalLabels,
			barcodeIds,
			firstBarcodeId: barcodeIds[0],
			lastBarcodeId: barcodeIds[barcodeIds.length - 1],
			printedAt: new Date(),
			printedBy: { _id: locals.user._id, username: locals.user.username },
			printerName,
			notes,
			sheetsRemainingBefore,
			sheetsRemainingAfter,
			status: 'printed',
			labelsUsed: 0
		});

		// Decrement inventory
		await BarcodeInventory.findByIdAndUpdate('default', {
			$set: { avery94102SheetsOnHand: sheetsRemainingAfter }
		});

		await AuditLog.create({
			_id: generateId(),
			tableName: 'barcode_sheet_batches',
			recordId: batchId,
			action: 'INSERT',
			changedBy: locals.user.username,
			changedAt: new Date(),
			newData: { sheetsUsed, totalLabels, printerName },
			reason: 'Print barcode batch'
		});

		return { success: true, batchId, barcodeIds, totalLabels };
	}
};
