/**
 * Box file download proxy.
 * Streams the file content from Box to the client with proper headers.
 */
import { error } from '@sveltejs/kit';
import { downloadFile, getFileInfo } from '$lib/server/box';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) {
		throw error(401, 'Unauthorized');
	}

	const fileId = params.id;

	try {
		const [info, response] = await Promise.all([
			getFileInfo(fileId),
			downloadFile(fileId)
		]);

		return new Response(response.body, {
			status: 200,
			headers: {
				'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream',
				'Content-Disposition': `attachment; filename="${info.name}"`,
				'Content-Length': String(info.size)
			}
		});
	} catch (err) {
		throw error(500, err instanceof Error ? err.message : 'Download failed');
	}
};
