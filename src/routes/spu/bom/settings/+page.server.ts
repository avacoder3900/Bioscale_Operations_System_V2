import { requirePermission } from '$lib/server/permissions';
import { connectDB, Integration } from '$lib/server/db';
import type { PageServerLoad } from './$types';

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
