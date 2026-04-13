/**
 * GET /api/r2/files/{key}
 *
 * Streams a file from R2 inline so the browser renders images/PDFs directly.
 */
import { error } from '@sveltejs/kit';
import { downloadFile } from '$lib/server/r2';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) {
		throw error(401, 'Unauthorized');
	}

	const key = params.key;
	if (!key) {
		throw error(400, 'File key is required');
	}

	try {
		const { body, contentType, size } = await downloadFile(key);
		const fileName = key.split('/').pop() ?? 'file';

		return new Response(body, {
			status: 200,
			headers: {
				'Content-Type': contentType,
				'Content-Disposition': `inline; filename="${fileName}"`,
				'Content-Length': String(size),
				'Cache-Control': 'private, max-age=3600'
			}
		});
	} catch (err) {
		console.error('[r2/files] Error:', err);
		throw error(500, err instanceof Error ? err.message : 'Failed to load file');
	}
};
