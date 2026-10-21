import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * Voice memos (VOICE-01) — spoken end-of-day / experiment notes recorded in the
 * Voicenotes app and delivered here by its webhook (/api/webhooks/voicenotes).
 *
 * Three collections, three jobs:
 *
 *   voice_memos          The record. One doc per Voicenotes note, keyed by the
 *                        note id. The transcript is never overwritten: when
 *                        Voicenotes sends an update, the previous title /
 *                        transcript / tags move to revisions[] first. There is
 *                        no delete path — a note deleted in Voicenotes is only
 *                        flagged (sourceDeletedAt). Annotations append to notes[].
 *
 *   voice_memo_digests   What people read. Claude (over MCP) reads the memos,
 *                        pulls BIMS context, and files a readable summary for a
 *                        day. Rewrites supersede — the old version is kept.
 *                        Rendered at /kanban/journal.
 *
 *   voice_memo_captures  Step-0 debug capture: the raw webhook body, written
 *                        ONLY while VOICENOTES_CAPTURE_RAW=true, TTL 14 days.
 *                        Exists so the parser can be checked against what
 *                        Voicenotes really sends. Off in steady state, because
 *                        it would also hold notes the allowlist rejects.
 */

const revisionSchema = new Schema(
	{
		title: { type: String, default: null },
		transcript: { type: String, default: null },
		tags: { type: [String], default: [] },
		replacedAt: { type: Date, required: true },
		event: { type: String, default: null }
	},
	{ _id: false }
);

const noteSchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },
		text: { type: String, required: true },
		by: { type: String, required: true },
		at: { type: Date, required: true }
	}
);

const voiceMemoSchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },
		source: { type: String, default: 'voicenotes' },
		sourceNoteId: { type: String, required: true },

		speaker: {
			_id: { type: String, required: true },
			username: { type: String, required: true }
		},

		tags: { type: [String], default: [] },
		kind: { type: String, enum: ['eod', 'experiment'], required: true },
		experimentRef: { type: String, default: null },
		/** How the allowlist matched: a Voicenotes tag, or a spoken lead-in ("EOD …"). */
		matchedBy: { type: String, enum: ['tag', 'title', 'spoken'], required: true },

		title: { type: String, default: null },
		transcript: { type: String, default: '' },
		revisions: { type: [revisionSchema], default: [] },

		audioUrl: { type: String, default: null },

		recordedAt: { type: Date, required: true },
		receivedAt: { type: Date, required: true },
		lastEventAt: { type: Date, required: true },
		lastEvent: { type: String, default: null },
		sourceDeletedAt: { type: Date, default: null },

		processed: { type: Boolean, default: false },
		processedAt: { type: Date, default: null },
		processedBy: { type: String, default: null },
		digestIds: { type: [String], default: [] },
		linkedKanbanIds: { type: [String], default: [] },

		notes: { type: [noteSchema], default: [] },

		/** Latest raw webhook body, verbatim. */
		raw: { type: Schema.Types.Mixed, default: null }
	},
	{ timestamps: true, collection: 'voice_memos', minimize: false }
);

voiceMemoSchema.index({ sourceNoteId: 1 }, { unique: true });
voiceMemoSchema.index({ processed: 1, recordedAt: -1 });
voiceMemoSchema.index({ 'speaker.username': 1, recordedAt: -1 });
voiceMemoSchema.index({ tags: 1 });

export const VoiceMemo =
	mongoose.models.VoiceMemo || mongoose.model('VoiceMemo', voiceMemoSchema, 'voice_memos');

const voiceMemoDigestSchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },
		/** Calendar day the digest covers, YYYY-MM-DD (US Central — the lab's day). */
		date: { type: String, required: true },
		title: { type: String, required: true },
		/** Markdown. Rendered with a small escape-first renderer, never raw HTML. */
		summary: { type: String, required: true },

		memoIds: { type: [String], default: [] },
		speakers: { type: [String], default: [] },
		linkedKanbanIds: { type: [String], default: [] },

		status: { type: String, enum: ['current', 'superseded'], default: 'current' },
		version: { type: Number, default: 1 },
		supersedes: { type: String, default: null },
		supersededBy: { type: String, default: null },

		authoredBy: { type: String, required: true },
		filedVia: { type: String, default: 'mcp' }
	},
	{ timestamps: true, collection: 'voice_memo_digests' }
);

voiceMemoDigestSchema.index({ status: 1, date: -1 });
voiceMemoDigestSchema.index({ memoIds: 1 });

export const VoiceMemoDigest =
	mongoose.models.VoiceMemoDigest ||
	mongoose.model('VoiceMemoDigest', voiceMemoDigestSchema, 'voice_memo_digests');

const voiceMemoCaptureSchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },
		receivedAt: { type: Date, default: () => new Date(), expires: 60 * 60 * 24 * 14 },
		speaker: { type: String, default: null },
		event: { type: String, default: null },
		outcome: { type: String, default: null },
		body: { type: Schema.Types.Mixed, default: null }
	},
	{ collection: 'voice_memo_captures', versionKey: false, minimize: false }
);

export const VoiceMemoCapture =
	mongoose.models.VoiceMemoCapture ||
	mongoose.model('VoiceMemoCapture', voiceMemoCaptureSchema, 'voice_memo_captures');
