/**
 * VOICE-01: GET /api/agent/voice-memos — list voice memos (MCP voice_memos_list).
 *
 * Query: processed=false (default) | true | all, speaker, kind (eod|experiment),
 * tag, experimentRef, since, until (ISO dates, on recordedAt), limit (≤100, default 25).
 * Oldest first, so a "process my EODs" pass reads the days in order.
 */
import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, VoiceMemo } from '$lib/server/db';
import { memoSummary } from '$lib/server/voice-memos/serialize';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request, url }) => {
	requireAgentApiKey(request);
	await connectDB();

	const q = url.searchParams;
	const filter: Record<string, any> = {};

	const processed = q.get('processed') ?? 'false';
	if (processed === 'false') filter.processed = false;
	else if (processed === 'true') filter.processed = true;

	if (q.get('speaker')) filter['speaker.username'] = q.get('speaker');
	if (q.get('kind')) filter.kind = q.get('kind');
	if (q.get('tag')) filter.tags = q.get('tag')!.toLowerCase();
	if (q.get('experimentRef')) filter.experimentRef = q.get('experimentRef')!.toUpperCase();

	const since = q.get('since') ? new Date(q.get('since')!) : null;
	const until = q.get('until') ? new Date(q.get('until')!) : null;
	if ((since && isNaN(since.getTime())) || (until && isNaN(until.getTime()))) {
		return json({ success: false, error: 'since/until must be ISO dates' }, { status: 400 });
	}
	if (since || until) filter.recordedAt = { ...(since ? { $gte: since } : {}), ...(until ? { $lte: until } : {}) };

	const limit = Math.min(Math.max(parseInt(q.get('limit') || '25') || 25, 1), 100);

	const [memos, total] = await Promise.all([
		VoiceMemo.find(filter).select('-raw').sort({ recordedAt: 1 }).limit(limit).lean(),
		VoiceMemo.countDocuments(filter)
	]);

	return json({
		success: true,
		data: {
			memos: (memos as any[]).map(memoSummary),
			total,
			returned: memos.length,
			hasMore: total > memos.length
		}
	});
};
