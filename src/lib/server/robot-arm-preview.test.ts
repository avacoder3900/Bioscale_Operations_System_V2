import { beforeEach, describe, expect, it } from 'vitest';
import { PreviewWriteError, forgetPreviewPath, resetPreviewPaths, writePreviewRecording, type PreviewArm } from './robot-arm-preview';

const NAME = 'animate-preview';
const PATH = 'datasets/animate-preview.jsonl';

/** A fake Pi: `updated` = recordings_admin.py with replace + path; otherwise the old route. */
function fakePi(opts: { updated: boolean; exists?: boolean; sessionActive?: boolean }) {
	let exists = opts.exists ?? true;
	const calls: string[] = [];
	const arm: PreviewArm = {
		async restoreRecording(body) {
			calls.push(body.replace ? 'restore+replace' : 'restore');
			if (exists && !(opts.updated && body.replace)) throw new Error(`robot-arm 409: a recording named '${body.name}' already exists`);
			if (exists && opts.sessionActive) throw new Error('robot-arm 409: a replay session is active — stop it before replacing recordings');
			const replaced = exists;
			exists = true;
			return opts.updated ? { restored: body.name, replaced, path: PATH } : { restored: body.name };
		},
		async deleteRecording() {
			calls.push('delete');
			if (!exists) throw new Error('robot-arm 404: recording not found');
			exists = false;
			return { deleted: NAME };
		},
		async listRecordings() {
			calls.push('list');
			return { recordings: exists ? [{ name: `${NAME}.jsonl`, path: PATH, size_bytes: 1, modified: '' }] : [] };
		}
	};
	return { arm, calls };
}

describe('writePreviewRecording (2026-11-05: fewer Pi calls before a play)', () => {
	beforeEach(() => resetPreviewPaths());

	it('updated Pi: one replacing upload, path from its answer, no delete and no listing', async () => {
		const { arm, calls } = fakePi({ updated: true });
		await expect(writePreviewRecording(arm, NAME, 'x', null)).resolves.toBe(PATH);
		expect(calls).toEqual(['restore+replace']);
	});

	it('old Pi: "already exists" falls back to delete + restore, listing only the first time', async () => {
		const { arm, calls } = fakePi({ updated: false });
		await expect(writePreviewRecording(arm, NAME, 'x', null)).resolves.toBe(PATH);
		expect(calls).toEqual(['restore+replace', 'delete', 'restore', 'list']);
		calls.length = 0;
		await expect(writePreviewRecording(arm, NAME, 'y', null)).resolves.toBe(PATH);
		expect(calls).toEqual(['restore+replace', 'delete', 'restore']);
	});

	it('old Pi with no file yet: the first upload simply works', async () => {
		const { arm, calls } = fakePi({ updated: false, exists: false });
		await expect(writePreviewRecording(arm, NAME, 'x', null)).resolves.toBe(PATH);
		expect(calls).toEqual(['restore+replace', 'list']);
	});

	it('a forgotten path is looked up again', async () => {
		const { arm, calls } = fakePi({ updated: false });
		await writePreviewRecording(arm, NAME, 'x', null);
		forgetPreviewPath(NAME);
		calls.length = 0;
		await writePreviewRecording(arm, NAME, 'y', null);
		expect(calls).toContain('list');
	});

	it('a session refusal is not mistaken for "already exists": no delete, the error says session', async () => {
		const { arm, calls } = fakePi({ updated: true, sessionActive: true });
		const err = await writePreviewRecording(arm, NAME, 'x', null).catch((e) => e);
		expect(err).toBeInstanceOf(PreviewWriteError);
		expect(String(err.message)).toMatch(/session is active/);
		expect(calls).toEqual(['restore+replace']);
	});
});
