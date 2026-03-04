import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, PartDefinition, BomItem, Integration, generateId } from '$lib/server/db';
import { syncPartsFromBox } from '$lib/server/box-sync';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'inventory:read');
	await connectDB();

	const [parts, cartridgeBomItems, boxInteg] = await Promise.all([
		PartDefinition.find().sort({ sortOrder: 1, partNumber: 1 }).lean(),
		BomItem.find({ bomType: 'cartridge', isActive: true }).lean(),
		Integration.findOne({ type: 'box' }).lean()
	]);

	// Map parts to expected shape
	const items = (parts as any[]).map((p) => {
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

	// Cartridge BOM parts
	const cartridgeParts = (cartridgeBomItems as any[]).map((b) => {
		const cost = parseFloat(b.unitCost) || null;
		const invCount = b.inventoryCount ?? 0;
		return {
			id: b._id,
			partNumber: b.partNumber ?? '',
			name: b.name ?? '',
			category: b.category ?? null,
			quantityPerUnit: b.quantityPerUnit ?? null,
			inventoryCount: invCount,
			unitCost: cost,
			totalValue: cost != null ? cost * invCount : null,
			manufacturer: b.manufacturer ?? null,
			supplier: b.supplier ?? null,
			minimumStockLevel: b.minimumStockLevel ?? 0,
			leadTimeDays: b.leadTimeDays ?? null
		};
	});

	// Low stock items (from both parts and BOM)
	const lowStockItems = [
		...items.filter(i => i.inventoryCount < i.minimumStockLevel && i.minimumStockLevel > 0),
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
		total: items.length,
		categories: allCategories.length,
		totalInventoryValue: items.reduce((sum, i) => sum + (i.totalValue ?? 0), 0),
		lowStockCount: lowStockItems.length
	};

	// Low inventory: zero/negative + low (bottom 10 that are > 0)
	const inventoryFields = (i: typeof items[0]) => ({
		id: i.id, partNumber: i.partNumber, name: i.name,
		inventoryCount: i.inventoryCount, leadTimeDays: i.leadTimeDays
	});
	const zeroOrNegative = items.filter(i => i.inventoryCount <= 0).map(inventoryFields);
	const lowPositive = [...items]
		.filter(i => i.inventoryCount > 0)
		.sort((a, b) => a.inventoryCount - b.inventoryCount)
		.slice(0, 10)
		.map(inventoryFields);
	const lowestInventory = [...zeroOrNegative, ...lowPositive];

	return {
		items,
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
