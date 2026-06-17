/**
 * Box file inline viewer proxy.
 * Streams the file from Box and serves it with Content-Disposition: inline
 * so the browser renders images/PDFs directly instead of downloading.
 */
import { error } from '@sveltejs/kit';
import { downloadFile, getFileInfo } from '$lib/server/box';
import type { RequestHandler } from './$types';

const MIME_MAP: Record<string, string> = {
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	png: 'image/png',
	gif: 'image/gif',
	webp: 'image/webp',
	pdf: 'application/pdf',
	svg: 'image/svg+xml',
	bmp: 'image/bmp',
	tiff: 'image/tiff',
	tif: 'image/tiff'
};

function mimeFromName(name: string): string {
	const ext = name.split('.').pop()?.toLowerCase() ?? '';
	return MIME_MAP[ext] ?? 'application/octet-stream';
}

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

		const contentType = response.headers.get('content-type') || mimeFromName(info.name);

		return new Response(response.body, {
			status: 200,
			headers: {
				'Content-Type': contentType,
				'Content-Disposition': `inline; filename="${info.name}"`,
				'Content-Length': String(info.size),
				'Cache-Control': 'private, max-age=3600'
			}
		});
	} catch (err) {
		throw error(500, err instanceof Error ? err.message : 'Failed to load file');
	}
};
