import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, PartDefinition, Integration, generateId, AuditLog, InventoryTransaction } from '$lib/server/db';
import { syncPartsFromBox } from '$lib/server/box-sync';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'inventory:read');
	await connectDB();

	// Look up PT-CT-101 so we can exclude viewer1's seeded thermoseal transactions
	const thermosealPart = await PartDefinition.findOne({ partNumber: 'PT-CT-101' }).select('_id').lean() as any;
	const thermosealPartId = thermosealPart?._id;

	const [allSpuParts, cartridgePartDocs, boxInteg, txAgg] = await Promise.all([
		PartDefinition.find({ $or: [{ bomType: 'spu' }, { bomType: { $exists: false } }] })
			.sort({ sortOrder: 1, partNumber: 1 }).lean(),
		PartDefinition.find({ bomType: 'cartridge', isActive: true })
			.sort({ partNumber: 1 }).lean(),
		Integration.findOne({ type: 'box' }).lean(),
		InventoryTransaction.aggregate([
			{ $match: {
				$nor: [
					{ performedBy: { $in: ['contracttest', 'operator1', 'nick'] } },
					...(thermosealPartId
						? [{ performedBy: '6qL9_4SC4lYXTrMGZTAui', partDefinitionId: thermosealPartId }]
						: [])
				]
			}},
			{ $sort: { createdAt: 1 } },
			{ $group: {
				_id: '$partDefinitionId',
				totalQuantity: { $sum: '$quantity' },
				txCount: { $sum: 1 },
				lastTxAt: { $max: '$createdAt' },
				lastSource: { $last: '$source' }
			}}
		])
	]);

	// Split SPU parts into BOM and non-BOM
	const spuParts = (allSpuParts as any[]).filter((p: any) => p.isBom !== false);
	const nonBomParts = (allSpuParts as any[]).filter((p: any) => p.isBom === false);

	// Map SPU parts to expected shape
	const items = (spuParts as any[]).map((p) => {
		const cost = parseFloat(p.unitCost) || null;
		const invCount = p.inventoryCount ?? 0;
		return {
			id: p._id,
			partNumber: p.partNumber ?? '',
			name: p.name ?? '',
			description: p.description ?? null,
			category: p.category ?? null,
			supplier: p.supplier ?? null,
			manufacturer: p.manufacturer ?? null,
			barcode: p.barcode ?? null,
			inventoryCount: invCount,
			inventorySource: p.inventorySource ?? 'box_estimate',
			quantityPerUnit: p.quantityPerUnit ?? null,
			unitCost: cost,
			totalValue: cost != null ? cost * invCount : null,
			minimumStockLevel: p.minimumOrderQty ?? 0,
			leadTimeDays: p.leadTimeDays ?? null
		};
	});

	// Remove entries with no cost breakdown
	const itemsWithCost = items.filter(i => i.unitCost != null && i.unitCost > 0);
	const itemsNoCost = items.filter(i => i.unitCost == null || i.unitCost <= 0);
	if (itemsNoCost.length > 0) {
		console.log(`[parts] Filtered out ${itemsNoCost.length} items with no cost data`);
	}

	// Cartridge parts (now from PartDefinition with bomType='cartridge')
	const cartridgeParts = (cartridgePartDocs as any[]).map((p) => {
		const cost = parseFloat(p.unitCost) || null;
		const invCount = p.inventoryCount ?? 0;
		return {
			id: p._id,
			partNumber: p.partNumber ?? '',
			name: p.name ?? '',
			category: p.category ?? null,
			quantityPerUnit: p.quantityPerUnit ?? null,
			inventoryCount: invCount,
			inventorySource: p.inventorySource ?? 'box_estimate',
			unitCost: cost,
			totalValue: cost != null ? cost * invCount : null,
			manufacturer: p.manufacturer ?? null,
			supplier: p.supplier ?? null,
			barcode: p.barcode ?? null,
			minimumStockLevel: p.minimumOrderQty ?? 0,
			leadTimeDays: p.leadTimeDays ?? null
		};
	});

	// Low stock items (from both parts and BOM)
	const lowStockItems = [
		...itemsWithCost.filter(i => i.inventoryCount < i.minimumStockLevel && i.minimumStockLevel > 0),
		...cartridgeParts.filter(i => i.inventoryCount < i.minimumStockLevel && i.minimumStockLevel > 0)
	].map(i => ({
		id: i.id,
		partNumber: i.partNumber,
		name: i.name,
		inventoryCount: i.inventoryCount,
		minimumStockLevel: i.minimumStockLevel
	}));

	// Cartridge BOM summary
	const cartridgeBomSummary = cartridgeParts.length > 0 ? {
		totalParts: cartridgeParts.length,
		totalValue: cartridgeParts.reduce((sum, p) => sum + (p.totalValue ?? 0), 0),
		categories: [...new Set(cartridgeParts.map(p => p.category).filter(Boolean))] as string[],
		lowStockCount: cartridgeParts.filter(p => p.inventoryCount < p.minimumStockLevel && p.minimumStockLevel > 0).length
	} : null;

	// Box.com connection status
	const boxStatus = {
		isConnected: Boolean((boxInteg as any)?.accessToken),
		lastSyncAt: (boxInteg as any)?.lastSyncAt ?? null,
		lastSyncStatus: (boxInteg as any)?.lastSyncStatus ?? null
	};

	// Sync error detail
	const syncErrorDetail = (boxInteg as any)?.lastSyncStatus === 'error' ? {
		message: (boxInteg as any)?.lastSyncError ?? 'Unknown sync error',
		failedRows: [] as string[],
		columnIssues: [] as string[]
	} : null;

	// Computed stats
	const allCategories = [...new Set(items.map(i => i.category).filter(Boolean))] as string[];
	const stats = {
		total: itemsWithCost.length,
		categories: allCategories.length,
		totalInventoryValue: itemsWithCost.reduce((sum, i) => sum + (i.totalValue ?? 0), 0),
		lowStockCount: lowStockItems.length
	};

	// Low inventory: zero/negative + low (bottom 10 that are > 0)
	const inventoryFields = (i: typeof itemsWithCost[0]) => ({
		id: i.id, partNumber: i.partNumber, name: i.name,
		inventoryCount: i.inventoryCount, leadTimeDays: i.leadTimeDays
	});
	const zeroOrNegative = items.filter(i => i.inventoryCount <= 0).map(inventoryFields);
	const lowPositive = [...itemsWithCost]
		.filter(i => i.inventoryCount > 0)
		.sort((a, b) => a.inventoryCount - b.inventoryCount)
		.slice(0, 10)
		.map(inventoryFields);
	const lowestInventory = [...zeroOrNegative, ...lowPositive];

	// Non-BOM parts mapped
	const nonBomItems = nonBomParts.map((p: any) => ({
		id: p._id,
		partNumber: p.partNumber ?? '',
		name: p.name ?? '',
		category: p.category ?? null,
		supplier: p.supplier ?? null,
		inventoryCount: p.inventoryCount ?? 0,
		unitCost: parseFloat(p.unitCost) || null,
		barcode: p.barcode ?? null
	}));

	// Transaction-based scanned inventory
	const txMap = new Map(txAgg.map((t: any) => [t._id, t]));
	const allParts = [...(allSpuParts as any[]), ...(cartridgePartDocs as any[])];
	const scannedItems = allParts
		.filter((p: any) => txMap.has(p._id))
		.map((p: any) => {
			const tx = txMap.get(p._id)!;
			const cost = parseFloat(p.unitCost) || null;
			return {
				id: p._id,
				partNumber: p.partNumber ?? '',
				name: p.name ?? '',
				category: p.category ?? null,
				stock: tx.totalQuantity,
				unitCost: cost,
				totalValue: cost ? cost * tx.totalQuantity : null,
				txCount: tx.txCount,
				lastTxAt: tx.lastTxAt,
				lastSource: tx.lastSource ?? 'unknown'
			};
		})
		.sort((a, b) => a.partNumber.localeCompare(b.partNumber));

	const scannedSummary = {
		totalParts: scannedItems.length,
		totalTransactions: scannedItems.reduce((s, i) => s + i.txCount, 0),
		totalValue: scannedItems.reduce((s, i) => s + (i.totalValue ?? 0), 0)
	};

	return {
		items: itemsWithCost,
		cartridgeParts,
		nonBomItems,
		scannedItems: JSON.parse(JSON.stringify(scannedItems)),
		scannedSummary,
		cartridgeBomSummary,
		lowStockItems,
		lowestInventory,
		boxStatus,
		syncErrorDetail,
		stats,
		categories: allCategories
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		requirePermission(locals.user, 'inventory:write');
		await connectDB();
		const form = await request.formData();
		const partNumber = form.get('partNumber')?.toString().trim();
		const name = form.get('name')?.toString().trim();
		if (!partNumber || !name) return fail(400, { error: 'Part number and name are required' });

		const existing = await PartDefinition.findOne({ partNumber });
		if (existing) return fail(400, { error: 'Part number already exists' });

		await PartDefinition.create({
			_id: generateId(),
			partNumber,
			name,
			description: form.get('description')?.toString().trim() || undefined,
			category: form.get('category')?.toString().trim() || undefined,
			unitOfMeasure: form.get('unit')?.toString().trim() || 'ea',
			minimumOrderQty: form.get('reorderPoint') ? Number(form.get('reorderPoint')) : undefined,
			createdBy: locals.user!._id
		});
		return { success: true };
	},

	createCartridgePart: async ({ request, locals }) => {
		requirePermission(locals.user, 'inventory:write');
		await connectDB();
		const form = await request.formData();
		const partNumber = form.get('partNumber')?.toString().trim();
		const name = form.get('name')?.toString().trim();
		if (!partNumber || !name) return fail(400, { error: 'Part number and name are required' });

		const existing = await PartDefinition.findOne({ partNumber });
		if (existing) return fail(400, { error: 'Part number already exists' });

		const newPart = await PartDefinition.create({
			_id: generateId(),
			partNumber,
			name,
			category: form.get('category')?.toString().trim() || undefined,
			manufacturer: form.get('manufacturer')?.toString().trim() || undefined,
			supplier: form.get('supplier')?.toString().trim() || undefined,
			unitCost: form.get('unitCost')?.toString().trim() || undefined,
			quantityPerUnit: form.get('quantityPerUnit') ? Number(form.get('quantityPerUnit')) : 1,
			unitOfMeasure: form.get('unitOfMeasure')?.toString().trim() || 'ea',
			inventoryCount: form.get('inventoryCount') ? Number(form.get('inventoryCount')) : 0,
			minimumOrderQty: form.get('minimumStockLevel') ? Number(form.get('minimumStockLevel')) : 0,
			description: form.get('description')?.toString().trim() || undefined,
			bomType: 'cartridge',
			isActive: true,
			createdBy: locals.user!._id
		});

		await AuditLog.create({
			_id: generateId(),
			tableName: 'part_definitions',
			recordId: newPart._id,
			action: 'INSERT',
			newData: { partNumber, name, bomType: 'cartridge' },
			changedAt: new Date(),
			changedBy: locals.user!.username
		});

		return { success: true };
	},

	deleteCartridgePart: async ({ request, locals }) => {
		requirePermission(locals.user, 'inventory:write');
		await connectDB();
		const form = await request.formData();
		const id = form.get('id')?.toString();
		if (!id) return fail(400, { error: 'Part ID required' });

		const part = await PartDefinition.findById(id).lean() as any;
		if (!part) return fail(404, { error: 'Part not found' });

		await PartDefinition.deleteOne({ _id: id });

		await AuditLog.create({
			_id: generateId(),
			tableName: 'part_definitions',
			recordId: id,
			action: 'DELETE',
			oldData: { partNumber: part.partNumber, name: part.name, bomType: part.bomType },
			changedAt: new Date(),
			changedBy: locals.user!.username
		});

		return { success: true };
	},

	withdraw: async ({ request, locals }) => {
		requirePermission(locals.user, 'inventory:write');
		await connectDB();

		const form = await request.formData();
		const partId = form.get('partId')?.toString().trim();
		const qtyStr = form.get('quantity')?.toString().trim();
		const reason = form.get('reason')?.toString().trim();

		if (!partId) return fail(400, { withdrawError: 'Select a part' });
		if (!qtyStr || isNaN(Number(qtyStr)) || Number(qtyStr) <= 0) {
			return fail(400, { withdrawError: 'Enter a valid quantity greater than 0' });
		}
		if (!reason) return fail(400, { withdrawError: 'Provide a reason' });

		const quantity = Number(qtyStr);
		const part = await PartDefinition.findById(partId).lean() as any;
		if (!part) return fail(404, { withdrawError: 'Part not found' });

		const balanceAgg = await InventoryTransaction.aggregate([
			{ $match: { partDefinitionId: partId } },
			{ $group: { _id: null, total: { $sum: '$quantity' } } }
		]);
		const previousQuantity = balanceAgg[0]?.total ?? 0;
		const newQuantity = previousQuantity - quantity;

		await InventoryTransaction.create({
			_id: generateId(),
			partDefinitionId: partId,
			partNumber: part.partNumber,
			transactionType: 'consumption',
			quantity: -quantity,
			previousQuantity,
			newQuantity,
			reason: `Withdraw: ${reason}`,
			performedBy: locals.user!._id,
			performedAt: new Date(),
			operatorId: locals.user!._id,
			operatorUsername: locals.user!.username,
			notes: reason
		});

		await PartDefinition.updateOne(
			{ _id: partId },
			{ $inc: { inventoryCount: -quantity } }
		);

		await AuditLog.create({
			_id: generateId(),
			tableName: 'inventory_transactions',
			recordId: partId,
			action: 'INSERT',
			newData: { partNumber: part.partNumber, quantity: -quantity, reason },
			changedAt: new Date(),
			changedBy: locals.user!.username
		});

		return {
			withdrawSuccess: true,
			withdrawMessage: `Withdrew ${quantity} of ${part.partNumber} — ${part.name}. New stock: ${newQuantity}`
		};
	},

	sync: async ({ locals }) => {
		requirePermission(locals.user, 'inventory:write');
		try {
			const result = await syncPartsFromBox();
			const msg = `Sync complete: ${result.created} created, ${result.updated} updated from "${result.fileName}"${result.errors.length > 0 ? ` (${result.errors.length} row errors)` : ''}.`;
			return {
				success: true,
				message: msg,
				syncResult: {
					created: result.created,
					updated: result.updated,
					skipped: result.skipped,
					errorCount: result.errors.length,
					columnMap: result.columnMap,
					fileName: result.fileName
				}
			};
		} catch (err: any) {
			const message = err?.message ?? 'Unknown sync error';
			console.error('[sync action] Box sync failed:', message);

			// Record error on the Integration doc
			await connectDB();
			await Integration.updateOne(
				{ type: 'box' },
				{
					$set: {
						lastSyncAt: new Date(),
						lastSyncStatus: 'error',
						lastSyncError: message
					}
				}
			);

			return fail(500, { error: message });
		}
	}
};

export const config = { maxDuration: 60 };
