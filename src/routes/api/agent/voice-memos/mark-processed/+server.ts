/**
 * VOICE-01: POST /api/agent/voice-memos/mark-processed (MCP voice_memos_mark_processed).
 * Body: { actor, memoIds[], linkedKanbanIds?[], note? }.
 *
 * For memos that need no digest (a test note, a duplicate). Writing a digest
 * marks its memos processed on its own. Idempotent: already-processed memos are
 * reported, not re-stamped.
 */
import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, VoiceMemo, AuditLog, generateId } from '$lib/server/db';
import { actorOrResponse } from '$lib/server/voice-memos/serialize';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const body = await request.json().catch(() => ({}));
	const actor = await actorOrResponse(body.actor);
	if (actor instanceof Response) return actor;

	const memoIds: string[] = Array.isArray(body.memoIds) ? body.memoIds.filter((x: unknown) => typeof x === 'string') : [];
	if (!memoIds.length) return json({ success: false, error: 'memoIds is required' }, { status: 400 });
	const linkedKanbanIds: string[] = Array.isArray(body.linkedKanbanIds) ? body.linkedKanbanIds : [];
	const noteText = typeof body.note === 'string' ? body.note.trim() : '';

	const found: any[] = await VoiceMemo.find({ _id: { $in: memoIds } }).select('_id processed').lean();
	const missing = memoIds.filter((id) => !found.some((m) => m._id === id));
	if (missing.length) return json({ success: false, error: `Unknown memo ids: ${missing.join(', ')}` }, { status: 404 });

	const now = new Date();
	const toMark = found.filter((m) => !m.processed).map((m) => m._id);
	const alreadyProcessed = found.filter((m) => m.processed).map((m) => m._id);

	if (toMark.length) {
		await VoiceMemo.updateMany(
			{ _id: { $in: toMark } },
			{
				$set: { processed: true, processedAt: now, processedBy: actor.username },
				...(linkedKanbanIds.length ? { $addToSet: { linkedKanbanIds: { $each: linkedKanbanIds } } } : {}),
				...(noteText ? { $push: { notes: { _id: generateId(), text: noteText, by: actor.username, at: now } } } : {})
			}
		);
		await AuditLog.insertMany(
			toMark.map((id) => ({
				_id: generateId(),
				tableName: 'voice_memos',
				recordId: id,
				action: 'MARK_PROCESSED',
				newData: { linkedKanbanIds, note: noteText || undefined },
				changedAt: now,
				changedBy: actor.username,
				reason: 'mcp'
			}))
		);
	}

	return json({ success: true, data: { marked: toMark, alreadyProcessed } });
};
