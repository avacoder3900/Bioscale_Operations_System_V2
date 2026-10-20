/**
 * VOICE-01: POST /api/agent/voice-memos/:id/notes — append an annotation
 * (MCP voice_memos_annotate). Body: { actor, text }. The transcript is never touched.
 */
import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, VoiceMemo, AuditLog, generateId } from '$lib/server/db';
import { actorOrResponse } from '$lib/server/voice-memos/serialize';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, params }) => {
	requireAgentApiKey(request);
	await connectDB();

	const body = await request.json().catch(() => ({}));
	const actor = await actorOrResponse(body.actor);
	if (actor instanceof Response) return actor;

	const text = typeof body.text === 'string' ? body.text.trim() : '';
	if (!text) return json({ success: false, error: 'text is required' }, { status: 400 });

	const memo: any = await VoiceMemo.findById(params.id).select('_id').lean();
	if (!memo) return json({ success: false, error: `No voice memo ${params.id}` }, { status: 404 });

	const note = { _id: generateId(), text, by: actor.username, at: new Date() };
	await VoiceMemo.updateOne({ _id: memo._id }, { $push: { notes: note } });
	await AuditLog.create({
		_id: generateId(),
		tableName: 'voice_memos',
		recordId: memo._id,
		action: 'ANNOTATE',
		newData: { noteId: note._id, text },
		changedAt: note.at,
		changedBy: actor.username,
		reason: 'mcp'
	});

	return json({ success: true, data: { memoId: memo._id, note: { id: note._id, text, by: note.by, at: note.at } } }, { status: 201 });
};
