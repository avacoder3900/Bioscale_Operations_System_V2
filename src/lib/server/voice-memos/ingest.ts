/**
 * VOICE-01: apply one Voicenotes webhook event to voice_memos.
 *
 * Rules (see models/voice-memo.ts for the record's contract):
 * - Idempotent on the Voicenotes note id. A redelivery with nothing new is a no-op.
 * - Created OR updated events can create a memo: a note recorded untagged and
 *   tagged afterwards arrives as an update, and is stored then.
 * - An update never overwrites history: the previous title/transcript/tags go
 *   to revisions[] first. A changed transcript reopens a processed memo so the
 *   digest gets rewritten.
 * - Fields the payload omits keep their stored value (the documented payload has
 *   no tags at all, so absence cannot mean "tag removed").
 * - Deleted in Voicenotes → flagged, never removed. The memo is a record.
 * - A memo belongs to the KEY that first delivered it (deliveredBy); another key
 *   cannot rewrite it.
 * - The speaker is the person named by the initials in the title ("EOD GV"),
 *   else the key's owner. Retitling a note with different initials moves it to
 *   that person; removing the initials leaves it where it is.
 */
import { VoiceMemo, AuditLog, generateId } from '$lib/server/db';
import { classify, type AllowlistConfig, type ParsedVoicenote } from './parse';

export type IngestOutcome =
	| 'created'
	| 'updated'
	| 'unchanged'
	| 'dropped'
	| 'flagged-deleted'
	| 'ignored'
	| 'invalid'
	| 'conflict';

export interface Speaker {
	_id: string;
	username: string;
}

const sameTags = (a: string[], b: string[]) => a.length === b.length && a.every((t, i) => t === b[i]);

export async function ingestVoicenote(opts: {
	parsed: ParsedVoicenote;
	speaker: Speaker;
	raw: unknown;
	allowlist: AllowlistConfig;
	/** Username of the webhook key that delivered this. Defaults to the speaker. */
	deliveredBy?: string;
	/** Set when the speaker was resolved from initials in the title ("EOD GV" → "GV"). */
	initials?: string | null;
	now?: Date;
}): Promise<{ outcome: IngestOutcome; memoId?: string }> {
	const { parsed, speaker, raw, allowlist } = opts;
	const now = opts.now ?? new Date();
	const deliveredBy = opts.deliveredBy ?? speaker.username;
	const initials = opts.initials ?? null;
	const changedBy = `voicenotes-webhook:${deliveredBy}`;

	if (parsed.action === 'other') return { outcome: 'ignored' };
	if (!parsed.noteId) return { outcome: 'invalid' };

	const existing: any = await VoiceMemo.findOne({ sourceNoteId: parsed.noteId }).lean();

	// Memos stored before deliveredBy existed were always delivered by their speaker's key.
	if (existing && (existing.deliveredBy ?? existing.speaker?.username) !== deliveredBy) {
		return { outcome: 'conflict', memoId: existing._id };
	}

	// ---- deleted ---------------------------------------------------------------
	if (parsed.action === 'deleted') {
		if (!existing) return { outcome: 'ignored' };
		if (existing.sourceDeletedAt) return { outcome: 'unchanged', memoId: existing._id };
		await VoiceMemo.updateOne(
			{ _id: existing._id },
			{ $set: { sourceDeletedAt: now, lastEventAt: now, lastEvent: parsed.event } }
		);
		await AuditLog.create({
			_id: generateId(),
			tableName: 'voice_memos',
			recordId: existing._id,
			action: 'UPDATE',
			changedFields: { sourceDeletedAt: now },
			reason: 'Note deleted in Voicenotes — flagged, record kept',
			changedAt: now,
			changedBy
		});
		return { outcome: 'flagged-deleted', memoId: existing._id };
	}

	// ---- created / updated, existing memo --------------------------------------
	if (existing) {
		const next = {
			title: parsed.title ?? existing.title ?? null,
			transcript: parsed.transcript ?? existing.transcript ?? '',
			tags: parsed.tags.length ? parsed.tags : (existing.tags ?? [])
		};
		const transcriptChanged = next.transcript !== (existing.transcript ?? '');
		// Only initials move a memo: an edit that drops them leaves the speaker alone.
		const speakerChanged = !!initials && existing.speaker?.username !== speaker.username;
		const changed =
			transcriptChanged ||
			speakerChanged ||
			next.title !== (existing.title ?? null) ||
			!sameTags(next.tags, existing.tags ?? []);

		if (!changed) {
			await VoiceMemo.updateOne({ _id: existing._id }, { $set: { lastEventAt: now, lastEvent: parsed.event } });
			return { outcome: 'unchanged', memoId: existing._id };
		}

		// Re-derive kind from the new content; if it no longer matches the
		// allowlist the memo is still kept (it is a record) under its old kind.
		const cls = classify({ ...parsed, ...next }, allowlist);
		const set: Record<string, unknown> = {
			...next,
			raw,
			audioUrl: parsed.audioUrl ?? existing.audioUrl ?? null,
			lastEventAt: now,
			lastEvent: parsed.event
		};
		if (cls) Object.assign(set, { kind: cls.kind, experimentRef: cls.experimentRef, matchedBy: cls.matchedBy });
		if (speakerChanged) Object.assign(set, { speaker, initials, speakerSource: 'initials' });
		if (transcriptChanged && existing.processed) Object.assign(set, { processed: false, processedAt: null, processedBy: null });

		await VoiceMemo.updateOne(
			{ _id: existing._id },
			{
				$set: set,
				$push: {
					revisions: {
						title: existing.title ?? null,
						transcript: existing.transcript ?? null,
						tags: existing.tags ?? [],
						replacedAt: now,
						event: parsed.event || null
					}
				}
			}
		);
		await AuditLog.create({
			_id: generateId(),
			tableName: 'voice_memos',
			recordId: existing._id,
			action: 'UPDATE',
			oldData: {
				title: existing.title,
				tags: existing.tags,
				transcriptLength: (existing.transcript ?? '').length,
				...(speakerChanged ? { speaker: existing.speaker?.username } : {})
			},
			newData: {
				title: next.title,
				tags: next.tags,
				transcriptLength: next.transcript.length,
				...(speakerChanged ? { speaker: speaker.username, initials } : {})
			},
			reason:
				(transcriptChanged && existing.processed ? 'Edited in Voicenotes — reopened for digest' : 'Edited in Voicenotes') +
				(speakerChanged ? ` — moved to ${speaker.username} by title initials` : ''),
			changedAt: now,
			changedBy
		});
		return { outcome: 'updated', memoId: existing._id };
	}

	// ---- created / updated, new memo -------------------------------------------
	const cls = classify(parsed, allowlist);
	if (!cls) return { outcome: 'dropped' };

	const memoId = generateId();
	try {
		await VoiceMemo.create({
			_id: memoId,
			source: 'voicenotes',
			sourceNoteId: parsed.noteId,
			speaker,
			initials,
			speakerSource: initials ? 'initials' : 'key',
			deliveredBy,
			tags: parsed.tags,
			kind: cls.kind,
			experimentRef: cls.experimentRef,
			matchedBy: cls.matchedBy,
			title: parsed.title,
			transcript: parsed.transcript ?? '',
			audioUrl: parsed.audioUrl,
			recordedAt: parsed.recordedAt ?? parsed.eventAt ?? now,
			receivedAt: now,
			lastEventAt: now,
			lastEvent: parsed.event || null,
			raw
		});
	} catch (e: any) {
		// Two deliveries of the same note racing: the unique index lets one win.
		if (e?.code === 11000) return { outcome: 'unchanged' };
		throw e;
	}

	await AuditLog.create({
		_id: generateId(),
		tableName: 'voice_memos',
		recordId: memoId,
		action: 'INSERT',
		newData: {
			sourceNoteId: parsed.noteId,
			speaker: speaker.username,
			initials,
			deliveredBy,
			kind: cls.kind,
			experimentRef: cls.experimentRef,
			matchedBy: cls.matchedBy,
			tags: parsed.tags
		},
		changedAt: now,
		changedBy
	});
	return { outcome: 'created', memoId };
}
