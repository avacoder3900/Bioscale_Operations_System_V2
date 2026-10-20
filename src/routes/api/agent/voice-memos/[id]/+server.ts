/**
 * VOICE-01: GET /api/agent/voice-memos/:id — one memo in full (MCP voice_memos_get).
 * :id is the BIMS memo id or the Voicenotes note id. ?raw=true adds the verbatim webhook body.
 */
import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, VoiceMemo } from '$lib/server/db';
import { memoFull } from '$lib/server/voice-memos/serialize';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request, params, url }) => {
	requireAgentApiKey(request);
	await connectDB();

	const memo = await VoiceMemo.findOne({ $or: [{ _id: params.id }, { sourceNoteId: params.id }] }).lean();
	if (!memo) return json({ success: false, error: `No voice memo ${params.id}` }, { status: 404 });

	return json({ success: true, data: memoFull(memo, url.searchParams.get('raw') === 'true') });
};
