import { requirePermission } from '$lib/server/permissions';
import { connectDB, BomItem, Integration } from '$lib/server/db';
import { listFolder } from '$lib/server/box';
import type { PageServerLoad, Actions } from './$types';

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

export const actions: Actions = {
	sync: async ({ locals }) => {
		requirePermission(locals.user, 'inventory:read');
		await connectDB();

		const boxInteg = await Integration.findOne({ type: 'box' }).lean() as any;
		if (!boxInteg?.accessToken) {
			return { success: false, error: 'Box not connected. Go to Settings to connect.' };
		}

		try {
			// Update sync status to in_progress
			await Integration.updateOne(
				{ _id: boxInteg._id },
				{ $set: { lastSyncStatus: 'in_progress' } }
			);

			// List files from Box root folder (or configured folder)
			const folderId = boxInteg.folderId || '0';
			const folder = await listFolder(folderId);

			// Update sync status to success
			await Integration.updateOne(
				{ _id: boxInteg._id },
				{
					$set: {
						lastSyncAt: new Date(),
						lastSyncStatus: 'success',
						lastSyncError: null
					}
				}
			);

			return { success: true, fileCount: folder.items.length };
		} catch (err) {
			await Integration.updateOne(
				{ _id: boxInteg._id },
				{
					$set: {
						lastSyncAt: new Date(),
						lastSyncStatus: 'error',
						lastSyncError: err instanceof Error ? err.message : 'Sync failed'
					}
				}
			);
			return { success: false, error: err instanceof Error ? err.message : 'Sync failed' };
		}
	}
};
