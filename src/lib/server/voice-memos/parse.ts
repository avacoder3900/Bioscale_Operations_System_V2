/**
 * VOICE-01: Voicenotes webhook payload parsing + the allowlist.
 *
 * Pure functions — no DB, no env — so they are unit-tested in parse.test.ts.
 *
 * THE PAYLOAD SHAPE IS NOT CONFIRMED. Voicenotes documents only
 *   { event: "recording.created", timestamp, data: { id, title, transcript } }
 * (help.voicenotes.com "Set up webhooks", checked 2026-10-19) — no tags, no
 * audio URL, no update/delete event names. So the parser is deliberately
 * tolerant: it looks in the documented place first and a few likely ones after.
 * Run with VOICENOTES_CAPTURE_RAW=true for the first real notes, read
 * voice_memo_captures, and tighten this file against what actually arrives.
 *
 * Allowlist, not blocklist: a note is stored only if it carries an allowed tag
 * OR opens with a spoken trigger ("EOD …", "Experiment 358 …"). The spoken
 * trigger is the fallback for the likely case that tags are not in the payload.
 */

export type VoicenotesAction = 'created' | 'updated' | 'deleted' | 'other';

export interface ParsedVoicenote {
	event: string;
	action: VoicenotesAction;
	noteId: string | null;
	title: string | null;
	transcript: string | null;
	tags: string[];
	recordedAt: Date | null;
	eventAt: Date | null;
	audioUrl: string | null;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function str(v: unknown): string | null {
	if (typeof v === 'string') return v.trim() === '' ? null : v;
	if (typeof v === 'number') return String(v);
	return null;
}

function firstStr(...vals: unknown[]): string | null {
	for (const v of vals) {
		const s = str(v);
		if (s !== null) return s;
	}
	return null;
}

function date(v: unknown): Date | null {
	if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
	if (typeof v === 'number') {
		// Seconds vs milliseconds epoch.
		const d = new Date(v < 1e12 ? v * 1000 : v);
		return isNaN(d.getTime()) ? null : d;
	}
	if (typeof v === 'string' && v.trim()) {
		const d = new Date(v);
		return isNaN(d.getTime()) ? null : d;
	}
	return null;
}

function firstDate(...vals: unknown[]): Date | null {
	for (const v of vals) {
		const d = date(v);
		if (d) return d;
	}
	return null;
}

/** Tags may arrive as strings, as {name}/{title}/{tag} objects, or as one comma string. */
export function normalizeTags(v: unknown): string[] {
	let list: unknown[] = [];
	if (Array.isArray(v)) list = v;
	else if (typeof v === 'string') list = v.split(',');
	const out: string[] = [];
	for (const item of list) {
		const name = isObj(item) ? firstStr(item.name, item.title, item.tag, item.label) : str(item);
		if (!name) continue;
		const t = name.trim().replace(/^#/, '').toLowerCase();
		if (t && !out.includes(t)) out.push(t);
	}
	return out;
}

/** Transcripts may be a string, or an array of segments with text. */
function transcriptOf(v: unknown): string | null {
	if (typeof v === 'string') return v.trim() === '' ? null : v;
	if (Array.isArray(v)) {
		const parts = v
			.map((seg) => (typeof seg === 'string' ? seg : isObj(seg) ? firstStr(seg.text, seg.content) : null))
			.filter((s): s is string => !!s);
		return parts.length ? parts.join(' ') : null;
	}
	return null;
}

export function actionOf(event: string): VoicenotesAction {
	const e = event.toLowerCase();
	// "creation.summary" etc. are AI creations about a note, not the note itself.
	if (e.startsWith('creation')) return 'other';
	if (e.includes('delete')) return 'deleted';
	if (e.includes('update') || e.includes('edit')) return 'updated';
	if (e.includes('create') || e === '') return 'created';
	return 'other';
}

export function parseVoicenotesPayload(body: unknown): ParsedVoicenote {
	const root: Obj = isObj(body) ? body : {};
	const data: Obj =
		(isObj(root.data) && root.data) ||
		(isObj(root.note) && root.note) ||
		(isObj(root.recording) && root.recording) ||
		root;

	const event = firstStr(root.event, root.type, root.event_type, root.eventType) ?? '';
	const audio = isObj(data.audio) ? data.audio : {};

	return {
		event,
		action: actionOf(event),
		noteId: firstStr(data.id, data.recording_id, data.recordingId, data.note_id, data.noteId, data.uuid),
		title: firstStr(data.title, data.name),
		transcript: transcriptOf(data.transcript ?? data.text ?? data.content ?? data.body),
		tags: normalizeTags(data.tags ?? root.tags),
		recordedAt: firstDate(data.created_at, data.createdAt, data.recorded_at, data.recordedAt, data.date),
		eventAt: firstDate(root.timestamp, root.created_at, root.sent_at),
		audioUrl: firstStr(data.audio_url, data.audioUrl, data.recording_url, data.recordingUrl, audio.url, audio.src)
	};
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

export interface AllowlistConfig {
	/** Exact tags, or prefixes ending in '*' ("exp-*"). Lowercase. */
	tags: string[];
	/** Accept spoken lead-ins when no tag matched. */
	spokenTriggers: boolean;
}

export const DEFAULT_ALLOWLIST: AllowlistConfig = { tags: ['eod', 'exp-*'], spokenTriggers: true };

/** Build the config from env strings (VOICENOTES_TAGS, VOICENOTES_SPOKEN_TRIGGERS). */
export function allowlistFromEnv(tagsVar?: string, spokenVar?: string): AllowlistConfig {
	const tags = tagsVar?.trim()
		? tagsVar.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
		: DEFAULT_ALLOWLIST.tags;
	const spokenTriggers = spokenVar?.trim() ? spokenVar.trim().toLowerCase() !== 'false' : true;
	return { tags, spokenTriggers };
}

export interface Classification {
	kind: 'eod' | 'experiment';
	experimentRef: string | null;
	matchedBy: 'tag' | 'spoken';
}

function tagMatches(tag: string, pattern: string): boolean {
	return pattern.endsWith('*') ? tag.startsWith(pattern.slice(0, -1)) : tag === pattern;
}

/** Experiment ref from a tag like exp-ABC123 / exp_358 / exp358. */
function experimentRefFromTag(tag: string): string | null {
	const m = /^exp(?:eriment)?[-_:]+(.+)$/i.exec(tag) ?? /^exp(?:eriment)?(\d[\w-]*)$/i.exec(tag);
	return m ? m[1].toUpperCase() : null;
}

/**
 * Spoken lead-ins, matched against the start of the title then the transcript.
 * Accepts e.g. "EOD.", "E.O.D", "End of day,", "End-of-day update",
 * "Experiment 358", "Exp 358-B". Voicenotes auto-titles notes from their first
 * words, so a title match is the common case.
 */
const EOD_LEAD = /^\W*(?:e\.?\s?o\.?\s?d\b\.?|end[\s-]+of[\s-]+(?:the[\s-]+)?day\b)/i;
// The ref must contain a digit, so "Experimenting with…" / "Experiment with the beads" never match.
const EXP_LEAD = /^\W*(?:experiment|exp)\b\.?\s*(?:number\s+|no\.?\s*|#\s*)?([a-z]*\d[a-z0-9-]*)/i;

export function spokenTrigger(text: string | null): Classification | null {
	if (!text) return null;
	const head = text.slice(0, 120);
	if (EOD_LEAD.test(head)) return { kind: 'eod', experimentRef: null, matchedBy: 'spoken' };
	const m = EXP_LEAD.exec(head);
	if (m) return { kind: 'experiment', experimentRef: m[1].toUpperCase(), matchedBy: 'spoken' };
	return null;
}

/** null = not allowlisted: drop it, store nothing. */
export function classify(note: ParsedVoicenote, cfg: AllowlistConfig): Classification | null {
	const matched = note.tags.filter((t) => cfg.tags.some((p) => tagMatches(t, p)));
	if (matched.length) {
		const expTag = matched.find((t) => experimentRefFromTag(t) && t !== 'eod');
		if (expTag) return { kind: 'experiment', experimentRef: experimentRefFromTag(expTag), matchedBy: 'tag' };
		return { kind: 'eod', experimentRef: null, matchedBy: 'tag' };
	}
	if (!cfg.spokenTriggers) return null;
	return spokenTrigger(note.title) ?? spokenTrigger(note.transcript);
}
