/**
 * VOICE-01: voice memo digests — the readable layer shown at /kanban/journal.
 *
 * GET  /api/agent/voice-memos/digests  (MCP voice_memo_digests_list)
 *      Query: since, until (YYYY-MM-DD on `date`), includeSuperseded=true, limit (≤60, default 14).
 *      Newest first.
 *
 * POST /api/agent/voice-memos/digests  (MCP voice_memo_digest_write)
 *      Body: { actor, date, title, summary, memoIds[], linkedKanbanIds?[], replacesDigestId? }
 *      Files the digest and marks every source memo processed. A rewrite passes
 *      replacesDigestId: the old version becomes 'superseded' (kept), the new one
 *      gets version+1. Writing a second digest over memos that already have a
 *      current digest, without replacesDigestId, is refused — so a re-run
 *      supersedes instead of duplicating.
 */
import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, VoiceMemo, VoiceMemoDigest, AuditLog, generateId } from '$lib/server/db';
import { actorOrResponse, digestOut, isDay } from '$lib/server/voice-memos/serialize';
import type { RequestHandler } from './$types';

const MAX_SUMMARY_CHARS = 40_000;

export const GET: RequestHandler = async ({ request, url }) => {
	requireAgentApiKey(request);
	await connectDB();

	const q = url.searchParams;
	const filter: Record<string, any> = {};
	if (q.get('includeSuperseded') !== 'true') filter.status = 'current';
	const since = q.get('since');
	const until = q.get('until');
	if ((since && !isDay(since)) || (until && !isDay(until))) {
		return json({ success: false, error: 'since/until must be YYYY-MM-DD' }, { status: 400 });
	}
	if (since || until) filter.date = { ...(since ? { $gte: since } : {}), ...(until ? { $lte: until } : {}) };
	const limit = Math.min(Math.max(parseInt(q.get('limit') || '14') || 14, 1), 60);

	const digests = await VoiceMemoDigest.find(filter).sort({ date: -1, createdAt: -1 }).limit(limit).lean();
	return json({ success: true, data: { digests: (digests as any[]).map(digestOut) } });
};

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const body = await request.json().catch(() => ({}));
	const actor = await actorOrResponse(body.actor);
	if (actor instanceof Response) return actor;

	const { date, replacesDigestId } = body;
	const title = typeof body.title === 'string' ? body.title.trim() : '';
	const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
	const memoIds: string[] = Array.isArray(body.memoIds) ? [...new Set<string>(body.memoIds.filter((x: unknown) => typeof x === 'string'))] : [];
	const linkedKanbanIds: string[] = Array.isArray(body.linkedKanbanIds) ? body.linkedKanbanIds.filter((x: unknown) => typeof x === 'string') : [];

	if (!isDay(date)) return json({ success: false, error: 'date must be YYYY-MM-DD' }, { status: 400 });
	if (!title) return json({ success: false, error: 'title is required' }, { status: 400 });
	if (!summary) return json({ success: false, error: 'summary is required' }, { status: 400 });
	if (summary.length > MAX_SUMMARY_CHARS) return json({ success: false, error: `summary is over ${MAX_SUMMARY_CHARS} characters` }, { status: 400 });
	if (!memoIds.length) return json({ success: false, error: 'memoIds is required — a digest must cite the memos it summarizes' }, { status: 400 });

	const memos: any[] = await VoiceMemo.find({ _id: { $in: memoIds } }).select('_id speaker').lean();
	const missing = memoIds.filter((id) => !memos.some((m) => m._id === id));
	if (missing.length) return json({ success: false, error: `Unknown memo ids: ${missing.join(', ')}` }, { status: 404 });

	let previous: any = null;
	if (replacesDigestId) {
		previous = await VoiceMemoDigest.findById(replacesDigestId).lean();
		if (!previous) return json({ success: false, error: `No digest ${replacesDigestId}` }, { status: 404 });
		if (previous.status !== 'current') {
			return json(
				{ success: false, error: `Digest ${replacesDigestId} is already superseded by ${previous.supersededBy}; replace that one instead` },
				{ status: 409 }
			);
		}
	} else {
		const overlapping: any = await VoiceMemoDigest.findOne({ status: 'current', memoIds: { $in: memoIds } })
			.select('_id date title')
			.lean();
		if (overlapping) {
			return json(
				{
					success: false,
					error:
						`Some of these memos already have a current digest (${overlapping._id}, ${overlapping.date} "${overlapping.title}"). ` +
						'To rewrite it, call again with replacesDigestId set to that id.'
				},
				{ status: 409 }
			);
		}
	}

	const now = new Date();
	const digestId = generateId();
	const speakers = [...new Set(memos.map((m) => m.speaker?.username).filter(Boolean))];

	await VoiceMemoDigest.create({
		_id: digestId,
		date,
		title,
		summary,
		memoIds,
		speakers,
		linkedKanbanIds,
		status: 'current',
		version: previous ? (previous.version ?? 1) + 1 : 1,
		supersedes: previous?._id ?? null,
		authoredBy: actor.username,
		filedVia: 'mcp'
	});

	if (previous) {
		await VoiceMemoDigest.updateOne({ _id: previous._id }, { $set: { status: 'superseded', supersededBy: digestId } });
	}

	await VoiceMemo.updateMany(
		{ _id: { $in: memoIds } },
		{
			$set: { processed: true, processedAt: now, processedBy: actor.username },
			$addToSet: { digestIds: digestId, ...(linkedKanbanIds.length ? { linkedKanbanIds: { $each: linkedKanbanIds } } : {}) }
		}
	);

	await AuditLog.create({
		_id: generateId(),
		tableName: 'voice_memo_digests',
		recordId: digestId,
		action: 'INSERT',
		newData: { date, title, memoIds, linkedKanbanIds, supersedes: previous?._id ?? null, summaryLength: summary.length },
		changedAt: now,
		changedBy: actor.username,
		reason: 'mcp'
	});

	return json(
		{
			success: true,
			data: {
				digestId,
				version: previous ? (previous.version ?? 1) + 1 : 1,
				supersedes: previous?._id ?? null,
				memosMarkedProcessed: memoIds,
				viewAt: `/kanban/journal#${date}`
			}
		},
		{ status: 201 }
	);
};
