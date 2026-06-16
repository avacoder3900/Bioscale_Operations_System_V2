import { error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Spu } from '$lib/server/db';
import type { RequestHandler } from './$types';

// Stream a single inline attachment (e.g. thermocouple CSV) back as a downloadable file.
export const GET: RequestHandler = async ({ locals, params }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const spu = (await Spu.findById(params.spuId, { attachments: 1 }).lean()) as any;
	if (!spu) throw error(404, 'SPU not found');

	const att = (spu.attachments ?? []).find((a: any) => a._id === params.attachmentId);
	if (!att) throw error(404, 'Attachment not found');

	// Strip quotes/newlines from the filename to keep the header valid.
	const filename = String(att.fileName ?? 'attachment.csv').replace(/["\r\n]/g, '');

	return new Response(att.content ?? '', {
		headers: {
			'Content-Type': att.mimeType || 'text/csv',
			'Content-Disposition': `attachment; filename="${filename}"`,
			'Cache-Control': 'no-store'
		}
	});
};
