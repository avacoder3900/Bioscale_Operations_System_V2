/**
 * VOICE-01: shapes returned by /api/agent/voice-memos/** (and so by the MCP tools).
 * `raw` is never included unless asked for — it is the verbatim webhook body.
 */
import { json } from '@sveltejs/kit';
import { resolveActor, ActorError } from '$lib/server/machine-actor';

export const LIST_TRANSCRIPT_CHARS = 800;

export function memoSummary(m: any) {
	const transcript: string = m.transcript ?? '';
	const truncated = transcript.length > LIST_TRANSCRIPT_CHARS;
	return {
		id: m._id,
		speaker: m.speaker?.username ?? null,
		kind: m.kind,
		experimentRef: m.experimentRef ?? null,
		tags: m.tags ?? [],
		matchedBy: m.matchedBy,
		title: m.title ?? null,
		recordedAt: m.recordedAt,
		transcript: truncated ? transcript.slice(0, LIST_TRANSCRIPT_CHARS) + '…' : transcript,
		transcriptTruncated: truncated,
		wordCount: transcript.trim() ? transcript.trim().split(/\s+/).length : 0,
		processed: !!m.processed,
		processedAt: m.processedAt ?? null,
		digestIds: m.digestIds ?? [],
		editedInVoicenotes: (m.revisions?.length ?? 0) > 0,
		deletedInVoicenotes: !!m.sourceDeletedAt,
		noteCount: m.notes?.length ?? 0
	};
}

export function memoFull(m: any, includeRaw = false) {
	return {
		id: m._id,
		source: m.source,
		sourceNoteId: m.sourceNoteId,
		speaker: m.speaker?.username ?? null,
		kind: m.kind,
		experimentRef: m.experimentRef ?? null,
		tags: m.tags ?? [],
		matchedBy: m.matchedBy,
		title: m.title ?? null,
		transcript: m.transcript ?? '',
		audioUrl: m.audioUrl ?? null,
		recordedAt: m.recordedAt,
		receivedAt: m.receivedAt,
		lastEvent: m.lastEvent ?? null,
		lastEventAt: m.lastEventAt ?? null,
		deletedInVoicenotesAt: m.sourceDeletedAt ?? null,
		processed: !!m.processed,
		processedAt: m.processedAt ?? null,
		processedBy: m.processedBy ?? null,
		digestIds: m.digestIds ?? [],
		linkedKanbanIds: m.linkedKanbanIds ?? [],
		notes: (m.notes ?? []).map((n: any) => ({ id: n._id, text: n.text, by: n.by, at: n.at })),
		revisions: m.revisions ?? [],
		...(includeRaw ? { raw: m.raw ?? null } : {})
	};
}

export function digestOut(d: any) {
	return {
		id: d._id,
		date: d.date,
		title: d.title,
		summary: d.summary,
		memoIds: d.memoIds ?? [],
		speakers: d.speakers ?? [],
		linkedKanbanIds: d.linkedKanbanIds ?? [],
		status: d.status,
		version: d.version,
		supersedes: d.supersedes ?? null,
		supersededBy: d.supersededBy ?? null,
		authoredBy: d.authoredBy,
		createdAt: d.createdAt
	};
}

/** Resolve the body's actor; a Response means "return this". */
export async function actorOrResponse(given: unknown): Promise<{ username: string } | Response> {
	try {
		return await resolveActor(typeof given === 'string' ? given : undefined);
	} catch (e) {
		if (e instanceof ActorError) return json({ success: false, error: e.message }, { status: 400 });
		throw e;
	}
}

export const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
