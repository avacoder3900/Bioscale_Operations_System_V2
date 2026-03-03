import { requirePermission } from '$lib/server/permissions';
import { connectDB, Integration } from '$lib/server/db';
import { listFolder } from '$lib/server/box';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'inventory:read');
	await connectDB();

	const { env } = await import('$env/dynamic/private');
	const isConfigured = Boolean(env.BOX_CLIENT_ID && env.BOX_CLIENT_SECRET && env.BOX_REDIRECT_URI);

	const boxInteg = await Integration.findOne({ type: 'box' }).lean() as any;
	const isConnected = Boolean(boxInteg?.accessToken);

	const targetFolder = 'Leo';
	const targetFile = 'BOM.xlsx';

	return {
		isConfigured,
		isConnected,
		connectionError: null as string | null,
		justConnected: false,
		targetFolder,
		targetFile,
		folderId: boxInteg?.folderId ?? null,
		fileId: boxInteg?.spreadsheetId ?? null,
		lastSyncAt: boxInteg?.lastSyncAt ?? null,
		lastSyncStatus: isConnected ? (boxInteg?.lastSyncStatus ?? 'connected') : null,
		lastSyncError: boxInteg?.lastSyncError ?? null,
		boxIntegration: boxInteg
			? {
					id: boxInteg._id,
					accessToken: boxInteg.accessToken ?? null,
					refreshToken: boxInteg.refreshToken ?? null,
					lastSyncAt: boxInteg.lastSyncAt ?? null,
					lastSyncStatus: boxInteg.lastSyncStatus ?? null,
					lastSyncError: boxInteg.lastSyncError ?? null,
					syncIntervalMinutes: boxInteg.syncIntervalMinutes ?? null,
					folderId: boxInteg.folderId ?? null,
					spreadsheetId: boxInteg.spreadsheetId ?? null
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
