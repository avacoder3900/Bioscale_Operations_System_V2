/**
 * Golden test for the QUEUE-line sweep progress route (OT2-BRIDGE-2):
 *   POST /api/agent/ot2/commands/:id/progress
 *
 * Pins, field for field, the OpentronsScannerSweepRun update this route writes
 * for each shape of daemon body. The literals below were captured from the
 * route BEFORE it was folded onto the shared sweepProgressUpdate()
 * (../../../jobs/sweep-progress.ts, which the tailnet-line jobs route also
 * uses) — so this test passing on both versions is the proof that the queue
 * line writes byte-identical records.
 */
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

const updates: { id: string; update: any; opts: any }[] = [];
const reads: string[] = [];
let cmdStatus: string | null = 'claimed';
let run: any = { pauseRequested: false, cancelRequested: false, status: 'running' };

vi.mock('$lib/server/api-auth', () => ({
	requireAgentApiKey: (req: Request) => {
		if (req.headers.get('x-agent-api-key') !== 'k') throw Object.assign(new Error('Unauthorized'), { status: 401 });
	}
}));
vi.mock('$lib/server/db', () => {
	const q = (v: () => any) => ({ select: () => ({ lean: async () => v() }) });
	return {
		connectDB: async () => {},
		Ot2BridgeCommand: { findById: (_id: string) => q(() => (cmdStatus ? { status: cmdStatus } : null)) },
		OpentronsScannerSweepRun: {
			findByIdAndUpdate: (id: string, update: any, opts: any) => {
				updates.push({ id, update, opts });
				return q(() => run);
			},
			findById: (id: string) => {
				reads.push(id);
				return q(() => run);
			}
		}
	};
});

import { POST } from './+server';
import { sweepProgressUpdate } from '../../../jobs/sweep-progress';

const NOW = new Date('2026-09-26T12:00:00.000Z');

function post(body: unknown) {
	return (POST as any)({
		params: { id: 'cmd1' },
		request: new Request('https://bims.example/api/agent/ot2/commands/cmd1/progress', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-agent-api-key': 'k' },
			body: JSON.stringify(body)
		})
	}) as Promise<Response>;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	updates.length = 0;
	reads.length = 0;
	cmdStatus = 'claimed';
	run = { pauseRequested: false, cancelRequested: false, status: 'running' };
});
afterEach(() => vi.useRealTimers());

/** body → the exact update document the route must write. */
const CASES: Array<{ name: string; body: any; update: any }> = [
	{
		name: 'slot counters only',
		body: { sweepRunId: 'sw1', slotsDone: 3, currentSlotIndex: 4 },
		update: { $set: { slotsDone: 3, currentSlotIndex: 4 } }
	},
	{
		name: 'a scan (rawPayload/attempts defaulted, barcode stringified)',
		body: { sweepRunId: 'sw1', slotsDone: 1, scan: { slotIndex: 0, barcode: 12345, x: 1, y: 2, z: 3 } },
		update: {
			$set: { slotsDone: 1 },
			$push: { scans: { slotIndex: 0, barcode: '12345', rawPayload: null, scannedAt: NOW, x: 1, y: 2, z: 3, attempts: 1 } }
		}
	},
	{
		name: 'a slot error (message capped at 500, attempts kept)',
		body: { sweepRunId: 'sw1', slotError: { slotIndex: 2, message: 'x'.repeat(600), attempts: 3 } },
		update: { $push: { errors: { slotIndex: 2, message: 'x'.repeat(500), recordedAt: NOW, attempts: 3 } } }
	},
	{
		name: 'log lines (≤ 20, level guarded, message capped, slotIndex only when numeric)',
		body: {
			sweepRunId: 'sw1',
			log: [
				{ level: 'warn', message: 'low light', slotIndex: 5 },
				{ level: 'debug', message: 'y'.repeat(700) },
				...Array.from({ length: 25 }, (_, i) => ({ level: 'info', message: `m${i}` }))
			]
		},
		update: {
			$push: {
				log: {
					$each: [
						{ ts: NOW, level: 'warn', message: 'low light', slotIndex: 5 },
						{ ts: NOW, level: 'info', message: 'y'.repeat(500), slotIndex: undefined },
						...Array.from({ length: 18 }, (_, i) => ({ ts: NOW, level: 'info', message: `m${i}`, slotIndex: undefined }))
					]
				}
			}
		}
	},
	{
		name: 'final completed',
		body: { sweepRunId: 'sw1', slotsDone: 12, final: { status: 'completed' } },
		update: { $set: { slotsDone: 12, status: 'completed', completedAt: NOW } }
	},
	{
		name: 'final errored with an abort reason (capped at 500)',
		body: { sweepRunId: 'sw1', final: { status: 'errored', abortReason: 'z'.repeat(800) } },
		update: { $set: { status: 'errored', completedAt: NOW, abortReason: 'z'.repeat(500) } }
	},
	{
		name: 'an unknown final status is ignored; a non-numeric scan slot is ignored',
		body: { sweepRunId: 'sw1', final: { status: 'weird' }, scan: { slotIndex: '1' }, slotError: { message: 'x' } },
		update: null
	}
];

describe('queue-line sweep progress: the update written per daemon body', () => {
	for (const c of CASES) {
		it(c.name, async () => {
			const r = await post(c.body);
			expect(r.status).toBe(200);
			if (c.update === null) {
				expect(updates).toEqual([]);
				expect(reads).toEqual(['sw1']);
			} else {
				expect(updates).toEqual([{ id: 'sw1', update: c.update, opts: { new: true } }]);
				// Key order too (what Mongo receives, byte for byte).
				expect(JSON.stringify(updates[0].update)).toBe(JSON.stringify(c.update));
			}
		});
	}

	it('sweepProgressUpdate (the tailnet jobs route helper) yields the same documents', () => {
		for (const c of CASES) {
			const u = sweepProgressUpdate(c.body, NOW);
			expect(u).toEqual(c.update ?? {});
			expect(JSON.stringify(u)).toBe(JSON.stringify(c.update ?? {}));
		}
	});
});

describe('queue-line sweep progress: control echo + guards (unchanged)', () => {
	it('echoes pause/cancel flags; a cancelled run reads as cancelRequested', async () => {
		run = { pauseRequested: true, cancelRequested: false, status: 'cancelled' };
		const r = await post({ sweepRunId: 'sw1', slotsDone: 1 });
		expect(await r.json()).toEqual({ success: true, pauseRequested: true, cancelRequested: true });
	});

	it('a command that is no longer claimed → 409, nothing written', async () => {
		cmdStatus = 'expired';
		const r = await post({ sweepRunId: 'sw1', slotsDone: 1 });
		expect(r.status).toBe(409);
		expect(await r.json()).toEqual({ success: false, status: 'expired', pauseRequested: false, cancelRequested: true });
		expect(updates).toEqual([]);
	});

	it('missing sweepRunId → 400; unknown command → 404; unknown run → 404', async () => {
		await expect(post({ slotsDone: 1 })).rejects.toMatchObject({ status: 400 });
		cmdStatus = null;
		await expect(post({ sweepRunId: 'sw1' })).rejects.toMatchObject({ status: 404 });
		cmdStatus = 'claimed';
		run = null;
		await expect(post({ sweepRunId: 'sw1', slotsDone: 1 })).rejects.toMatchObject({ status: 404 });
	});
});
