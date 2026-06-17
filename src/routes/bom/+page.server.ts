import { requirePermission } from '$lib/server/permissions';
import { connectDB, BomItem, Integration } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'inventory:read');
	await connectDB();

	const items = await BomItem.find({ $or: [{ bomType: 'spu' }, { bomType: { $exists: false } }] }).sort({ partNumber: 1 }).lean();

	const boxInteg = await Integration.findOne({ type: 'box' }).lean() as any;

	// Compute stats
	const allItems = items as any[];
	const LOW_STOCK_THRESHOLD = 5;
	const totalInventoryValue = allItems.reduce((sum, i) => {
		const unitCost = Number(i.unitCost) || 0;
		const qty = Number(i.inventoryCount) || 0;
		return sum + unitCost * qty;
	}, 0);
	const lowStockCount = allItems.filter((i) => (Number(i.inventoryCount) || 0) < LOW_STOCK_THRESHOLD).length;
	const categories = [...new Set(allItems.map((i) => i.category).filter(Boolean))].sort();

	return {
		items: allItems.map((i) => ({
			id: i._id,
			partNumber: i.partNumber ?? '',
			name: i.name ?? '',
			description: i.description ?? null,
			unitCost: i.unitCost ? Number(i.unitCost) : null,
			quantity: i.inventoryCount ?? null,
			inventoryCount: Number(i.inventoryCount) || 0,
			quantityPerUnit: Number(i.quantityPerUnit) || 1,
			totalValue: (Number(i.unitCost) || 0) * (Number(i.inventoryCount) || 0),
			partDefinitionId: i.partDefinitionId ?? null,
			supplier: i.supplier ?? null,
			category: i.category ?? null,
			isActive: i.isActive ?? true,
			expirationDate: i.expirationDate ?? null,
			folderId: null,
			folderName: null,
			createdAt: i.createdAt,
			updatedAt: i.updatedAt
		})),
		folders: [],
		stats: {
			totalItems: allItems.length,
			totalInventoryValue,
			lowStock: lowStockCount
		},
		categories,
		boxStatus: {
			isConnected: Boolean(boxInteg?.accessToken),
			connected: Boolean(boxInteg?.accessToken),
			lastSyncAt: boxInteg?.lastSyncAt ?? null,
			lastSyncStatus: boxInteg?.lastSyncStatus ?? null
		}
	};
};

export const config = { maxDuration: 60 };
