import { requirePermission } from '$lib/server/permissions';
import { connectDB, Integration } from '$lib/server/db';
import { listFolder } from '$lib/server/box';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'inventory:read');
	await connectDB();

	const boxInteg = await Integration.findOne({ type: 'box' }).lean();

	return {
		boxIntegration: boxInteg
			? {
					id: (boxInteg as any)._id,
					accessToken: (boxInteg as any).accessToken ?? null,
					refreshToken: (boxInteg as any).refreshToken ?? null,
					lastSyncAt: (boxInteg as any).lastSyncAt ?? null,
					lastSyncStatus: (boxInteg as any).lastSyncStatus ?? null,
					lastSyncError: (boxInteg as any).lastSyncError ?? null,
					syncIntervalMinutes: (boxInteg as any).syncIntervalMinutes ?? null,
					folderId: (boxInteg as any).folderId ?? null,
					spreadsheetId: (boxInteg as any).spreadsheetId ?? null
				}
			: null
	};
};

export const actions: Actions = {
	syncNow: async ({ locals }) => {
		requirePermission(locals.user, 'inventory:read');
		await connectDB();

		const boxInteg = await Integration.findOne({ type: 'box' }).lean() as any;
		if (!boxInteg?.accessToken) {
			return { success: false, error: 'Box not connected' };
		}

		try {
			await Integration.updateOne(
				{ _id: boxInteg._id },
				{ $set: { lastSyncStatus: 'in_progress' } }
			);

			const folderId = boxInteg.folderId || '0';
			const folder = await listFolder(folderId);

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
