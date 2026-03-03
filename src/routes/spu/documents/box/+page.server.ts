import { connectDB, Integration } from '$lib/server/db';
import { listFolder } from '$lib/server/box';
import { env } from '$env/dynamic/private';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	await connectDB();

	// Check connection
	const boxInteg = await Integration.findOne({ type: 'box' }).lean() as any;
	const connected = Boolean(boxInteg?.accessToken);

	const rootFolderId = env.BOX_ROOT_FOLDER_ID || '0';
	const targetFolder = 'Leo';

	if (!connected) {
		return {
			connected: false,
			currentFolderId: null,
			currentFolderName: targetFolder,
			targetFolder,
			breadcrumbs: [] as { id: string; name: string }[],
			items: [] as { id: string; type: string; name: string; size: number | null }[],
			error: null
		};
	}

	// Determine which folder to browse
	const folderId = url.searchParams.get('folderId') || rootFolderId;

	// Parse breadcrumbs from query params
	let breadcrumbs: { id: string; name: string }[] = [];
	const breadcrumbsParam = url.searchParams.get('breadcrumbs');
	if (breadcrumbsParam) {
		try {
			breadcrumbs = JSON.parse(breadcrumbsParam);
		} catch { /* use empty */ }
	}

	try {
		const folder = await listFolder(folderId);

		// Sort: folders first, then files, alphabetically
		const sorted = folder.items.sort((a, b) => {
			if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
			return a.name.localeCompare(b.name);
		});

		return {
			connected: true,
			currentFolderId: folderId,
			currentFolderName: folder.name,
			targetFolder,
			breadcrumbs,
			items: sorted.map((item) => ({
				id: item.id,
				type: item.type,
				name: item.name,
				size: item.size
			})),
			error: null
		};
	} catch (err) {
		return {
			connected: true,
			currentFolderId: folderId,
			currentFolderName: 'Error',
			targetFolder,
			breadcrumbs,
			items: [] as { id: string; type: string; name: string; size: number | null }[],
			error: err instanceof Error ? err.message : 'Failed to load folder contents'
		};
	}
};
