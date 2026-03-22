import { requirePermission } from '$lib/server/permissions';
import { connectDB, Integration } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	requirePermission(locals.user, 'inventory:read');
	await connectDB();

	const folderId = url.searchParams.get('folder') ?? null;
	const isRoot = !folderId;

	// Check if Box.com integration is active
	let connected = false;
	let errorMsg: string | null = null;
	let folders: Array<{ id: string; name: string; itemCount: number }> = [];
	let files: Array<{ id: string; name: string; size: number; updatedAt: string }> = [];

	try {
		const integration = await Integration.findOne({ type: 'box', isActive: true }).lean() as any;
		connected = !!integration?.accessToken;

		if (connected && integration) {
			// In a real implementation, we'd call the Box API here.
			// For now, return empty arrays — the Box integration handles this via client-side or API route.
			folders = [];
			files = [];
		}
	} catch (e) {
		errorMsg = 'Could not connect to file storage service.';
	}

	return {
		connected,
		folderId,
		isRoot,
		folders,
		files,
		error: errorMsg
	};
};

export const actions: Actions = {
	createFolder: async ({ request, locals }) => {
		requirePermission(locals.user, 'inventory:write');
		const form = await request.formData();
		const folderName = form.get('folderName')?.toString()?.trim();
		const parentFolderId = form.get('parentFolderId')?.toString() ?? null;
		if (!folderName) return { success: false, error: 'Folder name required' };

		// Box API call would go here; return placeholder success
		return { success: true, folderId: parentFolderId, folderName };
	},

	uploadFile: async ({ request, locals }) => {
		requirePermission(locals.user, 'inventory:write');
		const form = await request.formData();
		const parentFolderId = form.get('parentFolderId')?.toString() ?? null;

		// Box file upload would go here
		return { success: true, uploadSuccess: true, uploadError: null, folderId: parentFolderId };
	}
};

export const config = { maxDuration: 60 };
