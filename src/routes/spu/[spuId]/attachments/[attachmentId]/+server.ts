import { error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Spu } from '$lib/server/db';
import { downloadFromR2 } from '$lib/server/services/r2';
import type { RequestHandler } from './$types';

// Stream a single attachment back as a faithful download.
// New attachments live in R2 (bytes fetched via the worker); legacy ones may
// still carry inline `content` from before the R2 switch.
export const GET: RequestHandler = async ({ locals, params }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const spu = (await Spu.findById(params.spuId, { attachments: 1 }).lean()) as any;
	if (!spu) throw error(404, 'SPU not found');

	const att = (spu.attachments ?? []).find((a: any) => a._id === params.attachmentId);
	if (!att) throw error(404, 'Attachment not found');

	// Strip quotes/newlines from the filename to keep the header valid.
	const filename = String(att.fileName ?? 'attachment').replace(/["\r\n]/g, '');

	let body: BodyInit;
	if (att.r2Key) {
		const buf = await downloadFromR2(att.r2Key);
		body = new Blob([new Uint8Array(buf)], { type: att.mimeType || 'application/octet-stream' });
	} else if (typeof att.content === 'string') {
		body = att.content; // legacy inline (pre-R2)
	} else {
		throw error(404, 'Attachment has no stored content');
	}

	return new Response(body, {
		headers: {
			'Content-Type': att.mimeType || 'application/octet-stream',
			'Content-Disposition': `attachment; filename="${filename}"`,
			'Cache-Control': 'no-store'
		}
	});
};
