import { error } from '@sveltejs/kit';
import { Readable } from 'node:stream';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession } from '$lib/server/db';
import { RECORDING_BUCKET, statGridFile, streamGridFile } from '$lib/server/sonic/archive';
import { fetchRecording } from '$lib/server/sonic/fetch';
import type { RequestHandler } from './$types';

/**
 * GET /validation/sonic/[sessionId]/audio — the recording's audio for the page's
 * player. Served from the MongoDB copy (GridFS) when there is one, so playback
 * keeps working if R2 has a problem, and with HTTP Range support so the player
 * can seek (trim handles, anomaly clips). Falls back to the R2 original when the
 * copy hasn't been made yet. ?source=r2 forces the original.
 */
export const GET: RequestHandler = async ({ params, locals, request, url }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const s = (await ValidationSession.findById(params.sessionId).select('type results.rawData').lean()) as any;
	if (!s || s.type !== 'sonic') throw error(404, 'Sonic recording not found');
	const raw = s.results?.[0]?.rawData ?? {};
	const contentType: string = raw.mimeType || 'audio/mp4';
	const baseHeaders = {
		'Content-Type': contentType,
		'Accept-Ranges': 'bytes',
		'Cache-Control': 'private, max-age=3600'
	};

	const fileId: string | undefined = raw.mongoCopy?.fileId;
	const stat = fileId && url.searchParams.get('source') !== 'r2' ? await statGridFile(RECORDING_BUCKET, fileId) : null;
	if (fileId && stat) {
		const total = stat.length;
		const range = request.headers.get('range');
		const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
		if (m && (m[1] || m[2])) {
			let start = m[1] ? Number(m[1]) : Math.max(0, total - Number(m[2]));
			let end = m[1] && m[2] ? Number(m[2]) : total - 1;
			end = Math.min(end, total - 1);
			if (!(start <= end) || start >= total) {
				return new Response(null, { status: 416, headers: { ...baseHeaders, 'Content-Range': `bytes */${total}` } });
			}
			start = Math.max(0, start);
			const body = Readable.toWeb(streamGridFile(RECORDING_BUCKET, fileId, start, end)) as unknown as ReadableStream;
			return new Response(body, {
				status: 206,
				headers: { ...baseHeaders, 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': String(end - start + 1) }
			});
		}
		const body = Readable.toWeb(streamGridFile(RECORDING_BUCKET, fileId)) as unknown as ReadableStream;
		return new Response(body, { status: 200, headers: { ...baseHeaders, 'Content-Length': String(total) } });
	}

	// No MongoDB copy yet (or ?source=r2): serve the original from R2.
	if (!raw.r2Key) throw error(404, 'This session has no stored recording');
	let bytes: Uint8Array;
	try {
		bytes = await fetchRecording(raw.r2Key);
	} catch (err) {
		throw error(502, `Could not read the recording from R2: ${err instanceof Error ? err.message : String(err)}`);
	}
	const total = bytes.byteLength;
	const range = request.headers.get('range');
	const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
	if (m && (m[1] || m[2])) {
		const start = m[1] ? Number(m[1]) : Math.max(0, total - Number(m[2]));
		const end = Math.min(m[1] && m[2] ? Number(m[2]) : total - 1, total - 1);
		if (!(start <= end) || start >= total) {
			return new Response(null, { status: 416, headers: { ...baseHeaders, 'Content-Range': `bytes */${total}` } });
		}
		return new Response(bytes.slice(start, end + 1), {
			status: 206,
			headers: { ...baseHeaders, 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': String(end - start + 1) }
		});
	}
	return new Response(bytes, { status: 200, headers: { ...baseHeaders, 'Content-Length': String(total) } });
};
