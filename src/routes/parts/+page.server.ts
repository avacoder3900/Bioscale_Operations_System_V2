import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, PartDefinition, Integration, generateId, AuditLog } from '$lib/server/db';
import { syncPartsFromBox } from '$lib/server/box-sync';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'inventory:read');
	await connectDB();

	const [spuParts, cartridgePartDocs, boxInteg] = await Promise.all([
		PartDefinition.find({ $or: [{ bomType: 'spu' }, { bomType: { $exists: false } }] })
			.sort({ sortOrder: 1, partNumber: 1 }).lean(),
		PartDefinition.find({ bomType: 'cartridge', isActive: true })
			.sort({ partNumber: 1 }).lean(),
		Integration.findOne({ type: 'box' }).lean()
	]);

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
			inventoryCount: invCount,
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
			unitCost: cost,
			totalValue: cost != null ? cost * invCount : null,
			manufacturer: p.manufacturer ?? null,
			supplier: p.supplier ?? null,
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

	return {
		items: itemsWithCost,
		cartridgeParts,
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

	sync: async ({ locals }) => {
		requirePermission(locals.user, 'inventory:write');
		try {
			const result = await syncPartsFromBox();
			const msg = `Sync complete: ${result.upserted} parts upserted from "${result.fileName}"${result.errors.length > 0 ? ` (${result.errors.length} row errors)` : ''}.`;
			return {
				success: true,
				message: msg,
				syncResult: {
					upserted: result.upserted,
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
