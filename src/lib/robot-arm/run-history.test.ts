import { describe, expect, it } from 'vitest';
import { runActionOf, runHistoryRows, type SentAction } from './run-history';
import { ot2ActionOf } from './ot2-move-log';
import { groupOfKind } from './move-types';

const robot = { _id: 'R3', name: 'Robot 3 B07' };
const since = new Date('2026-11-10T16:00:00Z');
const now = new Date('2026-11-10T17:00:00Z');
const sent = (iso: string, actionType: string, username: string | null = 'Giovanni Victorio'): SentAction => ({ at: new Date(iso), actionType, ok: true, username, from: 'Run' });
const rows = (run: any, s: SentAction[] = [], o: Partial<{ sentSince: Date | null; now: Date; clockOffsetMs: number | null }> = {}) =>
	runHistoryRows({ robot, runId: 'run1', from: 'Run Wax', run, sent: s, sentSince: o.sentSince === undefined ? since : o.sentSince, clockOffsetMs: o.clockOffsetMs ?? null, now: o.now ?? now });

describe('OT-2 run history', () => {
	it('reads the run action BIMS sends', () => {
		expect(runActionOf('/runs/8c2e7ec3-6f70/actions', { data: { actionType: 'stop' } })).toEqual({ runId: '8c2e7ec3-6f70', actionType: 'stop' });
		expect(runActionOf('/runs/x/actions', '{"data":{"actionType":"play"}}')?.actionType).toBe('play');
		expect(runActionOf('/runs/x/commands', {})).toBeNull();
		expect(ot2ActionOf('POST', '/runs/8c2e7ec3-6f70/actions', { data: { actionType: 'stop' } })).toEqual({
			kind: 'run_action_sent',
			line: 'Run Action Sent  Stop  Run 8c2e7ec3',
			runId: '8c2e7ec3-6f70',
			actionType: 'stop'
		});
		expect(ot2ActionOf('GET', '/runs/x/actions', null)).toBeNull();
	});

	it('names each robot action by whether BIMS sent it', () => {
		const h = rows(
			{
				actions: [
					{ id: 'a1', createdAt: '2026-11-10T16:10:01Z', actionType: 'play' },
					{ id: 'a2', createdAt: '2026-11-10T16:20:00Z', actionType: 'stop' }
				]
			},
			[sent('2026-11-10T16:10:00Z', 'play')]
		);
		expect(h.rows.map((r) => r.line)).toEqual(['Run Action  Play  Sent By BIMS (Giovanni Victorio)', 'Run Action  Stop  Not Sent By BIMS']);
		expect(h.rows[0]._id).toBe('ot2act-run1-a1');
		expect(h.deferred).toBe(0);
	});

	it('uses each BIMS send once, and only for the same action type', () => {
		const h = rows(
			{
				actions: [
					{ id: 'a1', createdAt: '2026-11-10T16:10:01Z', actionType: 'play' },
					{ id: 'a2', createdAt: '2026-11-10T16:10:05Z', actionType: 'play' },
					{ id: 'a3', createdAt: '2026-11-10T16:10:06Z', actionType: 'pause' }
				]
			},
			[sent('2026-11-10T16:10:00Z', 'play')]
		);
		expect(h.rows.map((r) => r.line.split('  ')[2])).toEqual(['Sent By BIMS (Giovanni Victorio)', 'Not Sent By BIMS', 'Not Sent By BIMS']);
	});

	it('gives no source to actions from before BIMS logged its sends', () => {
		const h = rows({ actions: [{ id: 'a1', createdAt: '2026-11-09T16:00:00Z', actionType: 'stop' }] }, [], { sentSince: since });
		expect(h.rows[0].line).toBe('Run Action  Stop  Source Not Recorded');
		expect(rows({ actions: [{ id: 'a1', createdAt: '2026-11-10T16:30:00Z', actionType: 'stop' }] }, [], { sentSince: null }).rows[0].line).toContain('Source Not Recorded');
	});

	it('leaves a fresh action for the next sync and says so', () => {
		const h = rows({ actions: [{ id: 'a1', createdAt: '2026-11-10T16:59:55Z', actionType: 'stop' }] });
		expect(h.rows).toHaveLength(0);
		expect(h.deferred).toBe(1);
	});

	it('logs run-level errors, on the arm Pi clock', () => {
		const h = rows({ errors: [{ id: 'e1', createdAt: '2026-11-10T16:40:00.500Z', errorType: 'ProtocolCommandFailedError', errorCode: '4000', detail: 'Pipette not homed' }] }, [], { clockOffsetMs: 500 });
		expect(h.rows[0]).toMatchObject({ kind: 'run_error', ok: false, error: 'Pipette not homed', line: 'Run Error  Protocol Command Failed Error  4000', _id: 'ot2err-run1-e1' });
		expect(h.rows[0].at.toISOString()).toBe('2026-11-10T16:40:00.000Z');
	});

	it('files them under Run Control', () => {
		expect(groupOfKind('ot2', 'run_action')?.title).toBe('Run Control');
		expect(groupOfKind('ot2', 'run_action_sent')?.id).toBe('ot2:run');
		expect(groupOfKind('ot2', 'run_error')?.id).toBe('ot2:run');
	});
});
