/**
 * Unit tests for the UDI generator (SPU-MFG-01).
 *
 * No live MongoDB dependency is required: we stub the two model modules
 * (`UdiCounter` and `GeneratedBarcode`) with an in-memory counter so the
 * sequencing contract can be verified without spinning up a database.
 *
 * The concurrency test is marked `.skip` with a pointer to SPU-MFG-10, as
 * required by the task spec — an in-memory Mongo stub cannot faithfully
 * reproduce MongoDB's atomic `$inc`+upsert semantics, and `mongodb-memory-server`
 * is not currently a project dependency.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory counter store and captured barcode inserts, mutated by the mock.
const counterStore = new Map<string, number>();
const createdBarcodes: Array<Record<string, unknown>> = [];

vi.mock('./models/index.js', () => {
	return {
		UdiCounter: {
			findOneAndUpdate: vi.fn((filter: { _id: string }, update: { $inc: { sequence: number } }) => {
				const prefix = filter._id;
				const next = (counterStore.get(prefix) ?? 0) + update.$inc.sequence;
				counterStore.set(prefix, next);
				const doc = { _id: prefix, sequence: next };
				// Mongoose query chain: .lean() returns a thenable resolving to the doc.
				return {
					lean: () => Promise.resolve(doc)
				};
			}),
			findById: vi.fn((prefix: string) => {
				const seq = counterStore.get(prefix);
				const doc = seq === undefined ? null : { _id: prefix, sequence: seq };
				return {
					lean: () => Promise.resolve(doc)
				};
			})
		},
		GeneratedBarcode: {
			create: vi.fn(async (doc: Record<string, unknown>) => {
				createdBarcodes.push(doc);
				return doc;
			})
		}
	};
});

// Import AFTER the mock is registered.
import { getNextUdi, peekNextUdi } from './udi-generator.js';

beforeEach(() => {
	counterStore.clear();
	createdBarcodes.length = 0;
});

describe('getNextUdi', () => {
	it('returns a BT-M01-0000-0001 formatted UDI on first call with default prefix', async () => {
		const { udi, sequence } = await getNextUdi();
		expect(sequence).toBe(1);
		expect(udi).toBe('BT-M01-0000-0001');
	});

	it('yields strictly increasing sequences on sequential calls', async () => {
		const first = await getNextUdi();
		const second = await getNextUdi();
		const third = await getNextUdi();
		expect(first.sequence).toBe(1);
		expect(second.sequence).toBe(2);
		expect(third.sequence).toBe(3);
		expect(first.udi).toBe('BT-M01-0000-0001');
		expect(second.udi).toBe('BT-M01-0000-0002');
		expect(third.udi).toBe('BT-M01-0000-0003');
	});

	it('records a GeneratedBarcode row of type "spu-udi" per call', async () => {
		await getNextUdi();
		await getNextUdi('BATCH');
		expect(createdBarcodes).toHaveLength(2);
		expect(createdBarcodes[0]).toMatchObject({
			prefix: 'BT-M01',
			sequence: 1,
			barcode: 'BT-M01-0000-0001',
			type: 'spu-udi'
		});
		expect(createdBarcodes[1]).toMatchObject({
			prefix: 'BATCH',
			sequence: 1,
			barcode: 'BATCH-0000-0001',
			type: 'spu-udi'
		});
	});

	it('keeps per-prefix sequences independent', async () => {
		const a1 = await getNextUdi('BT-M01');
		const b1 = await getNextUdi('ALT');
		const a2 = await getNextUdi('BT-M01');
		expect(a1.sequence).toBe(1);
		expect(b1.sequence).toBe(1);
		expect(a2.sequence).toBe(2);
		expect(a1.udi).toBe('BT-M01-0000-0001');
		expect(b1.udi).toBe('ALT-0000-0001');
		expect(a2.udi).toBe('BT-M01-0000-0002');
	});

	it('crosses the 4-digit boundary at counter 10000 → BT-M01-0001-0000', async () => {
		// Seed counter to 9999 so the next allocation lands on 10000 exactly.
		counterStore.set('BT-M01', 9999);
		expect(await peekNextUdi()).toBe('BT-M01-0001-0000');
		const at = await getNextUdi();
		expect(at.sequence).toBe(10000);
		expect(at.udi).toBe('BT-M01-0001-0000');
		const after = await getNextUdi();
		expect(after.sequence).toBe(10001);
		expect(after.udi).toBe('BT-M01-0001-0001');
	});
});

describe('peekNextUdi', () => {
	it('returns BT-M01-0000-0001 when no counter exists yet and does not create one', async () => {
		const preview = await peekNextUdi();
		expect(preview).toBe('BT-M01-0000-0001');
		// No counter mutated.
		expect(counterStore.has('BT-M01')).toBe(false);
	});

	it('does NOT advance the counter', async () => {
		await getNextUdi(); // counter -> 1
		const previewA = await peekNextUdi();
		const previewB = await peekNextUdi();
		expect(previewA).toBe('BT-M01-0000-0002');
		expect(previewB).toBe('BT-M01-0000-0002');
		// Subsequent real allocation must still receive sequence=2.
		const next = await getNextUdi();
		expect(next.sequence).toBe(2);
		expect(next.udi).toBe('BT-M01-0000-0002');
	});

	it('reflects the current prefix-scoped counter', async () => {
		await getNextUdi('BT-M01');
		await getNextUdi('BT-M01');
		await getNextUdi('ALT');
		expect(await peekNextUdi('BT-M01')).toBe('BT-M01-0000-0003');
		expect(await peekNextUdi('ALT')).toBe('ALT-0000-0002');
		expect(await peekNextUdi('NEW')).toBe('NEW-0000-0001');
	});
});

describe('getNextUdi — concurrency (live MongoDB)', () => {
	// Deferred: the in-memory mock cannot faithfully model MongoDB's atomic
	// $inc+upsert semantics, and `mongodb-memory-server` is not a project dep.
	// Re-enable as part of SPU-MFG-10 once shared test-DB infra lands.
	it.skip('Promise.all of three getNextUdi() calls yields three distinct UDIs', async () => {
		const results = await Promise.all([getNextUdi(), getNextUdi(), getNextUdi()]);
		const udis = new Set(results.map((r) => r.udi));
		const sequences = new Set(results.map((r) => r.sequence));
		expect(udis.size).toBe(3);
		expect(sequences.size).toBe(3);
	});
});
