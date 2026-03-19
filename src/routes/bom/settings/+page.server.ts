import { requirePermission } from '$lib/server/permissions';
import { connectDB, Integration } from '$lib/server/db';
import type { PageServerLoad } from './$types';

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
