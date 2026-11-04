import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, Buffer>();
let corrupt = false;
vi.mock('$lib/server/services/r2', () => ({
	uploadViaWorker: vi.fn(async (b: Buffer, key: string) => {
		store.set(key, corrupt ? b.subarray(0, Math.max(0, b.length - 1)) : b);
		return key;
	}),
	downloadViaWorker: vi.fn(async (key: string) => {
		const b = store.get(key);
		if (!b) throw new Error(`worker download ${key} → 404`);
		return b;
	})
}));

const { uploadVerified } = await import('./robot-arm-archive');

describe('uploadVerified (R2 copy proven before any delete)', () => {
	beforeEach(() => {
		store.clear();
		corrupt = false;
	});

	it('passes when R2 hands back exactly what was uploaded', async () => {
		await expect(uploadVerified(Buffer.from('{"a":1}'), 'k', 'application/json')).resolves.toBeUndefined();
	});

	it('throws when the copy read back differs, so the caller never deletes', async () => {
		corrupt = true;
		await expect(uploadVerified(Buffer.from('{"a":1}'), 'k', 'application/json')).rejects.toThrow(/does not match/);
	});
});
