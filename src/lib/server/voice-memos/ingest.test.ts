import { beforeEach, describe, expect, it, vi } from 'vitest';

// ingestVoicenote against an in-memory voice_memos stand-in.
const state = vi.hoisted(() => ({ memos: [] as any[], audits: [] as any[], n: 0 }));

function applyUpdate(doc: any, u: any) {
	Object.assign(doc, u.$set ?? {});
	for (const [k, v] of Object.entries(u.$push ?? {})) (doc[k] ??= []).push(v);
}

vi.mock('$lib/server/db', () => ({
	VoiceMemo: {
		findOne: (q: any) => ({ lean: async () => state.memos.find((m) => m.sourceNoteId === q.sourceNoteId) ?? null }),
		updateOne: vi.fn(async (q: any, u: any) => applyUpdate(state.memos.find((m) => m._id === q._id), u)),
		create: vi.fn(async (row: any) => {
			if (state.memos.some((m) => m.sourceNoteId === row.sourceNoteId)) throw Object.assign(new Error('dup'), { code: 11000 });
			state.memos.push({ revisions: [], processed: false, ...structuredClone(row) });
		})
	},
	AuditLog: { create: vi.fn(async (row: any) => state.audits.push(row)) },
	generateId: () => `id${++state.n}`
}));

import { ingestVoicenote } from './ingest';
import { parseVoicenotesPayload, DEFAULT_ALLOWLIST } from './parse';

const jacob = { _id: 'u1', username: 'jacobq' };
const send = (body: any, speaker = jacob) =>
	ingestVoicenote({ parsed: parseVoicenotesPayload(body), speaker, raw: body, allowlist: DEFAULT_ALLOWLIST });
const note = (event: string, data: any) => ({ event, timestamp: '2026-10-19T22:00:00Z', data: { id: 'n1', ...data } });

beforeEach(() => Object.assign(state, { memos: [], audits: [], n: 0 }));

describe('ingestVoicenote', () => {
	it('stores an EOD note once; a redelivery is a no-op', async () => {
		const body = note('recording.created', { title: 'EOD Oct 19', transcript: 'EOD. Re-fit 358.' });
		expect(await send(body)).toEqual({ outcome: 'created', memoId: 'id1' });
		expect(await send(body)).toMatchObject({ outcome: 'unchanged' });
		expect(state.memos).toHaveLength(1);
		expect(state.memos[0]).toMatchObject({ kind: 'eod', matchedBy: 'title', speaker: jacob, transcript: 'EOD. Re-fit 358.' });
		expect(state.audits.map((a) => a.action)).toEqual(['INSERT']);
	});

	it('exp-ABC123 tag → experiment ABC123', async () => {
		await send(note('recording.created', { title: 'Run', transcript: 'beads', tags: ['exp-ABC123'] }));
		expect(state.memos[0]).toMatchObject({ kind: 'experiment', experimentRef: 'ABC123', matchedBy: 'tag' });
	});

	it('drops a personal note and persists nothing', async () => {
		expect(await send(note('recording.created', { title: 'Groceries', transcript: 'eggs, milk' }))).toEqual({ outcome: 'dropped' });
		expect(state.memos).toHaveLength(0);
		expect(state.audits).toHaveLength(0);
	});

	it('a note tagged after recording is stored when the update arrives', async () => {
		expect((await send(note('recording.created', { title: 'Monday', transcript: 'stuff' }))).outcome).toBe('dropped');
		expect((await send(note('recording.updated', { title: 'Monday', transcript: 'stuff', tags: ['eod'] }))).outcome).toBe('created');
		expect(state.memos[0].kind).toBe('eod');
	});

	it('an edit keeps the old transcript in revisions and reopens a processed memo', async () => {
		await send(note('recording.created', { title: 'EOD', transcript: 'EOD. 385 lot.' }));
		state.memos[0].processed = true;
		expect((await send(note('recording.updated', { transcript: 'EOD. 358 lot.' }))).outcome).toBe('updated');
		const m = state.memos[0];
		expect(m.transcript).toBe('EOD. 358 lot.');
		expect(m.title).toBe('EOD'); // omitted field keeps its value
		expect(m.revisions).toEqual([expect.objectContaining({ transcript: 'EOD. 385 lot.', title: 'EOD' })]);
		expect(m.processed).toBe(false);
	});

	it('a delete flags the memo and keeps it', async () => {
		await send(note('recording.created', { title: 'EOD', transcript: 'EOD.' }));
		expect((await send(note('recording.deleted', {}))).outcome).toBe('flagged-deleted');
		expect(state.memos[0].sourceDeletedAt).toBeInstanceOf(Date);
		expect(state.memos[0].transcript).toBe('EOD.');
		expect((await send(note('recording.deleted', {}))).outcome).toBe('unchanged');
	});

	it("another speaker's key cannot rewrite a memo", async () => {
		await send(note('recording.created', { title: 'EOD', transcript: 'EOD.' }));
		const other = { _id: 'u2', username: 'other' };
		expect((await send(note('recording.updated', { transcript: 'EOD. changed' }), other)).outcome).toBe('conflict');
		expect(state.memos[0].transcript).toBe('EOD.');
	});

	it('ignores AI creations and payloads without a note id', async () => {
		expect((await send({ event: 'creation.summary', data: { id: 's1', content: 'x' } })).outcome).toBe('ignored');
		expect((await send({ event: 'recording.created', data: { title: 'EOD' } })).outcome).toBe('invalid');
	});
});
