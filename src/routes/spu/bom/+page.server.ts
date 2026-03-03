import { requirePermission } from '$lib/server/permissions';
import { connectDB, BomItem, Integration } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'inventory:read');
	await connectDB();

	const items = await BomItem.find().sort({ partNumber: 1 }).lean();

	const boxInteg = await Integration.findOne({ type: 'box' }).lean() as any;

	return {
		items: items.map((i: any) => ({
			id: i._id,
			partNumber: i.partNumber ?? '',
			name: i.name ?? '',
			description: i.description ?? null,
			unitCost: i.unitCost ? Number(i.unitCost) : null,
			quantity: i.inventoryCount ?? null,
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
		boxStatus: {
			connected: Boolean(boxInteg?.accessToken),
			lastSyncAt: boxInteg?.lastSyncAt ?? null,
			lastSyncStatus: boxInteg?.lastSyncStatus ?? null
		}
	};
};
