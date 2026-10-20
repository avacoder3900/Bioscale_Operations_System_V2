/**
 * VOICE-01: GET /api/agent/voice-memos/digests/:digestId — one digest in full.
 */
import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, VoiceMemoDigest } from '$lib/server/db';
import { digestOut } from '$lib/server/voice-memos/serialize';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request, params }) => {
	requireAgentApiKey(request);
	await connectDB();

	const digest = await VoiceMemoDigest.findById(params.digestId).lean();
	if (!digest) return json({ success: false, error: `No digest ${params.digestId}` }, { status: 404 });
	return json({ success: true, data: digestOut(digest) });
};
