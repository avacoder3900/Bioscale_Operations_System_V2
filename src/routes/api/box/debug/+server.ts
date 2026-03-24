import { json } from '@sveltejs/kit';
import { connectDB, Integration } from '$lib/server/db';
import { getFileInfo, listFolder } from '$lib/server/box';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	try {
		await connectDB();
		const integ = await Integration.findOne({ type: 'box' }).lean() as any;

		if (!integ?.accessToken) {
			return json({ error: 'No Box integration found', hasToken: false });
		}

		const tokenInfo = {
			hasAccessToken: Boolean(integ.accessToken),
			hasRefreshToken: Boolean(integ.refreshToken),
			expiresAt: integ.expiresAt,
			isExpired: integ.expiresAt ? new Date(integ.expiresAt).getTime() < Date.now() : 'unknown',
			spreadsheetId: integ.spreadsheetId,
			lastSyncStatus: integ.lastSyncStatus,
			lastSyncError: integ.lastSyncError
		};

		// Try listing root folder to verify token works
		let rootTest = 'not tested';
		try {
			const root = await listFolder('0');
			rootTest = `OK — ${root.items.length} items in root folder "${root.name}"`;
		} catch (e: any) {
			rootTest = `FAILED — ${e.message}`;
		}

		// Try accessing the target file
		let fileTest = 'not tested';
		const targetFileId = '1990254823135';
		try {
			const info = await getFileInfo(targetFileId);
			fileTest = `OK — "${info.name}" (${info.size} bytes)`;
		} catch (e: any) {
			fileTest = `FAILED — ${e.message}`;
		}

		return json({ tokenInfo, rootTest, fileTest });
	} catch (e: any) {
		return json({ error: e.message });
	}
};
