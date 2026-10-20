import { describe, it, expect } from 'vitest';
import {
	parseVoicenotesPayload,
	classify,
	spokenTrigger,
	normalizeTags,
	allowlistFromEnv,
	DEFAULT_ALLOWLIST
} from './parse';

// The shape Voicenotes documents (help.voicenotes.com "Set up webhooks", 2026-10-19).
const DOCUMENTED = {
	event: 'recording.created',
	timestamp: '2026-10-19T17:42:00-05:00',
	data: { id: 'abc123', title: 'EOD wrap-up', transcript: 'EOD. Today I re-fit the 358 curves.' }
};

describe('parseVoicenotesPayload', () => {
	it('reads the documented shape', () => {
		const p = parseVoicenotesPayload(DOCUMENTED);
		expect(p).toMatchObject({
			event: 'recording.created',
			action: 'created',
			noteId: 'abc123',
			title: 'EOD wrap-up',
			transcript: 'EOD. Today I re-fit the 358 curves.',
			tags: [],
			audioUrl: null
		});
		expect(p.eventAt?.toISOString()).toBe('2026-10-19T22:42:00.000Z');
	});

	it('maps event names to actions', () => {
		const action = (event: string) => parseVoicenotesPayload({ event, data: { id: 'x' } }).action;
		expect(action('recording.updated')).toBe('updated');
		expect(action('recording.deleted')).toBe('deleted');
		expect(action('creation.summary')).toBe('other');
		expect(action('')).toBe('created');
	});

	it('tolerates likely variants: tags as objects, segment transcripts, epoch seconds, audio object', () => {
		const p = parseVoicenotesPayload({
			type: 'note.updated',
			note: {
				recording_id: 42,
				tags: [{ name: 'EOD' }, { name: '#Personal' }],
				transcript: [{ text: 'first' }, { text: 'second' }],
				created_at: 1760900000,
				audio: { url: 'https://cdn.example/a.m4a' }
			}
		});
		expect(p.noteId).toBe('42');
		expect(p.action).toBe('updated');
		expect(p.tags).toEqual(['eod', 'personal']);
		expect(p.transcript).toBe('first second');
		expect(p.recordedAt?.getTime()).toBe(1760900000 * 1000);
		expect(p.audioUrl).toBe('https://cdn.example/a.m4a');
	});

	it('never throws on junk', () => {
		expect(parseVoicenotesPayload(null).noteId).toBeNull();
		expect(parseVoicenotesPayload('nope').noteId).toBeNull();
		expect(parseVoicenotesPayload({ data: [] }).noteId).toBeNull();
	});
});

describe('normalizeTags', () => {
	it('lowercases, strips #, dedupes, accepts a comma string', () => {
		expect(normalizeTags('EOD, #eod ,exp-358')).toEqual(['eod', 'exp-358']);
	});
});

describe('spokenTrigger', () => {
	it.each(['EOD. Today…', 'eod update', 'E.O.D. —', 'End of day, so', 'End-of-the-day wrap', '  "EOD"'])('EOD: %s', (t) => {
		expect(spokenTrigger(t)).toMatchObject({ kind: 'eod', matchedBy: 'spoken' });
	});

	it.each([
		['Experiment 358, the curves…', '358'],
		['Exp 358-B notes', '358-B'],
		['experiment number 12', '12'],
		['Exp. #A4M2 run', 'A4M2']
	])('experiment: %s → %s', (t, ref) => {
		expect(spokenTrigger(t)).toMatchObject({ kind: 'experiment', experimentRef: ref });
	});

	it.each([
		'Grocery list: eggs',
		'Experimenting with a new recipe',
		'Experiment with the beads today',
		'Expensive 3 day trip',
		'Today, EOD-ish stuff',
		'Eodem'
	])('no match: %s', (t) => {
		expect(spokenTrigger(t)).toBeNull();
	});
});

describe('classify', () => {
	const base = parseVoicenotesPayload({ data: { id: '1' } });

	it('tag eod → eod', () => {
		expect(classify({ ...base, tags: ['eod'] }, DEFAULT_ALLOWLIST)).toEqual({ kind: 'eod', experimentRef: null, matchedBy: 'tag' });
	});

	it('tag exp-ABC123 → experiment ABC123, even alongside eod', () => {
		expect(classify({ ...base, tags: ['eod', 'exp-abc123'] }, DEFAULT_ALLOWLIST)).toEqual({
			kind: 'experiment',
			experimentRef: 'ABC123',
			matchedBy: 'tag'
		});
	});

	it('personal / untagged with no spoken lead-in → dropped', () => {
		expect(classify({ ...base, tags: ['personal'], title: 'Groceries', transcript: 'eggs' }, DEFAULT_ALLOWLIST)).toBeNull();
		expect(classify({ ...base, title: null, transcript: null }, DEFAULT_ALLOWLIST)).toBeNull();
	});

	it('falls back to a spoken lead-in in the title, then the transcript', () => {
		expect(classify({ ...base, title: 'EOD Oct 19' }, DEFAULT_ALLOWLIST)?.matchedBy).toBe('spoken');
		expect(classify({ ...base, title: 'Monday', transcript: 'Experiment 358 update' }, DEFAULT_ALLOWLIST)).toMatchObject({
			kind: 'experiment',
			experimentRef: '358'
		});
	});

	it('spoken triggers can be turned off', () => {
		expect(classify({ ...base, title: 'EOD' }, { ...DEFAULT_ALLOWLIST, spokenTriggers: false })).toBeNull();
	});
});

describe('allowlistFromEnv', () => {
	it('defaults when unset', () => {
		expect(allowlistFromEnv(undefined, undefined)).toEqual(DEFAULT_ALLOWLIST);
	});
	it('parses a custom list and the spoken switch', () => {
		expect(allowlistFromEnv('EOD, lab-*', 'false')).toEqual({ tags: ['eod', 'lab-*'], spokenTriggers: false });
	});
});
