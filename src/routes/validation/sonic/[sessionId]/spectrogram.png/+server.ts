import { error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession } from '$lib/server/db';
import { loadSpectrogram } from '$lib/server/sonic/review';
import { renderSpectrogramPng } from '$lib/server/sonic/spectrogram';
import type { RequestHandler } from './$types';

/**
 * GET /validation/sonic/[sessionId]/spectrogram.png — the recording's fine
 * spectrogram (50 ms × 64 bands, 50 Hz–16 kHz) as an image spanning the whole
 * recording, for the review timeline. Rendered from the stored GridFS data.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();
	const s = (await ValidationSession.findById(params.sessionId).select('type results.processedData.spectrogram').lean()) as any;
	if (!s || s.type !== 'sonic') throw error(404, 'Sonic recording not found');
	const spec = await loadSpectrogram(s.results?.[0]?.processedData);
	if (!spec) throw error(404, 'No spectrogram yet — analyze the recording');
	const png = await renderSpectrogramPng(spec, { width: 2400, rowPx: 3 });
	return new Response(new Uint8Array(png), {
		headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=600' }
	});
};
