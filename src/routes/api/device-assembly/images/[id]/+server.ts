import { error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection';
import { WorkInstructionImage } from '$lib/server/db/models';
import type { RequestHandler } from './$types';

// Serves SPU Assembly WI images that were stored in Mongo (the fallback
// when R2 is not configured). Requires a logged-in session.
export const GET: RequestHandler = async ({ params, locals, setHeaders }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();
	const img = await WorkInstructionImage.findById(params.id).lean() as any;
	if (!img) throw error(404, 'Image not found');
	const bytes: Buffer = Buffer.isBuffer(img.data) ? img.data : Buffer.from(img.data?.buffer ?? img.data);
	setHeaders({
		'Content-Type': img.contentType || 'image/png',
		'Content-Length': String(bytes.length),
		'Cache-Control': 'private, max-age=86400, immutable'
	});
	return new Response(new Uint8Array(bytes));
};
